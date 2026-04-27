import type { Cache } from '../../cache/Cache.js';
import { complete } from '../Route.js';
import { type HttpRequest, type HttpResponse, Status } from '../types.js';

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
 *   const dedup = idempotent({ cache: ext.cache(), ttlMs: 24 * 60 * 60_000 });
 *   route(post('/payments', dedup(handler)));
 */

export interface IdempotencyOptions {
  readonly cache: Cache;
  /** How long to remember responses.  Default: 24 hours. */
  readonly ttlMs?: number;
  /**
   * Header to read the idempotency key from.  Default: `'idempotency-key'`
   * (the standard).  Header names are matched case-insensitively against
   * the `req.headers` map (which holds them lower-cased).
   */
  readonly headerName?: string;
  /**
   * Cache-key namespace.  Default: `'idem:'`.
   */
  readonly keyPrefix?: string;
  /**
   * What to do when the request lacks the header.  Default: `'reject'`
   * (respond 400).  Setting `'pass-through'` runs the handler unchanged
   * — useful when only some clients use idempotency and you don't want
   * to break the others.
   */
  readonly missingHeader?: 'reject' | 'pass-through';
}

interface CachedResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** JSON-serialisable shape — Uint8Array bodies are base64-encoded as `{__bin: '...'}`. */
  readonly body: unknown;
  readonly contentType?: string;
}

const IN_FLIGHT_MARKER: { readonly inFlight: true } = { inFlight: true } as const;

export function idempotent(opts: IdempotencyOptions) {
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60_000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`idempotent: ttlMs must be a positive finite number, got ${ttlMs}`);
  }
  const header = (opts.headerName ?? 'idempotency-key').toLowerCase();
  const prefix = opts.keyPrefix ?? 'idem:';
  const missing = opts.missingHeader ?? 'reject';

  return function wrap(handler: (req: HttpRequest) => Promise<HttpResponse> | HttpResponse) {
    return async function deduped(req: HttpRequest): Promise<HttpResponse> {
      const userKey = req.headers[header];
      if (!userKey) {
        if (missing === 'pass-through') return handler(req);
        return complete(Status.BadRequest, {
          error: `missing required '${header}' header`,
        });
      }
      const cacheKey = `${prefix}${userKey}`;

      // Probe — if the key already holds a completed response, replay.
      const existing = await opts.cache.get<CachedResponse | typeof IN_FLIGHT_MARKER>(cacheKey);
      if (existing.isSome()) {
        const value = existing.value;
        if (isInFlight(value)) {
          return complete(Status.Conflict, {
            error: 'idempotency-key in-flight; retry shortly',
          });
        }
        return decodeResponse(value);
      }

      // Try to claim the key.  `setIfAbsent` is the kernel — if it
      // returns false, somebody else got there a microsecond ago, fall
      // back to the same in-flight response.
      const claimed = await opts.cache.setIfAbsent(cacheKey, IN_FLIGHT_MARKER, ttlMs);
      if (!claimed) {
        return complete(Status.Conflict, {
          error: 'idempotency-key in-flight; retry shortly',
        });
      }

      let response: HttpResponse;
      try {
        response = await handler(req);
      } catch (e) {
        // On error, drop our in-flight claim so the client can retry.
        await opts.cache.delete(cacheKey);
        throw e;
      }
      // Replace the in-flight marker with the actual response.
      await opts.cache.set<CachedResponse>(cacheKey, encodeResponse(response), ttlMs);
      return response;
    };
  };
}

/* ------------------------------ internals -------------------------------- */

function isInFlight(value: unknown): value is typeof IN_FLIGHT_MARKER {
  return typeof value === 'object' && value !== null && (value as { inFlight?: boolean }).inFlight === true;
}

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
  // Bun, Node 16+, and Deno all expose `Buffer`; keeping this simple.
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
