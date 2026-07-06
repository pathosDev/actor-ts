import { Lazy } from '../util/Lazy.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { none, some, type Option } from '../util/Option.js';
import { wrapError } from '../util/WrapError.js';
import { CacheError, type Cache } from './Cache.js';

/**
 * Redis-backed `Cache` — wraps `ioredis`.  We pick ioredis over the
 * official `redis` client because it's better typed, supports Redis
 * Cluster out of the box, and is the de-facto choice in the Node
 * ecosystem.  `ioredis` is a **lazy optional peer dependency**: it's
 * imported on first cache operation, so users who don't reach for the
 * Redis backend pay nothing.
 *
 * Values are JSON-serialized on set, JSON-parsed on get.  This matches
 * 95% of cache use-cases (config, response bodies, counters).  Binary
 * payloads or other formats need a custom Cache implementation —
 * deliberately out of scope for v1.
 *
 * Connection failures **do not throw** from `get` — they return None.
 * The caller's recovery path (re-fetch from source-of-truth) is the
 * right behaviour for a cache miss.  `set` and `delete` swallow
 * transient errors too, since lost cache writes are tolerable by
 * definition.  `incr` and `setIfAbsent` *do* throw because the caller
 * relies on their atomic semantics for correctness (rate-limit,
 * idempotency-key).
 */

export interface RedisCacheSettings {
  /**
   * Redis URL (e.g. `redis://localhost:6379`) — passed straight to the
   * ioredis constructor.  Mutually exclusive with `host`/`port`.
   */
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly password?: string;
  readonly db?: number;
  /**
   * Optional key prefix prepended to every key.  Useful when a single
   * Redis instance is shared by multiple actor systems / environments.
   */
  readonly keyPrefix?: string;
  /**
   * Pre-built ioredis client — bypass internal construction (advanced
   * usage: connection sharing, custom retry strategies, Redis Cluster).
   */
  readonly client?: RedisClientLike;
}

/**
 * Fluent builder for {@link RedisCacheSettings}:
 *
 *     new RedisCache(RedisCacheOptions.create().withUrl('redis://localhost:6379').withKeyPrefix('app:'))
 */
export class RedisCacheOptions extends OptionsBuilder<RedisCacheSettings> {
  /** Start a fresh builder.  Equivalent to `new RedisCacheOptions()`. */
  static create(): RedisCacheOptions {
    return new RedisCacheOptions();
  }

  /** Redis URL (e.g. `redis://localhost:6379`).  Mutually exclusive with `host`/`port`. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Redis host — used with `withPort` when no `withUrl` is given. */
  withHost(host: string): this {
    return this.set('host', host);
  }

  /** Redis port — used with `withHost` when no `withUrl` is given. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Redis password (AUTH). */
  withPassword(password: string): this {
    return this.set('password', password);
  }

  /** Redis logical database index. */
  withDb(db: number): this {
    return this.set('db', db);
  }

  /** Key prefix prepended to every key — isolates shared instances by system/env. */
  withKeyPrefix(prefix: string): this {
    return this.set('keyPrefix', prefix);
  }

  /** Pre-built ioredis client — bypass internal construction (connection sharing, Cluster). */
  withClient(client: RedisClientLike): this {
    return this.set('client', client);
  }
}

