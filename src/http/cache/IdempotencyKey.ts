import { complete } from '../Route.js';
import { type HttpRequest, type HttpResponse, Status } from '../Types.js';
import {
  DEFAULT_IDEMPOTENCY_MAX_KEY_LENGTH,
  IdempotencyOptionsValidator,
  type IdempotencyOptions,
  type IdempotencyOptionsType,
} from './IdempotencyOptions.js';

/**
 * Idempotency-key middleware.  Implements the Stripe / Adyen pattern:
 * clients send an `Idempotency-Key` header on retryable requests
 * (typically POST), and the server records the first response under
 * that key so subsequent requests with the same key replay the same
 * outcome.
 *
 * Three states for a given key:
 *   1. **Absent** — handler runs; the (status, headers, body) tuple is
 *      cached under the key for `ttlMs` (default 24h).
 *   2. **In-flight** — another worker is currently processing this key.
 *      We respond `409 Conflict` so the client retries later.
 *   3. **Completed** — replay the cached response verbatim.
 *
 * Storage is JSON-encoded — bodies that are `Uint8Array` are base64'd
 * so the round-trip preserves bytes.
 *
 * Usage:
 *
 *   const deduplication = idempotent({ cache: ext.cache('idempotency'), ttlMs: 24 * 60 * 60_000 });
 *   route(post('/payments', deduplication(handler)));
 *
 * **Security — give this middleware its own cache (security audit
 * HTTP-8).**  The `Idempotency-Key` header is attacker-chosen, so every
 * request can mint a new cache key.  `InMemoryCache` is LRU-bounded
 * (10 000 entries by default), and since #1080 its eviction takes entries
 * that carry no guarantee first — the claim this middleware writes with
 * `setIfAbsent` and the record that replaces it both count as one, so a
 * flood minted through `cached` no longer reaches a stored response.
 * Three things still do:
 *
 *   - The policy does not rank guarantees against each other.  On an
 *     instance shared with `rateLimit`, a flood of counters evicts
 *     records anyway, because once the map holds nothing cheaper there is
 *     nothing cheaper to drop.
 *   - This middleware's OWN key space is attacker-controlled, so a flood
 *     of distinct `Idempotency-Key`s evicts other callers' records out of
 *     the same instance.  {@link IdempotencyOptionsType.maxKeyLength}
 *     bounds how big each minted key is, not how many of them there are.
 *   - A record is only moved to the most-recently-used end when it is
 *     READ — a claimed-but-not-yet-answered key is never bumped at all,
 *     because `setIfAbsent` does not count as a use — so it is the first
 *     thing dropped once the cap is reached.
 *
 * So hand this middleware a cache nothing else writes to —
 * `ext.cache('idempotency')` resolves a separate named instance — and
 * size that cache's `maxEntries` for the number of in-flight keys you
 * expect times the TTL, under `actor-ts.cache.idempotency.in-memory`
 * (#607: that per-name block is what makes the advice reachable; before
 * it, every named instance shared the one global bound).  Naming a
 * separate cache narrows the blast radius; it does not remove it.  Where
 * the guarantee has to hold under an adversary, back it with Redis
 * rather than an in-process LRU.
 */

type CachedResponse = {
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** JSON-serialisable shape — Uint8Array bodies are base64-encoded as `{__bin: '...'}`. */
  readonly body: unknown;
  readonly contentType?: string;
  /**
   * SHA-256 hash (base64) of the ORIGINAL request — method, path,
   * canonical query and body — that produced this cached response.
   * Re-checked on every replay: if the new request's hash doesn't
   * match, the client tried to reuse the same idempotency key for a
   * SEMANTICALLY DIFFERENT request — we reject with 422 rather than
   * returning the wrong response.  Stripe's spec calls this out
   * explicitly; without it, a malicious (or buggy) client that reuses
   * an idempotency key can poison the cache to receive someone else's
   * response.
   */
  readonly requestFingerprint: string;
};

const IN_FLIGHT_MARKER: { readonly inFlight: true } = { inFlight: true } as const;

