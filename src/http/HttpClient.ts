import { redactUrlCredentials } from '../util/RedactUrlCredentials.js';
import {
  DEFAULT_HTTP_CLIENT_MAX_REDIRECTS,
  DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_CLIENT_REDIRECT_MODE,
  DEFAULT_HTTP_CLIENT_TIMEOUT_MS,
  HttpClientOptionsValidator,
} from './HttpClientOptions.js';
import type { HttpClientOptions, HttpClientOptionsType, HttpRedirectMode } from './HttpClientOptions.js';
import type { HttpMethod } from './Types.js';

/**
 * Statuses that redirect when they carry a `Location`.  Wire vocabulary, not
 * a tuned value — this set *is* the redirect half of HTTP/1.1, so it stays
 * beside the loop that reads it.
 */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Headers dropped when a hop crosses origins.
 *
 * The platform does this for free while it is the one following; a hand-rolled
 * loop that re-sends the header record verbatim hands the caller's bearer
 * token to whichever host the previous one nominated — the exact credential
 * leak #625 assumed could not happen.
 */
const CROSS_ORIGIN_STRIPPED_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'proxy-authorization',
];

/** Headers that describe a body, dropped with it when a hop rewrites to GET. */
const BODY_DESCRIBING_HEADERS: readonly string[] = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
];

/** The only schemes a redirect may land on — per the Fetch spec, as the platform enforces. */
const FOLLOWABLE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

export type HttpClientRequest = {
  readonly method: HttpMethod;
  readonly url: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | object | null;
  /**
   * Abort the request after this many milliseconds.  Falls back to the
   * client's `defaultTimeoutMs` (30 s); `0` opts this one call out of any
   * deadline.  The deadline spans the whole redirect chain, not each hop.
   */
  readonly timeoutMs?: number;
  /**
   * Abort the request once the response body passes this many bytes.  Falls
   * back to the client's `maxResponseBytes` (8 MiB) — raise it here for the
   * one call that legitimately downloads more, rather than on the shared
   * client.
   */
  readonly maxResponseBytes?: number;
  /**
   * What to do with a 3xx carrying a `Location`.  Falls back to the client's
   * `redirect` (`'follow'`).
   */
  readonly redirect?: HttpRedirectMode;
  /**
   * Hops a followed chain may take before the call is refused.  Falls back to
   * the client's `maxRedirects` (5); `0` refuses the first redirect.
   */
  readonly maxRedirects?: number;
};

export interface HttpClientResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /**
   * The URL that actually answered — the last hop of a followed chain, which
   * is not necessarily the one that was asked for.  This is the field to
   * assert on when it matters *which host* served the bytes.
   */
  readonly url: string;
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
 * A redirect was refused — by policy (`redirect: 'error'`), by budget
 * (`maxRedirects`), or because the target was not a followable HTTP(S) URL.
 *
 * The refusal happens *before* the next hop is issued, which is the whole
 * point: a check on where a chain ended up has already made every request in
 * it, and the request is itself the side effect worth preventing.
 */
export class HttpRedirectError extends Error {
  constructor(
    message: string,
    /** URL whose response redirected, with any inline credentials masked. */
    readonly url: string,
    /** Redirect target that was refused, as sent, with credentials masked. */
    readonly location: string,
    /** Hops already followed when the refusal happened. */
    readonly hops: number,
  ) {
    super(message);
    this.name = 'HttpRedirectError';
  }
}

/** One hop's request state, rebuilt for each step of a followed chain. */
type RequestHop = {
  readonly method: HttpMethod;
  readonly headers: Record<string, string>;
  readonly body: string | Uint8Array | undefined;
};

/**
 * Thin HTTP client around the global `fetch`.  Returns a uniform response
 * shape with typed helpers (text, json) so callers don't have to deal
 * with two Response APIs.
 *
 * Three limits apply to every call, because all three of the things a remote
 * peer controls were unbounded otherwise — how long it takes to answer
 * (`defaultTimeoutMs`, 30 s), how much it sends (`maxResponseBytes`, 8 MiB),
 * and where it sends the caller next (`redirect` / `maxRedirects`).  Each can
 * be overridden per request; see {@link HttpClientOptions} for the
 * client-wide defaults.
 */
export class HttpClient {
  /** Client-wide fallbacks, defaulted and validated once at construction. */
  private readonly settings: Required<HttpClientOptionsType>;

  constructor(options?: HttpClientOptions) {
    const given = (options ?? {}) as Partial<HttpClientOptionsType>;
    const settings: Required<HttpClientOptionsType> = {
      maxResponseBytes: given.maxResponseBytes ?? DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES,
      defaultTimeoutMs: given.defaultTimeoutMs ?? DEFAULT_HTTP_CLIENT_TIMEOUT_MS,
      redirect: given.redirect ?? DEFAULT_HTTP_CLIENT_REDIRECT_MODE,
      maxRedirects: given.maxRedirects ?? DEFAULT_HTTP_CLIENT_MAX_REDIRECTS,
    };
    // Once, on the merged settings — so the builder, a plain object and the
    // built-in defaults all pass through the same rules.
    new HttpClientOptionsValidator().validate(settings);
    this.settings = settings;
  }

