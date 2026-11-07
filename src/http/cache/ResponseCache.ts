import type { Cache } from '../../cache/Cache.js';
import type { HttpRequest, HttpResponse } from '../Types.js';

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
 *     cache: ext.cache('response-cache'),
 *     ttlMs: 30_000,
 *     key: (request) => `users:${request.params.id}`,
 *     identity: (request) => jwtClaimsOf(request)?.sub ?? 'anonymous',
 *   });
 *   withMiddleware(JwtAuth(jwtOptions),
 *     path('users', path(':id', get(userCache(request => askUserActor(request.params.id))))));
 *
 * **Security — what may be shared (#980).**  A hit returns before the
 * wrapped handler runs, so any check *inside* the handler — authentication,
 * authorization, a per-caller lookup — runs for the first caller only.
 * Authorization therefore has to wrap `cached(...)`, never sit inside it.
 * Beyond that the wrapper refuses, on its own, every case in which one
 * caller's response can reach another:
 *
 *   - only `GET` is stored, and only `GET`/`HEAD` are answered from the
 *     cache — any other method goes straight to the handler;
 *   - a request carrying credentials (`Authorization`, `Proxy-Authorization`,
 *     `Cookie`) bypasses the cache entirely unless {@link
 *     ResponseCacheOptions.identity} is configured, which folds a per-caller
 *     scope into the key and is the explicit opt-in;
 *   - a response is not stored when it carries `Set-Cookie`, a
 *     `Cache-Control` of `no-store`, `no-cache` or `private`, `Vary: *`, or
 *     a streaming body;
 *   - a response carrying `Vary` is stored together with the request's
 *     values of the named headers, and served only to a request whose values
 *     match — any other request is a miss.
 *
 * The same rules govern stampede protection: a request waiting on another
 * request's in-flight handler takes that response only when it could have
 * taken it from the cache, and otherwise runs the handler itself.
 *
 * **Security — give this middleware its own cache (security audit
 * HTTP-8):** `key(request)` almost always derives from something the
 * client controls (a path parameter, a tenant header), so a caller who
 * varies it mints a new cache entry per request.  That is harmless here
 * — `InMemoryCache`'s LRU bound is what keeps the response cache from
 * growing without limit — and since #1080 it is survivable in a shared
 * `Cache` too, because every entry this middleware writes is a plain
 * `set` and eviction drains those before it touches a rate-limit counter
 * or a record that stops a payment being taken twice.  Do not lean on
 * that: this middleware's entries are the only slack a shared map has,
 * the `maxEntries` bound is still hard once they run out, and a remote
 * backend (Memcached, or Redis under `maxmemory-policy allkeys-lru`)
 * evicts server-side where no such policy reaches.  This middleware is
 * the key-minting side of the trade, so hand it a dedicated instance
 * (`ext.cache('response-cache')`) rather than the one enforcing a
 * security guarantee — or, where one instance has to be shared, give the
 * instance a `prefixQuotas` reservation for this middleware's
 * {@link ResponseCacheOptions.keyPrefix} (#607), which bounds the flood
 * to that share whatever else the map is holding.
 */

export type ResponseCacheOptions = {
  /** Backing cache. */
  readonly cache: Cache;
  /** TTL on stored responses (milliseconds).  Required — no TTL invites unbounded growth. */
  readonly ttlMs: number;
  /** Identity function — derives the cache key from the request. */
  readonly key: (request: HttpRequest) => string | Promise<string>;
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
  /**
   * Per-caller scope folded into the cache key, so a cached response is
   * only ever replayed to the caller it was produced for — the counterpart
   * of `idempotent()`'s option of the same name.
   *
   * Configuring it is also the opt-in for caching requests that carry
   * credentials (`Authorization`, `Proxy-Authorization`, `Cookie`): without
   * it they bypass the cache, because nothing else in the key says whose
   * response it is.  Derive the scope from what a middleware **verified**
   * (`jwtClaimsOf(request)?.sub`), never from a raw header the client could
   * set to someone else's id.  For an endpoint whose response genuinely does
   * not depend on the caller, `() => 'public'` says exactly that.
   *
   * The scope is URI-encoded into the key (`<keyPrefix><scope>:<key>`), so a
   * scope containing `:` cannot collide with a differently split one.
   */
  readonly identity?: (request: HttpRequest) => string | Promise<string>;
};

type CachedResponse = {
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** JSON-serialisable body.  Uint8Array is base64-tagged. */
  readonly body: unknown;
  readonly contentType?: string;
  /**
   * The request headers the response's `Vary` named, with the values the
   * storing request carried (`null` for an absent header).  A hit is served
   * only when the new request carries the same values.
   */
  readonly vary?: ReadonlyArray<VariedHeader>;
};

type VariedHeader = {
  readonly name: string;
  readonly value: string | null;
};

/** The outcome of one handler run, as the requests waiting on it see it. */
type FlightResult = {
  readonly response: HttpResponse;
  /** The shareable form of `response`, or `null` when it may not be shared. */
  readonly entry: CachedResponse | null;
};

/** Methods whose response is safe to replay.  `HEAD` reads but never stores — see `cachedHandler`. */
const CACHEABLE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** Request headers that say who is asking. */
const CREDENTIAL_HEADERS: ReadonlyArray<string> = ['authorization', 'proxy-authorization', 'cookie'];

/** `Cache-Control` response directives that forbid a shared cache from storing it. */
const UNSHAREABLE_DIRECTIVES: ReadonlySet<string> = new Set(['no-store', 'no-cache', 'private']);

export function cached(options: ResponseCacheOptions) {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error(`cached: ttlMs must be a positive finite number, got ${options.ttlMs}`);
  }
  const prefix = options.keyPrefix ?? 'rsp:';
  const cacheStatuses = new Set(options.cacheStatuses ?? [200]);
  const identity = options.identity;
  // Per-process single-flight map.  Lifetime: the time it takes the
  // wrapped handler to run for one key.  Cleaned up in finally.
  const inflight = new Map<string, Promise<FlightResult>>();

  return function wrap(handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse) {
    return async function cachedHandler(request: HttpRequest): Promise<HttpResponse> {
      if (!CACHEABLE_METHODS.has(request.method)) return handler(request);
      // Without an identity nothing in the key says whose response it is,
      // so a credentialed request must neither read nor feed the cache.
      if (identity === undefined && carriesCredentials(request)) return handler(request);

      const userKey = await options.key(request);
      const cacheKey = identity === undefined
        ? `${prefix}${userKey}`
        : `${prefix}${encodeURIComponent(await identity(request))}:${userKey}`;

      // 1. Cache hit?  The entry is re-checked against today's rules, so an
      // entry stored before them (a shared Redis outlives a deploy) is
      // never served either.
      const hit = await options.cache.get<CachedResponse>(cacheKey);
      if (hit.isSome() && servable(hit.value, request)) {
        return decodeResponse(hit.value);
      }

      // `HEAD` is answered from a `GET` entry but never stores one: a
      // handler may well answer it without a body (static files do), and
      // that entry would then be served to the next `GET`.
      if (request.method === 'HEAD') return handler(request);

      // 2. Miss — but is another request already running this key?  Its
      // response is ours only if the cache could have handed it to us.
      const existingFlight = inflight.get(cacheKey);
      if (existingFlight) {
        const flight = await existingFlight;
        if (flight.entry !== null && varyMatches(flight.entry, request)) return flight.response;
        return handler(request);
      }

      // 3. We're the leader for this key.  Run the handler, then cache
      // the result if it may be shared.
      const work = (async (): Promise<FlightResult> => {
        const response = await handler(request);
        const entry = cacheStatuses.has(response.status) ? shareableEntry(response, request) : null;
        if (entry !== null) {
          await options.cache.set<CachedResponse>(cacheKey, entry, options.ttlMs);
        }
        return { response, entry };
      })();
      inflight.set(cacheKey, work);
      try { return (await work).response; }
      finally { inflight.delete(cacheKey); }
    };
  };
}

/* ------------------------------ internals -------------------------------- */

/**
 * The form of `r` that may be stored and replayed to other callers, or
 * `null` when it must reach only the caller it was produced for.
 */
function shareableEntry(r: HttpResponse, request: HttpRequest): CachedResponse | null {
  if (r.body instanceof ReadableStream) return null;
  if (!headersShareable(r.headers)) return null;
  const varied = varyNames(r.headers);
  let body: unknown = r.body;
  if (body instanceof Uint8Array) {
    body = { __bin: bytesToBase64(body) };
  }
  return {
    status: r.status,
    headers: r.headers as Record<string, string> | undefined,
    body,
    contentType: r.contentType,
    ...(varied.length > 0
      ? { vary: varied.map((name) => ({ name, value: headerValue(request.headers, name) ?? null })) }
      : {}),
  };
}

/** Whether a stored entry may answer `request`. */
function servable(entry: CachedResponse, request: HttpRequest): boolean {
  return headersShareable(entry.headers) && varyMatches(entry, request);
}

/**
 * The response-header half of the sharing rules: no `Set-Cookie` (there is
 * no correct way to hand one caller's cookie to another), no `Cache-Control`
 * directive that keeps the response out of a shared cache, no `Vary: *`.
 */
function headersShareable(headers: Readonly<Record<string, string>> | undefined): boolean {
  if (headers === undefined) return true;
  if (headerValue(headers, 'set-cookie') !== undefined) return false;
  const cacheControl = headerValue(headers, 'cache-control');
  if (cacheControl !== undefined) {
    for (const directive of cacheControl.split(',')) {
      const name = directive.split('=', 1)[0]!.trim().toLowerCase();
      if (UNSHAREABLE_DIRECTIVES.has(name)) return false;
    }
  }
  return !varyNames(headers).includes('*');
}

/** The lower-cased header names a response's `Vary` lists. */
function varyNames(headers: Readonly<Record<string, string>> | undefined): string[] {
  const vary = headers === undefined ? undefined : headerValue(headers, 'vary');
  if (vary === undefined) return [];
  return vary.split(',').map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0);
}

/** Whether `request` carries the values of every header the entry varies on. */
function varyMatches(entry: CachedResponse, request: HttpRequest): boolean {
  if (entry.vary === undefined) return true;
  return entry.vary.every(({ name, value }) => (headerValue(request.headers, name) ?? null) === value);
}

function carriesCredentials(request: HttpRequest): boolean {
  return CREDENTIAL_HEADERS.some((name) => headerValue(request.headers, name) !== undefined);
}

/**
 * Case-insensitive header read.  Backends hand requests over lower-cased,
 * but response headers are whatever the handler wrote (`'Set-Cookie'`), and
 * a rule that misses one spelling is a rule an ordinary handler walks past.
 */
function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
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
  let binaryString = '';
  for (let i = 0; i < bytes.length; i++) binaryString += String.fromCharCode(bytes[i]!);
  return btoa(binaryString);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