export function idempotent(options: IdempotencyOptions) {
  const resolvedOptions = options as IdempotencyOptionsType;
  new IdempotencyOptionsValidator().validate(resolvedOptions);
  const ttlMs = resolvedOptions.ttlMs ?? 24 * 60 * 60_000;
  const header = (resolvedOptions.headerName ?? 'idempotency-key').toLowerCase();
  const prefix = resolvedOptions.keyPrefix ?? 'idem:';
  const missing = resolvedOptions.missingHeader ?? 'reject';
  const identity = resolvedOptions.identity;
  const maxKeyLength = resolvedOptions.maxKeyLength ?? DEFAULT_IDEMPOTENCY_MAX_KEY_LENGTH;

  return function wrap(handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse) {
    return async function deduplicated(request: HttpRequest): Promise<HttpResponse> {
      const userKey = request.headers[header];
      if (!userKey) {
        if (missing === 'pass-through') return handler(request);
        return complete(Status.BadRequest, {
          error: `missing required '${header}' header`,
        });
      }
      const rejection = keyRejectionReason(userKey, maxKeyLength);
      if (rejection !== undefined) {
        return complete(Status.BadRequest, {
          error: `invalid '${header}' header: ${rejection}`,
        });
      }
      // Fold the caller scope into the key so a cached response can't be
      // replayed to a different caller (HTTP-4).  Empty when no `identity`
      // is configured — identical key space to before.
      const scope = identity ? await identity(request) : '';
      const cacheKey = `${prefix}${scope}${scope ? ':' : ''}${userKey}`;
      const fingerprint = await computeRequestFingerprint(request);

      // Probe — if the key already holds a completed response, replay.
      const existing = await resolvedOptions.cache.get<CachedResponse | typeof IN_FLIGHT_MARKER>(cacheKey);
      if (existing.isSome()) {
        const value = existing.value;
        if (isInFlight(value)) {
          return complete(Status.Conflict, {
            error: 'idempotency-key in-flight; retry shortly',
          });
        }
        // Security: same idempotency key + DIFFERENT method, path,
        // query or body = client tried to reuse a key for a
        // semantically-different request.  Stripe's spec says reject
        // with 422.  Returning the cached (unrelated) response would
        // let an attacker poison the cache with a key they
        // guessed/observed and steal another client's response.
        if (value.requestFingerprint !== fingerprint) {
          return complete(Status.UnprocessableEntity, {
            error: 'idempotency-key already used with a different request',
          });
        }
        return decodeResponse(value);
      }

      // Try to claim the key.  `setIfAbsent` is the kernel — if it
      // returns false, somebody else got there a microsecond ago, fall
      // back to the same in-flight response.
      const claimed = await resolvedOptions.cache.setIfAbsent(cacheKey, IN_FLIGHT_MARKER, ttlMs);
      if (!claimed) {
        return complete(Status.Conflict, {
          error: 'idempotency-key in-flight; retry shortly',
        });
      }

      let response: HttpResponse;
      try {
        response = await handler(request);
      } catch (e) {
        // On error, drop our in-flight claim so the client can retry.
        await resolvedOptions.cache.delete(cacheKey);
        throw e;
      }
      // Replace the in-flight marker with the actual response,
      // remembering the request fingerprint so subsequent replays
      // can verify the request body matches.
      await resolvedOptions.cache.set<CachedResponse>(cacheKey, encodeResponse(response, fingerprint), ttlMs);
      return response;
    };
  };
}

/* ------------------------------ internals -------------------------------- */

/**
 * Why the client-supplied `Idempotency-Key` is unacceptable, or
 * `undefined` when it may become a cache key.
 *
 * Two independent rules, both about what an attacker gets to put into a
 * cache that other requests depend on:
 *
 *   - **Length.** The header value is concatenated verbatim into the
 *     cache key, so an unbounded header means an unbounded key.  The cap
 *     turns "how much cache does one minted key cost" from a client
 *     decision into a server one.
 *   - **Charset.** ASCII control characters and the space are command
 *     delimiters in Memcached's text protocol — the same reason
 *     `makeKeyValidator`'s memcached rule set refuses them — and CR/LF
 *     are the classic header-injection pair.  Rejecting them here means
 *     the guarantee does not depend on which `Cache` implementation
 *     happens to be wired in behind the middleware.
 *
 * The reason never echoes the key back, only where and what went wrong:
 * this string is returned to the caller, and reflecting attacker bytes
 * into a response body is how a rejection message becomes a payload.
 */
function keyRejectionReason(userKey: string, maxKeyLength: number): string | undefined {
  if (userKey.length > maxKeyLength) {
    return `exceeds the ${maxKeyLength}-character limit (got ${userKey.length})`;
  }
  for (let i = 0; i < userKey.length; i++) {
    const charCode = userKey.charCodeAt(i);
    if (charCode <= 0x20 || charCode === 0x7F) {
      return `contains a control character or space at index ${i} (charCode=${charCode})`;
    }
  }
  return undefined;
}

function isInFlight(value: unknown): value is typeof IN_FLIGHT_MARKER {
  return typeof value === 'object' && value !== null && (value as { inFlight?: boolean }).inFlight === true;
}

