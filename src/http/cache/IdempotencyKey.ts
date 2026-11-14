import type { Cache } from '../../cache/Cache.js';
import { acquireLock, type CacheLock } from '../../cache/CacheLock.js';
import { complete } from '../Route.js';
import { type HttpRequest, type HttpResponse, Status } from '../Types.js';
import {
  DEFAULT_IDEMPOTENCY_HANDLER_ERROR_POLICY,
  DEFAULT_IDEMPOTENCY_LOCK_TTL_MS,
  DEFAULT_IDEMPOTENCY_MAX_KEY_LENGTH,
  DEFAULT_IDEMPOTENCY_MAX_SCOPE_LENGTH,
  DEFAULT_IDEMPOTENCY_TTL_MS,
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
 * States for a given key:
 *   1. **Absent** — the request claims the key and the handler runs.
 *   2. **In-flight** — another request holds the claim.  We respond
 *      `409 Conflict` so the client retries later.  The claim lives for
 *      `lockTtlMs` (default 60 s), not for the response TTL, so a worker
 *      that dies mid-handler wedges the key for a minute rather than a
 *      day (#984).
 *   3. **Completed** — replay the recorded response verbatim, for `ttlMs`
 *      (default 24 h).  Only statuses in `cacheStatuses` are recorded —
 *      by default everything but 5xx, 408 and 429, so a transient failure
 *      releases the key instead of being pinned.
 *   4. **Failed** — the handler threw.  Under `onHandlerError: 'retain'`
 *      (the default) that is recorded too, and replayed as a 500 that
 *      tells the client to reconcile and use a new key: the middleware
 *      cannot know how much of the handler ran, and running a partially
 *      applied handler again is the double charge idempotency exists to
 *      prevent.
 *
 * **The claim is token-checked (#1082).**  It is taken with
 * {@link acquireLock}, so the key holds a random token rather than a
 * shared marker, and every later write — the record, the failure, the
 * release — happens only while that token is still the one under the key.
 * A handler that overran its claim, while a retry took the key after the
 * lapse, therefore neither stores its response over the retry's claim nor
 * deletes it: the late response still goes to its own caller, and the key
 * stays with the retry.  The check is a `get` and then a write, like
 * `CacheLock.release` — see that method for the residual window.
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
 * (10 000 entries by default), and its eviction now asks two questions
 * before recency: which key prefix the entry belongs to (#607) and
 * whether it carries a guarantee (#1080).  The claim this middleware
 * writes with `setIfAbsent` and the record that replaces it both carry
 * one, so a flood minted through `cached` cannot reach a stored response;
 * and a shared instance configured with `prefixQuotas` confines a flood
 * of rate-limit counters to the `rl:` reservation, so it cannot reach one
 * either.  Two things still do:
 *
 *   - **Without a quota**, an instance shared with `rateLimit` has no
 *     ranking between two guarantee-carrying consumers: once the map
 *     holds nothing cheaper, a counter flood takes records.  Configure
 *     `prefixQuotas` on a shared instance, or do not share it.
 *   - **This middleware's OWN key space is attacker-controlled**, and no
 *     quota fixes that — attacker and victim both write under `idem:`,
 *     so they share whatever reservation is drawn around it.  A flood of
 *     distinct `Idempotency-Key`s evicts other callers' records out of a
 *     dedicated instance just as it does out of a shared one.
 *     {@link IdempotencyOptionsType.maxKeyLength} and
 *     {@link IdempotencyOptionsType.maxScopeLength} bound how big each
 *     minted key is — between them they bound the whole composed key —
 *     but neither bounds how many of them there are.
 *
 * A record is also only moved to the most-recently-used end when it is
 * READ — a claimed-but-not-yet-answered key is never bumped at all,
 * because `setIfAbsent` does not count as a use — so it is the first
 * thing dropped within its own half once a cap is reached.
 *
 * So hand this middleware a cache nothing else writes to —
 * `ext.cache('idempotency')` resolves a separate named instance — and
 * size that cache's `maxEntries` for the number of in-flight keys you
 * expect times the TTL, under `actor-ts.cache.idempotency.in-memory`
 * (#607: that per-name block is what makes the advice reachable; before
 * it, every named instance shared the one global bound).  Where one
 * instance genuinely has to be shared, reserve this middleware's share of
 * it with `prefixQuotas` instead.  Neither removes the last exposure:
 * where the guarantee has to hold under an adversary who chooses the
 * keys, back it with Redis rather than an in-process LRU.
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

/**
 * The in-flight marker written before #1082, when every claim held the same
 * value.  Still recognised as a claim on read, so a rolling deploy that
 * mixes old and new instances over one cache keeps answering 409 for an
 * old instance's in-flight key instead of trying to replay it.
 */
type LegacyInFlightMarker = { readonly inFlight: true };

/** A claim, as {@link acquireLock} writes it: the holder's random token. */
type ClaimToken = string;

type StoredEntry = CachedResponse | ClaimToken | LegacyInFlightMarker;

/**
 * Body of the 500 replayed for a key whose handler threw under
 * `onHandlerError: 'retain'`.  Says what the client can still do, because
 * the one thing it must not do — retry with the same key and expect the
 * handler to run — is exactly what it will try first.
 */
const HANDLER_FAILED_BODY = {
  error: 'an earlier request with this idempotency-key failed after it may have applied side effects; '
    + 'it is not run again — reconcile, then retry with a new key',
} as const;

export function idempotent(options: IdempotencyOptions) {
  const resolvedOptions = options as IdempotencyOptionsType;
  new IdempotencyOptionsValidator().validate(resolvedOptions);
  const cache = resolvedOptions.cache;
  const ttlMs = resolvedOptions.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const lockTtlMs = resolvedOptions.lockTtlMs ?? DEFAULT_IDEMPOTENCY_LOCK_TTL_MS;
  const onHandlerError = resolvedOptions.onHandlerError ?? DEFAULT_IDEMPOTENCY_HANDLER_ERROR_POLICY;
  const recordable = statusFilter(resolvedOptions.cacheStatuses);
  const header = (resolvedOptions.headerName ?? 'idempotency-key').toLowerCase();
  const prefix = resolvedOptions.keyPrefix ?? 'idem:';
  const missing = resolvedOptions.missingHeader ?? 'reject';
  const identity = resolvedOptions.identity;
  const maxKeyLength = resolvedOptions.maxKeyLength ?? DEFAULT_IDEMPOTENCY_MAX_KEY_LENGTH;
  const maxScopeLength = resolvedOptions.maxScopeLength ?? DEFAULT_IDEMPOTENCY_MAX_SCOPE_LENGTH;

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
      // is configured — identical key space to before, and an empty string
      // passes both rules, so the check below costs that case nothing.
      const scope = identity ? await identity(request) : '';
      // The scope is the OTHER half of the key, and it reaches the cache from
      // the same place the header does — `identity`'s own recipe reads a raw
      // client header.  Checking only the header left a 255-character cap
      // over one half of a key whose other half was unbounded (#607).
      const scopeRejection = keyRejectionReason(scope, maxScopeLength);
      if (scopeRejection !== undefined) {
        return complete(Status.BadRequest, {
          error: `invalid caller scope: ${scopeRejection}`,
        });
      }
      const cacheKey = `${prefix}${scope}${scope ? ':' : ''}${userKey}`;
      const fingerprint = await computeRequestFingerprint(request);

      // Probe — if the key already holds a completed response, replay.
      const existing = await cache.get<StoredEntry>(cacheKey);
      if (existing.isSome()) {
        const value = existing.value;
        if (isClaim(value)) {
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

      // Try to claim the key — `setIfAbsent` underneath, so if somebody
      // else got there a microsecond ago we answer as for any in-flight
      // key.  The claim lives for `lockTtlMs`, not `ttlMs` (#984), and holds
      // a token only this request knows (#1082).
      const claim = await acquireLock(cache, cacheKey, lockTtlMs);
      if (claim.isNone()) {
        return complete(Status.Conflict, {
          error: 'idempotency-key in-flight; retry shortly',
        });
      }
      const lock = claim.value;

      let response: HttpResponse;
      try {
        response = await handler(request);
      } catch (e) {
        // The handler may have applied side effects before it threw, and
        // nothing here can tell how many.  `retain` records the failure so a
        // retry is not a second execution; `release` frees the key, for a
        // handler that is known to be all-or-nothing.  Either only while the
        // claim is still ours — after a lapse the key belongs to a retry.
        if (onHandlerError === 'release') await lock.release();
        else await replaceIfStillHeld(cache, lock, failedRecord(fingerprint), ttlMs);
        throw e;
      }
      if (recordable(response.status)) {
        // Replace our claim with the response, remembering the request
        // fingerprint so a replay can verify it is the same request.  When
        // the claim has lapsed and a retry holds the key, this response is
        // still this caller's answer — it is just not the key's record.
        await replaceIfStillHeld(cache, lock, encodeResponse(response, fingerprint), ttlMs);
      } else {
        // A transient failure the handler reported itself (5xx, 408, 429 by
        // default): it decided the request may be retried, so free the key.
        await lock.release();
      }
      return response;
    };
  };
}

/**
 * Write `value` under the lock's key, but only while the lock's token is
 * still the entry there.  `false` when it is not — the claim lapsed or was
 * evicted, and whatever is under the key now is somebody else's.
 *
 * The same `get`-then-write shape as `CacheLock.release`, with the same
 * narrow residual window between the two; the `Cache` surface has no
 * compare-and-set, and Memcached could not provide one.
 */
async function replaceIfStillHeld(cache: Cache, lock: CacheLock, value: CachedResponse, ttlMs: number): Promise<boolean> {
  const held = await cache.get<StoredEntry>(lock.key);
  if (held.toNullable() !== lock.token) return false;
  await cache.set<CachedResponse>(lock.key, value, ttlMs);
  return true;
}

/** The record a thrown handler leaves under `onHandlerError: 'retain'`. */
function failedRecord(requestFingerprint: string): CachedResponse {
  return encodeResponse(complete(Status.InternalServerError, HANDLER_FAILED_BODY), requestFingerprint);
}

/**
 * Which response statuses are recorded.  An explicit `cacheStatuses` list
 * decides alone; unset, everything is recorded except the statuses that
 * mean "not now" — any 5xx, 408 Request Timeout and 429 Too Many Requests
 * (#984).
 */
function statusFilter(cacheStatuses: ReadonlyArray<number> | undefined): (status: number) => boolean {
  if (cacheStatuses !== undefined) {
    const listed = new Set(cacheStatuses);
    return (status) => listed.has(status);
  }
  // 408 Request Timeout has no `Status` constant.
  return (status) => status < 500 && status !== 408 && status !== Status.TooManyRequests;
}

/* ------------------------------ internals -------------------------------- */

/**
 * Why `value` may not go into a cache key, or `undefined` when it may.
 *
 * Applied to **both** parts the key is composed from — the client's
 * `Idempotency-Key` header and the `identity` scope — because both are
 * concatenated into the same string and the weaker of the two is what an
 * attacker aims at.  Two independent rules, both about what an attacker
 * gets to put into a cache that other requests depend on:
 *
 *   - **Length.** The value is concatenated verbatim into the cache key,
 *     so an unbounded value means an unbounded key.  The cap turns "how
 *     much cache does one minted key cost" from a client decision into a
 *     server one.
 *   - **Charset.** ASCII control characters and the space are command
 *     delimiters in Memcached's text protocol — the same reason
 *     `makeKeyValidator`'s memcached rule set refuses them — and CR/LF
 *     are the classic header-injection pair.  Rejecting them here means
 *     the guarantee does not depend on which `Cache` implementation
 *     happens to be wired in behind the middleware.
 *
 * An empty value passes both, which is what keeps the unscoped
 * configuration (no `identity`) unaffected.
 *
 * The reason never echoes the value back, only where and what went wrong:
 * this string is returned to the caller, and reflecting attacker bytes
 * into a response body is how a rejection message becomes a payload.
 */
function keyRejectionReason(value: string, maxLength: number): string | undefined {
  if (value.length > maxLength) {
    return `exceeds the ${maxLength}-character limit (got ${value.length})`;
  }
  for (let i = 0; i < value.length; i++) {
    const charCode = value.charCodeAt(i);
    if (charCode <= 0x20 || charCode === 0x7F) {
      return `contains a control character or space at index ${i} (charCode=${charCode})`;
    }
  }
  return undefined;
}

/**
 * Whether a stored entry is a claim on an in-flight key rather than a
 * record: a lock token (a string — a record is always an object), or the
 * shared marker an instance from before #1082 writes.
 */
function isClaim(value: StoredEntry): value is ClaimToken | LegacyInFlightMarker {
  if (typeof value === 'string') return true;
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
