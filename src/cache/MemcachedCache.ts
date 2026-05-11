import { Lazy } from '../util/Lazy.js';
import { none, some, type Option } from '../util/Option.js';
import { CacheError, type Cache } from './Cache.js';

/**
 * Memcached-backed `Cache` — wraps `memjs` (pure-JS memcached client,
 * tiny, well-maintained).  Useful for shops with existing memcached
 * infrastructure; in greenfield setups Redis is the better default
 * (richer primitives, better cluster story).
 *
 * Wire format:
 *   - Values are JSON-stringified before send and parsed on receive.
 *   - TTLs are passed as seconds (memcached's native unit) — the
 *     interface uses milliseconds, we round up to the nearest second
 *     internally with a 1s minimum.
 *   - `incr` uses memcached's atomic INCR with a CAS-based create
 *     fallback for the first-key-write (memcached's `incr` doesn't
 *     auto-create like Redis does).
 *   - `setIfAbsent` maps to memcached's `add` operation.
 *
 * Failure model matches `RedisCache`: `get`/`set`/`delete` swallow
 * transient errors; `incr` and `setIfAbsent` propagate so callers can
 * detect lost atomicity.
 */

export interface MemcachedCacheOptions {
  /** Comma-separated server list, e.g. `'localhost:11211'`.  Default: `'localhost:11211'`. */
  readonly servers?: string;
  /** Optional username/password for SASL auth. */
  readonly username?: string;
  readonly password?: string;
  /** Optional key prefix (server-side, applied to every operation). */
  readonly keyPrefix?: string;
  /** Pre-built memjs client — bypass internal construction. */
  readonly client?: MemcachedClientLike;
}

/** Subset of `memjs.Client` we use.  memjs uses Buffer; we always pass strings. */
export interface MemcachedClientLike {
  get(key: string): Promise<{ value: Buffer | null; flags?: Buffer | null }>;
  set(key: string, value: string | Buffer, opts?: { expires?: number }): Promise<boolean>;
  add(key: string, value: string | Buffer, opts?: { expires?: number }): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  increment(key: string, amount: number, opts?: { initial?: number; expires?: number }): Promise<{ value: number | null }>;
  quit(): Promise<void>;
}

export class MemcachedCache implements Cache {
  private readonly clientLazy: Lazy<Promise<MemcachedClientLike>>;
  private readonly keyPrefix: string;
  private closed = false;

  constructor(opts: MemcachedCacheOptions = {}) {
    this.keyPrefix = opts.keyPrefix ?? '';
    this.clientLazy = Lazy.of(async () => {
      if (opts.client) return opts.client;
      const memjs = await memjsLazy.get();
      const Client = (memjs as { Client?: MemjsClientStatic }).Client
        ?? (memjs as unknown as MemjsClientStatic);
      return Client.create(opts.servers ?? 'localhost:11211', {
        username: opts.username,
        password: opts.password,
      }) as unknown as MemcachedClientLike;
    });
  }

  async get<V>(key: string): Promise<Option<V>> {
    if (this.closed) return none;
    // Validate BEFORE the try/catch so protocol-injection attempts
    // surface to the caller as a CacheError, rather than being
    // silently swallowed as a "cache miss".
    assertSafeMemcachedKey(key);
    try {
      const client = await this.clientLazy.get();
      const { value } = await client.get(this.k(key));
      if (!value) return none;
      return some(JSON.parse(value.toString('utf8')) as V);
    } catch {
      return none;
    }
  }