function encodeResponse(response: HttpResponse, requestFingerprint: string): CachedResponse {
  let body: unknown = response.body;
  if (body instanceof Uint8Array) {
    body = { __bin: bytesToBase64(body) };
  }
  return {
    status: response.status,
    headers: response.headers as Record<string, string> | undefined,
    body,
    contentType: response.contentType,
    requestFingerprint,
  };
}

/**
 * Canonical serialisation of `request.query` for the fingerprint.
 *
 * Keys are **sorted**, so a retry that happens to reorder parameters
 * (`?a=1&b=2` vs `?b=2&a=1`) fingerprints identically — parameter order
 * carries no meaning in a URL, and 422-ing an honest retry breaks
 * idempotency in exactly the direction it is supposed to protect.  The
 * values of a *repeated* key keep their **original order**, because
 * `?tag=a&tag=b` and `?tag=b&tag=a` are different inputs to any API
 * that reads the list positionally — sorting them would silently widen
 * the guard.  `URLSearchParams` normalises percent-encoding on the way
 * out, so two spellings of the same value collapse to one form.
 *
 * This choice is deliberate and easy to "tidy" into a total sort by
 * mistake; keep the note if the code moves.
 */
function canonicalQuery(query: HttpRequest['query']): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const single of value) params.append(key, single);
    else params.append(key, value);
  }
  return params.toString();
}

/**
 * `path` with any query fragment removed.
 *
 * `HttpRequest.path` is contractually the bare pathname, but a backend
 * that hands over the raw request target instead would otherwise fold
 * the query into the fingerprint twice — once verbatim inside `path`,
 * once canonically — and so compute a different fingerprint from a peer
 * pod running a different backend against the same shared cache.
 * Normalising here keeps the fingerprint a property of the request, not
 * of the server that received it.
 */
function pathWithoutQuery(path: string): string {
  const queryStart = path.indexOf('?');
  return queryStart === -1 ? path : path.slice(0, queryStart);
}

/**
 * Compute a stable fingerprint of the request body + method + path +
 * query for the idempotency-key duplicate-request check.  SHA-256
 * base64 — fast (sub-ms for typical payloads), collision-resistant, and
 * the base64 form is JSON-safe for storage in the cache.
 *
 * We include `method + path` so even a body-less GET can be
 * fingerprinted, and a same-body POST/PUT mix doesn't collide.  The
 * query belongs in there for the same reason: `POST /refunds?amount=1`
 * and `POST /refunds?amount=9999` are different requests even with an
 * identical body, and without the query the second one replays the
 * first one's response instead of being rejected with 422.
 */
async function computeRequestFingerprint(request: HttpRequest): Promise<string> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  const query = canonicalQuery(request.query);
  const target = `${pathWithoutQuery(request.path)}${query ? `?${query}` : ''}`;
  const prelude = new TextEncoder().encode(`${request.method} ${target}\n`);
  const body = request.body ?? new Uint8Array(0);
  const combined = new Uint8Array(prelude.byteLength + body.byteLength);
  combined.set(prelude, 0);
  combined.set(body, prelude.byteLength);

  if (subtle) {
    // Cast through BufferSource — TS 5.7+'s DOM types tighten the
    // `BufferSource` constraint in a way that doesn't match
    // `Uint8Array<ArrayBufferLike>` cleanly.
    const digest = await subtle.digest('SHA-256', combined as unknown as BufferSource);
    return bytesToBase64(new Uint8Array(digest));
  }
  // Fallback: FNV-1a 64-bit hex.  Slower convergence than SHA-256
  // but still ~ 2^32 collision resistance for the fingerprint.  Only
  // reached on exotic runtimes without WebCrypto, which we already
  // refuse to run encryption on.
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xcbf29ce4 >>> 0;
  for (let i = 0; i < combined.length; i++) {
    h1 = Math.imul(h1 ^ combined[i]!, 16777619);
    h2 = Math.imul(h2 ^ combined[i]!, 2246822519);
  }
  return `fnv:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

function decodeResponse(cached: CachedResponse): HttpResponse {
  let body: HttpResponse['body'] = cached.body as HttpResponse['body'];
  if (typeof cached.body === 'object' && cached.body !== null && '__bin' in (cached.body as object)) {
    body = base64ToBytes((cached.body as { __bin: string }).__bin);
  }
  return {
    status: cached.status,
    headers: cached.headers,
    body,
    contentType: cached.contentType,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  // Bun, Node 16+, and Deno all expose `Buffer`; keeping this simple.
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