  /**
   * Single request — no connection pool.  fetch handles keep-alive under the
   * hood.
   *
   * Redirects are followed here rather than by the platform (`redirect:
   * 'manual'` on every hop), because everything worth controlling about a
   * redirect happens *between* hops: the hop budget, the credential strip on
   * a cross-origin hop, and the refusal to leave HTTP(S).  The deadline and
   * the byte ceiling stay cumulative across the chain — one `AbortController`
   * for all of it, and only the final body is buffered, since an intermediate
   * 3xx body is cancelled rather than read.
   */
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
      const redirect = request.redirect ?? this.settings.redirect;
      const maxRedirects = request.maxRedirects ?? this.settings.maxRedirects;
      const maxResponseBytes = request.maxResponseBytes ?? this.settings.maxResponseBytes;
      let current = new URL(String(request.url));
      let hop: RequestHop = {
        method: request.method,
        headers: this.normaliseHeaders(request.headers, request.body),
        body: this.serialiseBody(request.body),
      };
      for (let hops = 0; ; hops++) {
        const res = await fetch(current, {
          method: hop.method,
          headers: hop.headers,
          body: hop.body as unknown as BodyInit | null | undefined,
          signal: controller.signal,
          redirect: 'manual',
        });
        const location = res.headers.get('location');
        // A 3xx without a Location is the final answer, exactly as it is for
        // the platform — and so is any non-redirect status.  `'manual'` keeps
        // the 3xx itself, Location and all, for the caller to act on.
        if (location === null || !REDIRECT_STATUSES.has(res.status) || redirect === 'manual') {
          return await this.toClientResponse(res, current, maxResponseBytes, controller);
        }
        // From here the 3xx is never returned, so free its socket rather than
        // leaving the body dangling for the pool to reap.
        await this.discardBody(res);
        const target = this.followTarget(res.status, location, current, redirect, maxRedirects, hops);
        hop = this.nextHop(res.status, current, target, hop);
        current = target;
      }
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
   * Resolve and vet the next hop, or throw {@link HttpRedirectError}.
   *
   * Every rejection here happens before the hop is issued.  A check on where
   * the chain ended up would be no defence at all: by then the internal host
   * has been contacted, and contacting it is the side effect.
   */
  private followTarget(
    status: number,
    location: string,
    current: URL,
    redirect: HttpRedirectMode,
    maxRedirects: number,
    hops: number,
  ): URL {
    const from = redactUrlCredentials(current.toString());
    const to = redactUrlCredentials(location);
    if (redirect === 'error') {
      throw new HttpRedirectError(
        `${from} answered ${status} redirecting to ${to}, and redirect is 'error'.`,
        from, to, hops,
      );
    }
    if (hops >= maxRedirects) {
      throw new HttpRedirectError(
        `${from} answered ${status} redirecting to ${to}, past maxRedirects=${maxRedirects}.`,
        from, to, hops,
      );
    }
    let target: URL;
    try {
      target = new URL(location, current);
    } catch {
      throw new HttpRedirectError(
        `${from} answered ${status} with an unparseable Location: ${to}`,
        from, to, hops,
      );
    }
    // The platform refuses a non-HTTP(S) redirect target; a hand-rolled loop
    // that does not would let one hostile response turn an API call into a
    // `file:` read on a runtime whose fetch speaks that scheme.
    if (!FOLLOWABLE_SCHEMES.has(target.protocol)) {
      throw new HttpRedirectError(
        `${from} answered ${status} redirecting to a non-HTTP(S) target: ${to}`,
        from, to, hops,
      );
    }
    return target;
  }

  /**
   * The request state for the next hop, per the Fetch spec's redirect rules:
   * a cross-origin hop loses the credential headers, and 303 (plus 301/302
   * after a POST) continues as a GET with the body and its headers dropped.
   *
   * Getting the method rewrite wrong is not cosmetic — it either replays a
   * write against a second host or silently turns one into a read.
   */
  private nextHop(status: number, from: URL, to: URL, hop: RequestHop): RequestHop {
    const headers = { ...hop.headers };
    if (to.origin !== from.origin) {
      for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) delete headers[name];
    }
    const rewriteToGet = status === 303
      ? hop.method !== 'GET' && hop.method !== 'HEAD'
      : (status === 301 || status === 302) && hop.method === 'POST';
    if (!rewriteToGet) return { method: hop.method, headers, body: hop.body };
    for (const name of BODY_DESCRIBING_HEADERS) delete headers[name];
    return { method: 'GET', headers, body: undefined };
  }

  /** Buffer the body under the cap and wrap it in the uniform response shape. */
  private async toClientResponse(
    response: Response,
    url: URL,
    maxResponseBytes: number,
    controller: AbortController,
  ): Promise<HttpClientResponse> {
    const buffer = await this.readCappedBody(response, url, maxResponseBytes, controller);
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => { outHeaders[k.toLowerCase()] = v; });
    const answeredBy = url.toString();
    return {
      status: response.status,
      headers: outHeaders,
      body: buffer,
      url: answeredBy,
      text(): string { return new TextDecoder().decode(buffer); },
      json<T = unknown>(): T { return JSON.parse(new TextDecoder().decode(buffer)) as T; },
    };
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

  /** Release an intermediate 3xx body; a failure here is never the caller's problem. */
  private async discardBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      /* already closed, or a runtime that released it on its own */
    }
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