  async set<V>(key: string, value: V, ttlMs?: number): Promise<void> {
    if (this.closed) return;
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new CacheError(`MemcachedCache.set: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    assertSafeMemcachedKey(key);
    const expires = msToSeconds(ttlMs);
    try {
      const client = await this.clientLazy.get();
      await client.set(this.k(key), JSON.stringify(value), expires === undefined ? undefined : { expires });
    } catch {
      // Lost write is acceptable for a cache.
    }
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    if (this.closed) throw new CacheError('MemcachedCache.incr: cache is closed');
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new CacheError(`MemcachedCache.incr: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    const client = await this.clientLazy.get();
    const expires = msToSeconds(ttlMs);
    try {
      // memjs `increment` with `initial` auto-creates the counter on
      // first call — matches Redis INCR semantics.  TTL only applies
      // on the create path (memcached's native behaviour).
      const { value } = await client.increment(this.k(key), 1, {
        initial: 1,
        expires,
      });
      if (value === null) {
        throw new CacheError(`MemcachedCache.incr: server returned null for key '${key}'`);
      }
      return value;
    } catch (e) {
      if (e instanceof CacheError) throw e;
      throw new CacheError(`MemcachedCache.incr failed for key '${key}'`, e);
    }
  }

  async setIfAbsent<V>(key: string, value: V, ttlMs?: number): Promise<boolean> {
    if (this.closed) throw new CacheError('MemcachedCache.setIfAbsent: cache is closed');
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new CacheError(`MemcachedCache.setIfAbsent: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    const expires = msToSeconds(ttlMs);
    try {
      const client = await this.clientLazy.get();
      // memjs `add` returns true if stored, false if the key already exists.
      return await client.add(this.k(key), JSON.stringify(value),
        expires === undefined ? undefined : { expires });
    } catch (e) {
      throw new CacheError(`MemcachedCache.setIfAbsent failed for key '${key}'`, e);
    }
  }

  async delete(...keys: string[]): Promise<void> {
    if (this.closed || keys.length === 0) return;
    // Validate every key up-front; one bad key fails the whole call.
    for (const k of keys) assertSafeMemcachedKey(k);
    try {
      const client = await this.clientLazy.get();
      // memjs has no multi-delete — issue them in parallel.
      await Promise.all(keys.map((k) => client.delete(this.k(k)).catch(() => false)));
    } catch {
      // ignore
    }
  }

  async mget<V>(keys: ReadonlyArray<string>): Promise<Map<string, V>> {
    const out = new Map<string, V>();
    if (this.closed || keys.length === 0) return out;
    for (const k of keys) assertSafeMemcachedKey(k);
    try {
      const client = await this.clientLazy.get();
      // memjs has no native MGET — issue in parallel and rebuild the
      // result Map.  We lose Redis's "preserves request order"
      // guarantee, but the contract documents the order as backend-
      // dependent for that reason.
      const results = await Promise.all(
        keys.map(async (k): Promise<V | null> => {
          try {
            const { value } = await client.get(this.k(k));
            if (!value) return null;
            try { return JSON.parse(value.toString('utf8')) as V; } catch { return null; }
          } catch { return null; }
        }),
      );
      for (let i = 0; i < keys.length; i++) {
        const v = results[i];
        if (v !== null && v !== undefined) out.set(keys[i]!, v);
      }
    } catch {
      // ignore
    }
    return out;
  }

  async mset<V>(entries: ReadonlyMap<string, V>, ttlMs?: number): Promise<void> {
    if (this.closed || entries.size === 0) return;
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new CacheError(`MemcachedCache.mset: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    for (const k of entries.keys()) assertSafeMemcachedKey(k);
    const expires = msToSeconds(ttlMs);
    try {
      const client = await this.clientLazy.get();
      await Promise.all(
        Array.from(entries).map(([k, v]) =>
          client.set(
            this.k(k),
            JSON.stringify(v),
            expires === undefined ? undefined : { expires },
          ).catch(() => false),
        ),
      );
    } catch {
      // ignore
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.clientLazy.isEvaluated) return;
    try {
      const client = await this.clientLazy.get();
      await client.quit();
    } catch { /* ignore */ }
  }

  private k(key: string): string {
    assertSafeMemcachedKey(key);
    return this.keyPrefix ? `${this.keyPrefix}${key}` : key;
  }
}

/**
 * Reject memcached keys that contain whitespace, control characters,
 * NUL bytes, or are over the protocol's 250-byte limit.
 *
 * **Exploit walkthrough (pre-fix).**  Memcached's text protocol uses
 * whitespace (space, `\r`, `\n`, `\t`) as command delimiters.  Some
 * memcached clients pass user-supplied keys straight onto the wire;
 * a key like `'a\r\nFLUSHALL\r\n'` becomes two protocol lines once
 * concatenated with the rest of the SET frame:
 *
 *   set <keyPrefix>a
 *   FLUSHALL
 *   ...
 *
 * The server interprets the second line as a real `FLUSHALL`,
 * wiping the cache.  Even a server that ignores unknown commands
 * leaks information: the response to the injected line lands in the
 * pipeline reader, desynchronising every subsequent request.
 *
 * The framework's `Cache` interface accepts user-supplied keys
 * (often derived from request paths or actor pids), so the
 * sanitisation lives here.
 */
export function assertSafeMemcachedKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new CacheError(`memcached key must be a non-empty string`);
  }
  if (key.length > 250) {
    throw new CacheError(`memcached key exceeds 250-byte limit (got ${key.length})`);
  }
  // Reject all ASCII control chars (0x00–0x1F, 0x7F) plus space (0x20).
  // The memcached text protocol uses whitespace as command delimiter;
  // any of these in a key would let an attacker inject protocol commands.
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c <= 0x20 || c === 0x7F) {
      throw new CacheError(
        `memcached key contains control character or whitespace at index ${i} ` +
        `(charCode=${c}) — would allow protocol injection`,
      );
    }
  }
}

/* ---------------------------- internals --------------------------------- */

function msToSeconds(ttlMs: number | undefined): number | undefined {
  if (ttlMs === undefined) return undefined;
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

interface MemjsClientStatic {
  create(servers: string, opts?: { username?: string; password?: string }): MemcachedClientLike;
}

const memjsLazy: Lazy<Promise<unknown>> = Lazy.of(async () => {
  try {
    const name = 'memjs';
    return await import(name);
  } catch (e) {
    throw new CacheError(
      'MemcachedCache requires the "memjs" package.  Install it with: npm install memjs',
      e,
    );
  }
});
