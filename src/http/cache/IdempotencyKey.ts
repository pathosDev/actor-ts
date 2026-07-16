import { complete } from '../Route.js';
import { type HttpRequest, type HttpResponse, Status } from '../types.js';
import {
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
 *   const deduplication = idempotent({ cache: ext.cache(), ttlMs: 24 * 60 * 60_000 });
 *   route(post('/payments', deduplication(handler)));
 */

interface CachedResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** JSON-serialisable shape — Uint8Array bodies are base64-encoded as `{__bin: '...'}`. */
  readonly body: unknown;
  readonly contentType?: string;
  /**
   * SHA-256 hash (base64) of the ORIGINAL request body that produced
   * this cached response.  Re-checked on every replay: if the new
   * request's body hash doesn't match, the client tried to reuse the
   * same idempotency key for a SEMANTICALLY DIFFERENT request — we
   * reject with 422 rather than returning the wrong response.
   * Stripe's spec calls this out explicitly; without it, a malicious
   * (or buggy) client that reuses an idempotency key can poison the
   * cache to receive someone else's response.
   */
  readonly requestFingerprint: string;
}

const IN_FLIGHT_MARKER: { readonly inFlight: true } = { inFlight: true } as const;

export function idempotent(options: IdempotencyOptions) {
  const resolvedOptions = options as IdempotencyOptionsType;
  new IdempotencyOptionsValidator().validate(resolvedOptions);
  const ttlMs = resolvedOptions.ttlMs ?? 24 * 60 * 60_000;
  const header = (resolvedOptions.headerName ?? 'idempotency-key').toLowerCase();
  const prefix = resolvedOptions.keyPrefix ?? 'idem:';
  const missing = resolvedOptions.missingHeader ?? 'reject';
  const identity = resolvedOptions.identity;

  return function wrap(handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse) {
    return async function deduplicated(request: HttpRequest): Promise<HttpResponse> {
      const userKey = request.headers[header];
      if (!userKey) {
        if (missing === 'pass-through') return handler(request);
        return complete(Status.BadRequest, {
          error: `missing required '${header}' header`,
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
        // Security: same idempotency key + DIFFERENT body = client
        // tried to reuse a key for a semantically-different request.
        // Stripe's spec says reject with 422.  Returning the cached
        // (unrelated) response would let an attacker poison the
        // cache with a key they guessed/observed and steal another
        // client's response.
        if (value.requestFingerprint !== fingerprint) {
          return complete(Status.UnprocessableEntity, {
            error: 'idempotency-key already used with a different request body',
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
 * Compute a stable fingerprint of the request body + method + path
 * for the idempotency-key duplicate-body check.  SHA-256 base64
 * — fast (sub-ms for typical payloads), collision-resistant, and
 * the base64 form is JSON-safe for storage in the cache.
 *
 * We include `method + path` so even a body-less GET can be
 * fingerprinted, and a same-body POST/PUT mix doesn't collide.
 */
async function computeRequestFingerprint(request: HttpRequest): Promise<string> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  const prelude = new TextEncoder().encode(`${request.method} ${request.path}\n`);
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
