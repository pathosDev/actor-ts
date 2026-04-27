import type { HttpMethod } from './types.js';

export interface HttpClientRequest {
  readonly method: HttpMethod;
  readonly url: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | object | null;
  /** Abort the request after this many milliseconds. */
  readonly timeoutMs?: number;
}

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
 * Thin HTTP client around the global `fetch`.  Returns a uniform response
 * shape with typed helpers (text, json) so callers don't have to deal
 * with two Response APIs.
 */
export class HttpClient {
  /** Single request — no connection pool.  fetch handles keep-alive under the hood. */
  async singleRequest(req: HttpClientRequest): Promise<HttpClientResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (req.timeoutMs && req.timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), req.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    }
    try {
      const body = this.serialiseBody(req.body);
      const headers = this.normaliseHeaders(req.headers, req.body);
      const res = await fetch(req.url, {
        method: req.method,
        headers,
        body: body as unknown as BodyInit | null | undefined,
        signal: controller.signal,
      });
      const buffer = new Uint8Array(await res.arrayBuffer());
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
