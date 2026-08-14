import { redactUrlCredentials } from '../util/RedactUrlCredentials.js';
import {
  DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_CLIENT_TIMEOUT_MS,
  HttpClientOptionsValidator,
} from './HttpClientOptions.js';
import type { HttpClientOptions, HttpClientOptionsType } from './HttpClientOptions.js';
import type { HttpMethod } from './types.js';

export type HttpClientRequest = {
  readonly method: HttpMethod;
  readonly url: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | object | null;
  /**
   * Abort the request after this many milliseconds.  Falls back to the
   * client's `defaultTimeoutMs` (30 s); `0` opts this one call out of any
   * deadline.
   */
  readonly timeoutMs?: number;
  /**
   * Abort the request once the response body passes this many bytes.  Falls
   * back to the client's `maxResponseBytes` (8 MiB) — raise it here for the
   * one call that legitimately downloads more, rather than on the shared
   * client.
   */
  readonly maxResponseBytes?: number;
};

export interface HttpClientResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** Decode body as UTF-8 text. */
  text(): string;
  /** Decode body as JSON. */
  json<T = unknown>(): T;
}

/**
 * A response body grew past the effective `maxResponseBytes` and the request
 * was torn down.
 *
 * A distinct class rather than `HttpError`: this is a *client* failure, and an
 * `HttpError` thrown inside a route handler is mapped straight into the status
 * that handler answers with — so reusing it would turn "the API we called sent
 * too much" into "this server replies 413", blaming the wrong party.  The
 * bound travels with the error because the number is the actionable part: it
 * tells the caller which knob to raise.
 */
export class HttpResponseTooLargeError extends Error {
  constructor(
    /** Request URL, with any inline credentials masked. */
    readonly url: string,
    /** Bound that was exceeded, in bytes. */
    readonly maxResponseBytes: number,
  ) {
    super(
      `HTTP response body from ${url} exceeded maxResponseBytes=${maxResponseBytes} `
      + '— raise it on the request or on the HttpClient, or stream the endpoint yourself.',
    );
    this.name = 'HttpResponseTooLargeError';
  }
}

/**
 * Thin HTTP client around the global `fetch`.  Returns a uniform response
 * shape with typed helpers (text, json) so callers don't have to deal
 * with two Response APIs.
 *
 * Two limits apply to every call, because both of the things a remote peer
 * controls — how long it takes to answer and how much it sends — are
 * unbounded otherwise: a deadline (`defaultTimeoutMs`, 30 s) and a body
 * ceiling (`maxResponseBytes`, 8 MiB).  Either can be overridden per request;
 * see {@link HttpClientOptions} for the client-wide defaults.
 */
export class HttpClient {
  /** Client-wide fallbacks, defaulted and validated once at construction. */
  private readonly settings: Required<HttpClientOptionsType>;

  constructor(options?: HttpClientOptions) {
    const given = (options ?? {}) as Partial<HttpClientOptionsType>;
    const settings: Required<HttpClientOptionsType> = {
      maxResponseBytes: given.maxResponseBytes ?? DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES,
      defaultTimeoutMs: given.defaultTimeoutMs ?? DEFAULT_HTTP_CLIENT_TIMEOUT_MS,
    };
    // Once, on the merged settings — so the builder, a plain object and the
    // built-in defaults all pass through the same rules.
    new HttpClientOptionsValidator().validate(settings);
    this.settings = settings;
  }

  /** Single request — no connection pool.  fetch handles keep-alive under the hood. */
  async singleRequest(request: HttpClientRequest): Promise<HttpClientResponse> {
    const controller = new AbortController();
    // `?? default` rather than `||`, so an explicit 0 still means "no
    // deadline" and does not silently reinstate the fallback.
    const timeoutMs = request.timeoutMs ?? this.settings.defaultTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    }
    try {
      const body = this.serialiseBody(request.body);
      const headers = this.normaliseHeaders(request.headers, request.body);
      const res = await fetch(request.url, {
        method: request.method,
        headers,
        body: body as unknown as BodyInit | null | undefined,
        signal: controller.signal,
      });
      const buffer = await this.readCappedBody(
        res,
        request.url,
        request.maxResponseBytes ?? this.settings.maxResponseBytes,
        controller,
      );
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { outHeaders[k.toLowerCase()] = v; });
      return {
        status: res.status,
        headers: outHeaders,
        body: buffer,
        text(): string { return new TextDecoder().decode(buffer); },
        json<T = unknown>(): T { return JSON.parse(new TextDecoder().decode(buffer)) as T; },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  get(url: string | URL, init?: Omit<HttpClientRequest, 'method' | 'url'>): Promise<HttpClientResponse> {
    return this.singleRequest({ method: 'GET', url, ...init });
  }
  post(url: string | URL, init?: Omit<HttpClientRequest, 'method' | 'url'>): Promise<HttpClientResponse> {
    return this.singleRequest({ method: 'POST', url, ...init });
  }
  put(url: string | URL, init?: Omit<HttpClientRequest, 'method' | 'url'>): Promise<HttpClientResponse> {
    return this.singleRequest({ method: 'PUT', url, ...init });
  }
  delete(url: string | URL, init?: Omit<HttpClientRequest, 'method' | 'url'>): Promise<HttpClientResponse> {
    return this.singleRequest({ method: 'DELETE', url, ...init });
  }

  /**
   * Buffer the response body, refusing it the moment it passes `maxBytes`.
   *
   * Read chunk by chunk rather than via `res.arrayBuffer()`, which is the
   * whole point: `arrayBuffer()` allocates whatever arrives before anyone can
   * object, so a cap checked on its result is a cap enforced after the damage.
   * Here the running total is checked against the bound before the next chunk
   * is kept, so the peak allocation is the bound plus one chunk.
   *
   * Exceeding it aborts the controller instead of merely returning: the rest
   * of the body is already in flight, and only tearing the connection down
   * stops it from arriving (and from holding a socket open while it does).
   *
   * A `null` body is not an error — 204, 304 and every HEAD response have no
   * stream at all, which `arrayBuffer()` used to paper over.
   */
  private async readCappedBody(
    response: Response,
    url: string | URL,
    maxBytes: number,
    controller: AbortController,
  ): Promise<Uint8Array> {
    const stream = response.body;
    if (stream === null) return new Uint8Array(0);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new HttpResponseTooLargeError(redactUrlCredentials(String(url)), maxBytes);
      }
      chunks.push(chunk.value);
    }
    if (chunks.length === 1) return chunks[0]!;
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const part of chunks) {
      buffer.set(part, offset);
      offset += part.byteLength;
    }
    return buffer;
  }

  private serialiseBody(body: HttpClientRequest['body']): string | Uint8Array | undefined {
    if (body === undefined || body === null) return undefined;
    if (typeof body === 'string') return body;
    if (body instanceof Uint8Array) return body;
    return JSON.stringify(body);
  }

  private normaliseHeaders(
    headers: Readonly<Record<string, string>> | undefined,
    body: HttpClientRequest['body'],
  ): Record<string, string> {
    const out: Record<string, string> = {};
    if (headers) for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
    if (body && typeof body !== 'string' && !(body instanceof Uint8Array) && !out['content-type']) {
      out['content-type'] = 'application/json; charset=utf-8';
    }
    return out;
  }
}