/**
 * Minimal subset of the ioredis client surface we depend on.  Defined
 * here so a custom client (mock, wrapper, Cluster) can satisfy the
 * contract without pulling in the full ioredis types.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  set(key: string, value: string, mode: 'PX', ttlMs: number, flag: 'NX'): Promise<string | null>;
  set(key: string, value: string, flag: 'NX'): Promise<string | null>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
  del(...keys: string[]): Promise<number>;
  /** Bulk get — returns one entry per key in order, `null` for misses. */
  mget(...keys: string[]): Promise<Array<string | null>>;
  /** Bulk set — variadic `key1, value1, key2, value2, …`.  No per-key TTL. */
  mset(...keyValuePairs: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

export class RedisCache implements Cache {
  private readonly clientLazy: Lazy<Promise<RedisClientLike>>;
  private readonly keyPrefix: string;
  private closed = false;

  constructor(options: RedisCacheOptions = RedisCacheOptions.create()) {
    const opts = options.build();
    this.keyPrefix = opts.keyPrefix ?? '';
    this.clientLazy = Lazy.of(async () => {
      if (opts.client) return opts.client;
      const ioredis = await ioredisLazy.get();
      // ioredis.default is the constructor when imported from ESM consumers.
      const Ctor = (ioredis as { default?: RedisCtor }).default ?? (ioredis as unknown as RedisCtor);
      if (opts.url) return new Ctor(opts.url) as RedisClientLike;
      return new Ctor({
        host: opts.host,
        port: opts.port,
        password: opts.password,
        db: opts.db,
      }) as RedisClientLike;
    });
  }

  async get<V>(key: string): Promise<Option<V>> {
    if (this.closed) return none;
    try {
      const client = await this.clientLazy.get();
      const raw = await client.get(this.k(key));
      if (raw === null) return none;
      return some(JSON.parse(raw) as V);
    } catch {
      // Cache miss on transient failures — caller will fall back to source.
      return none;
    }
  }

  async set<V>(key: string, value: V, ttlMs?: number): Promise<void> {
    if (this.closed) return;
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new CacheError(`RedisCache.set: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    const payload = JSON.stringify(value);
    try {
      const client = await this.clientLazy.get();
      if (ttlMs === undefined) await client.set(this.k(key), payload);
      else await client.set(this.k(key), payload, 'PX', ttlMs);
    } catch {
      // Lost write is acceptable for a cache.
    }
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    if (this.closed) throw new CacheError('RedisCache.incr: cache is closed');
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new CacheError(`RedisCache.incr: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    const client = await this.clientLazy.get();
    const k = this.k(key);
    let next: number;
    try { next = await client.incr(k); }
    catch (e) { throw wrapError(e, CacheError, `RedisCache.incr failed for key '${key}'`); }
    if (next === 1 && ttlMs !== undefined) {
      // First increment → set the TTL.  If pexpire fails, we accept the
      // inconsistency rather than rolling the counter back.
      try { await client.pexpire(k, ttlMs); } catch { /* swallow */ }
    }
    return next;
  }

  async setIfAbsent<V>(key: string, value: V, ttlMs?: number): Promise<boolean> {
    if (this.closed) throw new CacheError('RedisCache.setIfAbsent: cache is closed');
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new CacheError(`RedisCache.setIfAbsent: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    const client = await this.clientLazy.get();
    const payload = JSON.stringify(value);
    try {
      const result = ttlMs === undefined
        ? await client.set(this.k(key), payload, 'NX')
        : await client.set(this.k(key), payload, 'PX', ttlMs, 'NX');
      // ioredis returns 'OK' on success and null on collision.
      return result === 'OK';
    } catch (e) {
      throw wrapError(e, CacheError, `RedisCache.setIfAbsent failed for key '${key}'`);
    }
  }

  async delete(...keys: string[]): Promise<void> {
    if (this.closed || keys.length === 0) return;
    try {
      const client = await this.clientLazy.get();
      await client.del(...keys.map((k) => this.k(k)));
    } catch {
      // Lost delete is acceptable.
    }
  }

  async mget<V>(keys: ReadonlyArray<string>): Promise<Map<string, V>> {
    const out = new Map<string, V>();
    if (this.closed || keys.length === 0) return out;
    try {
      const client = await this.clientLazy.get();
      const raw = await client.mget(...keys.map((k) => this.k(k)));
      for (let i = 0; i < keys.length; i++) {
        const v = raw[i];
        if (v === null || v === undefined) continue;
        try {
          out.set(keys[i]!, JSON.parse(v) as V);
        } catch {
          // Bad payload — treat as a miss.  Same semantics as `get`
          // returning None on a transient failure.
        }
      }
    } catch {
      // Transient backend failure — return whatever we managed.
    }
    return out;
  }

  async mset<V>(entries: ReadonlyMap<string, V>, ttlMs?: number): Promise<void> {
    if (this.closed || entries.size === 0) return;
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new CacheError(`RedisCache.mset: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    try {
      const client = await this.clientLazy.get();
      if (ttlMs === undefined) {
        // Single MSET command — atomic on the server side.
        const args: string[] = [];
        for (const [k, v] of entries) {
          args.push(this.k(k));
          args.push(JSON.stringify(v));
        }
        await client.mset(...args);
      } else {
        // MSET doesn't accept per-key TTL — fall back to parallel
        // `SET k v PX ttl` calls.  Not atomic across keys, but a
        // cache write losing atomicity is tolerable (same standing as
        // the per-key `set` failure mode).
        await Promise.all(
          Array.from(entries).map(([k, v]) =>
            client.set(this.k(k), JSON.stringify(v), 'PX', ttlMs),
          ),
        );
      }
    } catch {
      // Lost write is acceptable for a cache.
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
    return this.keyPrefix ? `${this.keyPrefix}${key}` : key;
  }
}

/* ---------------------------- internals --------------------------------- */

interface RedisCtor {
  new (url: string): RedisClientLike;
  new (opts: { host?: string; port?: number; password?: string; db?: number }): RedisClientLike;
}

const ioredisLazy: Lazy<Promise<unknown>> = Lazy.of(async () => {
  try {
    const name = 'ioredis';
    return await import(name);
  } catch (e) {
    throw new CacheError(
      'RedisCache requires the "ioredis" package.  Install it with: npm install ioredis',
      e,
    );
  }
});
