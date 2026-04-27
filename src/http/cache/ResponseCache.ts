import type { Cache } from '../../cache/Cache.js';
import type { HttpRequest, HttpResponse } from '../types.js';

/**
 * HTTP response-cache directive.  Wraps a handler with a read-through
 * cache: on hit, the cached response is returned without invoking the
 * inner handler; on miss, the handler runs and its response (if its
 * status code is in `cacheStatuses`) is stored under the user's key.
 *
 * **Stampede protection:** when many requests hit the same cache-miss
 * concurrently, only one runs the handler; the rest await its result
 * via an in-process `Map<key, Promise<HttpResponse>>`.  This is
 * **per-process** — cluster-wide single-flight is explicitly out of
 * scope (the complexity-to-value ratio is poor for a cache layer).
 *
 * Invalidation is the caller's responsibility: write handlers should
 * `cache.delete(key)` on mutate.  We deliberately avoid auto-magic
 * (tags, patterns) because those are the source of most stale-cache
 * production bugs.
 *
 * Usage:
 *
 *   const userCache = cached({
 *     cache: ext.cache(),
 *     ttlMs: 30_000,
 *     key: (req) => `users:${req.params.id}`,
 *   });
 *   route(get('/users/:id', userCache(req => askUserActor(req.params.id))));
 */

export interface ResponseCacheOptions {
  /** Backing cache. */
  readonly cache: Cache;
  /** TTL on stored responses (milliseconds).  Required — no TTL invites unbounded growth. */
  readonly ttlMs: number;
  /** Identity function — derives the cache key from the request. */
  readonly key: (req: HttpRequest) => string | Promise<string>;
  /**
   * Cache-key namespace prepended to the user key.  Default `'rsp:'` so
   * multiple response-caches in one Redis don't collide.
   */
  readonly keyPrefix?: string;
  /**
   * Status codes whose responses are cacheable.  Default `[200]` — only
   * 2xx are cached.  Pass `[200, 404]` if you want to cache "not found"
   * responses (saves repeat lookups when callers query unknown ids).
   */
  readonly cacheStatuses?: ReadonlyArray<number>;
}

interface CachedResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** JSON-serialisable body.  Uint8Array is base64-tagged. */
  readonly body: unknown;
  readonly contentType?: string;
}

export function cached(opts: ResponseCacheOptions) {
  if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
    throw new Error(`cached: ttlMs must be a positive finite number, got ${opts.ttlMs}`);
  }
  const prefix = opts.keyPrefix ?? 'rsp:';
  const cacheStatuses = new Set(opts.cacheStatuses ?? [200]);
  // Per-process single-flight map.  Lifetime: the time it takes the
  // wrapped handler to run for one key.  Cleaned up in finally.
  const inflight = new Map<string, Promise<HttpResponse>>();

  return function wrap(handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse) {
    return async function cachedHandler(req: HttpRequest): Promise<HttpResponse> {
      const userKey = await opts.key(req);
      const cacheKey = `${prefix}${userKey}`;

      // 1. Cache hit?
      const hit = await opts.cache.get<CachedResponse>(cacheKey);
      if (hit.isSome()) {
        return decodeResponse(hit.value);
      }

      // 2. Miss — but is another request already running this key?
      const existingFlight = inflight.get(cacheKey);
      if (existingFlight) return existingFlight;

      // 3. We're the leader for this key.  Run the handler, then cache
      // the result if its status is cacheable.
      const work = (async (): Promise<HttpResponse> => {
        const response = await handler(req);
        if (cacheStatuses.has(response.status)) {
          await opts.cache.set<CachedResponse>(cacheKey, encodeResponse(response), opts.ttlMs);
        }
        return response;
      })();
      inflight.set(cacheKey, work);
      try { return await work; }
      finally { inflight.delete(cacheKey); }
    };
  };
}

/* ------------------------------ internals -------------------------------- */

function encodeResponse(r: HttpResponse): CachedResponse {
  let body: unknown = r.body;
  if (body instanceof Uint8Array) {
    body = { __bin: bytesToBase64(body) };
  }
  return {
    status: r.status,
    headers: r.headers as Record<string, string> | undefined,
    body,
    contentType: r.contentType,
  };
}

function decodeResponse(c: CachedResponse): HttpResponse {
  let body: HttpResponse['body'] = c.body as HttpResponse['body'];
  if (typeof c.body === 'object' && c.body !== null && '__bin' in (c.body as object)) {
    body = base64ToBytes((c.body as { __bin: string }).__bin);
  }
  return {
    status: c.status,
    headers: c.headers,
    body,
    contentType: c.contentType,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
