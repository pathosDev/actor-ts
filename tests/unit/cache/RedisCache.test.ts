import { describe, expect, test } from 'bun:test';
import { RedisCache, type RedisClientLike } from '../../../src/cache/RedisCache.js';
import {
  DEFAULT_REDIS_DB,
  RedisCacheOptions,
  readRedisCacheOptionsFromConfig,
  redisCacheKeysUnder,
} from '../../../src/cache/RedisCacheOptions.js';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { CacheError } from '../../../src/cache/Cache.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { runCacheContractTests } from './_Contract.js';

/**
 * Mock ioredis client — captures the calls and lets the tests assert on
 * the wire-level commands.  We don't run a real Redis here; integration
 * tests against a live container live elsewhere (skipped when Redis is
 * unavailable).
 */
class FakeRedis implements RedisClientLike {
  store = new Map<string, string>();
  /**
   * Absolute deadline in epoch ms; no entry means "no expiry".  Kept
   * separate from `store` and honoured by every read so the fake
   * actually expires keys — a fake that accepts `PX` and then serves
   * the value forever would pass a TTL test that proves nothing.
   */
  expiresAt = new Map<string, number>();
  log: Array<{ op: string; args: unknown[] }> = [];

  async get(key: string): Promise<string | null> {
    this.log.push({ op: 'get', args: [key] });
    return this.isLive(key) ? this.store.get(key)! : null;
  }
  // Signature mirrors the widest of `RedisClientLike`'s four `set`
  // overloads: leading key/value, then the optional PX/NX flag tail.
  // A bare `(...args: unknown[])` does not satisfy an overloaded
  // property type, which is why every `withClient(new FakeRedis())`
  // used to report TS2345.
  async set(key: string, value: string, ...rest: unknown[]): Promise<string | null> {
    this.log.push({ op: 'set', args: [key, value, ...rest] });
    let ttlMs: number | undefined;
    let nx = false;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === 'PX') ttlMs = rest[++i] as number;
      else if (flag === 'NX') nx = true;
    }
    // An elapsed key is absent for NX purposes, exactly as on the server.
    if (nx && this.isLive(key)) return null;
    this.store.set(key, value);
    if (ttlMs === undefined) this.expiresAt.delete(key);   // SET clears any TTL
    else this.expiresAt.set(key, Date.now() + ttlMs);
    return 'OK';
  }
  async incr(key: string): Promise<number> {
    this.log.push({ op: 'incr', args: [key] });
    const current = this.isLive(key) ? Number(this.store.get(key)) : 0;
    const next = current + 1;
    this.store.set(key, String(next));
    return next;
  }
  async pexpire(key: string, ttlMs: number): Promise<number> {
    this.log.push({ op: 'pexpire', args: [key, ttlMs] });
    if (!this.isLive(key)) return 0;
    this.expiresAt.set(key, Date.now() + ttlMs);
    return 1;
  }
  async del(...keys: string[]): Promise<number> {
    this.log.push({ op: 'del', args: keys });
    let deleted = 0;
    for (const key of keys) {
      this.expiresAt.delete(key);
      if (this.store.delete(key)) deleted++;
    }
    return deleted;
  }
  async mget(...keys: string[]): Promise<Array<string | null>> {
    this.log.push({ op: 'mget', args: keys });
    return keys.map((key) => (this.isLive(key) ? this.store.get(key)! : null));
  }
  async mset(...keyValuePairs: string[]): Promise<unknown> {
    this.log.push({ op: 'mset', args: keyValuePairs });
    for (let i = 0; i < keyValuePairs.length; i += 2) {
      this.store.set(keyValuePairs[i]!, keyValuePairs[i + 1]!);
      this.expiresAt.delete(keyValuePairs[i]!);            // MSET clears any TTL
    }
    return 'OK';
  }
  async quit(): Promise<unknown> {
    this.log.push({ op: 'quit', args: [] });
    return 'OK';
  }

  /** Lazy expiry, like the real server: an elapsed key reads as absent. */
  private isLive(key: string): boolean {
    if (!this.store.has(key)) return false;
    const deadline = this.expiresAt.get(key);
    if (deadline !== undefined && deadline <= Date.now()) {
      this.store.delete(key);
      this.expiresAt.delete(key);
      return false;
    }
    return true;
  }
}

// Backend-agnostic contract.  The fake is stateful, so the factory mints
// a fresh one per call — `beforeEach` invokes it once per test, which is
// what keeps the runs isolated.
describe('RedisCache — contract', () => {
  runCacheContractTests({
    name: 'RedisCache',
    factory: async () => {
      const redisOptions = RedisCacheOptions.create().withClient(new FakeRedis());
      return new RedisCache(redisOptions);
    },
  });
});

describe('RedisCache — wire-protocol shape', () => {
  test('set with TTL emits PX command', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.set('k', { x: 1 }, 5_000);
    const setCall = fake.log.find(l => l.op === 'set');
    expect(setCall?.args).toContain('PX');
    expect(setCall?.args).toContain(5_000);
    expect(JSON.parse(fake.store.get('k')!)).toEqual({ x: 1 });
  });

  test('set without TTL omits PX', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.set('k', 1);
    const setCall = fake.log.find(l => l.op === 'set');
    expect(setCall?.args).not.toContain('PX');
  });

  test('setIfAbsent uses NX flag and returns boolean', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    expect(await cache.setIfAbsent('k', 'v1', 1_000)).toBe(true);
    expect(await cache.setIfAbsent('k', 'v2', 1_000)).toBe(false);
    expect(JSON.parse(fake.store.get('k')!)).toBe('v1');
    const nxCalls = fake.log.filter(l => l.op === 'set' && l.args.includes('NX'));
    expect(nxCalls).toHaveLength(2);
  });

  test('incr first call sets TTL via pexpire; subsequent calls do not', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    expect(await cache.incr('rate', 60_000)).toBe(1);
    expect(await cache.incr('rate', 60_000)).toBe(2);
    const expireCalls = fake.log.filter(l => l.op === 'pexpire');
    expect(expireCalls).toHaveLength(1);
    expect(expireCalls[0]!.args).toEqual(['rate', 60_000]);
  });

  test('get parses JSON; miss returns None', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.set('k', { a: 1 });
    expect((await cache.get<{ a: number }>('k')).toNullable()).toEqual({ a: 1 });
    expect((await cache.get('absent')).isNone()).toBe(true);
  });

  test('delete is variadic and idempotent', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.set('a', 1); await cache.set('b', 2);
    await cache.delete('a', 'b', 'missing');
    expect(fake.store.size).toBe(0);
  });

  test('keyPrefix is prepended to every key', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake)
      .withKeyPrefix('app:');
    const cache = new RedisCache(redisOptions);
    await cache.set('user:42', { id: 42 });
    expect(fake.store.has('app:user:42')).toBe(true);
    expect((await cache.get('user:42')).isSome()).toBe(true);
  });

  test('close calls quit on the underlying client', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.set('k', 1);
    await cache.close();
    expect(fake.log.some(l => l.op === 'quit')).toBe(true);
  });
});

describe('RedisCache — failure tolerance', () => {
  test('get swallows transient backend errors and returns None', async () => {
    const broken: RedisClientLike = {
      async get() { throw new Error('connection refused'); },
      async set() { return 'OK'; },
      async incr() { return 0; },
      async pexpire() { return 0; },
      async del() { return 0; },
      async mget() { return []; },
      async mset() { return 'OK'; },
      async quit() { return 'OK'; },
    };
    const redisOptions = RedisCacheOptions.create()
      .withClient(broken);
    const cache = new RedisCache(redisOptions);
    expect((await cache.get('k')).isNone()).toBe(true);
  });

  test('set swallows transient errors silently (cache misses are tolerable)', async () => {
    const broken: RedisClientLike = {
      async get() { return null; },
      async set() { throw new Error('connection refused'); },
      async incr() { return 0; },
      async pexpire() { return 0; },
      async del() { return 0; },
      async mget() { return []; },
      async mset() { return 'OK'; },
      async quit() { return 'OK'; },
    };
    const redisOptions = RedisCacheOptions.create()
      .withClient(broken);
    const cache = new RedisCache(redisOptions);
    await cache.set('k', 1);  // must not throw
  });

  test('incr propagates errors (atomicity is required)', async () => {
    const broken: RedisClientLike = {
      async get() { return null; },
      async set() { return 'OK'; },
      async incr() { throw new Error('connection refused'); },
      async pexpire() { return 0; },
      async del() { return 0; },
      async mget() { return []; },
      async mset() { return 'OK'; },
      async quit() { return 'OK'; },
    };
    const redisOptions = RedisCacheOptions.create()
      .withClient(broken);
    const cache = new RedisCache(redisOptions);
    await expect(cache.incr('k')).rejects.toThrow();
  });
});

describe('RedisCache — mget / mset (#14)', () => {
  test('mget issues a single MGET command and returns a Map of hits', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.set('a', 1);
    await cache.set('b', 'two');
    const got = await cache.mget<unknown>(['a', 'b', 'missing']);
    expect(got.get('a')).toBe(1);
    expect(got.get('b')).toBe('two');
    expect(got.has('missing')).toBe(false);
    // Verify the wire shape — one MGET with all three keys.
    const mget = fake.log.filter(l => l.op === 'mget');
    expect(mget).toHaveLength(1);
    expect(mget[0]!.args).toEqual(['a', 'b', 'missing']);
  });

  test('mset without TTL emits a single MSET', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.mset(new Map([['a', 1], ['b', 2]] as const));
    const mset = fake.log.filter(l => l.op === 'mset');
    expect(mset).toHaveLength(1);
    // Flat [k1, v1, k2, v2, ...] — values JSON-stringified.
    expect(mset[0]!.args).toEqual(['a', '1', 'b', '2']);
  });

  test('mset with TTL falls back to parallel SET ... PX (MSET has no per-key TTL)', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.mset(new Map([['a', 1], ['b', 2]] as const), 5_000);
    // No MSET emitted; instead two SETs with PX flag.
    expect(fake.log.some(l => l.op === 'mset')).toBe(false);
    const sets = fake.log.filter(l => l.op === 'set');
    expect(sets).toHaveLength(2);
    for (const setCall of sets) {
      expect(setCall.args).toContain('PX');
      expect(setCall.args).toContain(5_000);
    }
  });

  test('mset on empty Map is a no-op (no MSET / SET issued)', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.mset(new Map());
    expect(fake.log.filter(l => l.op === 'mset' || l.op === 'set')).toHaveLength(0);
  });

  test('mget honours the keyPrefix', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake)
      .withKeyPrefix('app:');
    const cache = new RedisCache(redisOptions);
    await cache.set('a', 1);
    await cache.mget(['a', 'b']);
    const mget = fake.log.find(l => l.op === 'mget');
    expect(mget?.args).toEqual(['app:a', 'app:b']);
  });

  test('mget swallows transient errors and returns the empty Map', async () => {
    const broken: RedisClientLike = {
      async get() { return null; },
      async set() { return 'OK'; },
      async incr() { return 0; },
      async pexpire() { return 0; },
      async del() { return 0; },
      async mget() { throw new Error('connection refused'); },
      async mset() { return 'OK'; },
      async quit() { return 'OK'; },
    };
    const redisOptions = RedisCacheOptions.create()
      .withClient(broken);
    const cache = new RedisCache(redisOptions);
    const got = await cache.mget(['a', 'b']);
    expect(got.size).toBe(0);
  });

  test('mget treats a malformed payload as a miss for that key only', async () => {
    // Manually inject a non-JSON value so the JSON.parse in mget
    // throws; the surrounding catch must keep the other hits.
    const fake = new FakeRedis();
    fake.store.set('a', '{not json');
    fake.store.set('b', '"hello"');
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    const got = await cache.mget<unknown>(['a', 'b']);
    expect(got.has('a')).toBe(false);
    expect(got.get('b')).toBe('hello');
  });
});

describe('RedisCache — TTL validation', () => {
  test('set rejects negative TTL', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const cache = new RedisCache(redisOptions);
    await expect(cache.set('k', 1, -1)).rejects.toBeInstanceOf(CacheError);
  });

  test('set rejects zero TTL', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const cache = new RedisCache(redisOptions);
    await expect(cache.set('k', 1, 0)).rejects.toBeInstanceOf(CacheError);
  });

  test('set rejects NaN TTL', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const cache = new RedisCache(redisOptions);
    await expect(cache.set('k', 1, Number.NaN)).rejects.toBeInstanceOf(CacheError);
  });

  test('set rejects Infinity TTL', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const cache = new RedisCache(redisOptions);
    await expect(cache.set('k', 1, Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(CacheError);
  });

  test('incr rejects bad TTL identically', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const cache = new RedisCache(redisOptions);
    await expect(cache.incr('k', -1)).rejects.toBeInstanceOf(CacheError);
    await expect(cache.incr('k', 0)).rejects.toBeInstanceOf(CacheError);
    await expect(cache.incr('k', Number.NaN)).rejects.toBeInstanceOf(CacheError);
  });

  test('setIfAbsent rejects bad TTL identically', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const cache = new RedisCache(redisOptions);
    await expect(cache.setIfAbsent('k', 1, -1)).rejects.toBeInstanceOf(CacheError);
    await expect(cache.setIfAbsent('k', 1, 0)).rejects.toBeInstanceOf(CacheError);
  });

  test('mset rejects bad TTL identically', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const cache = new RedisCache(redisOptions);
    await expect(cache.mset(new Map([['a', 1]] as const), -1))
      .rejects.toBeInstanceOf(CacheError);
  });
});

describe('RedisCache — options validation', () => {
  test('rejects an out-of-range port', () => {
    const options = RedisCacheOptions.create().withPort(70_000);
    expect(() => new RedisCache(options)).toThrow(OptionsError);
  });

  test('rejects a negative db index', () => {
    const options = RedisCacheOptions.create().withDb(-1);
    expect(() => new RedisCache(options)).toThrow(OptionsError);
  });

  test('rejects a url with a non-Redis protocol', () => {
    const options = RedisCacheOptions.create().withUrl('http://localhost:6379');
    expect(() => new RedisCache(options)).toThrow(OptionsError);
  });

  test('rejects url combined with host/port (mutually exclusive)', () => {
    const options = RedisCacheOptions.create()
      .withUrl('redis://localhost:6379')
      .withPort(6380);
    expect(() => new RedisCache(options)).toThrow(/mutually exclusive/);
  });

  test('accepts a valid url alone', () => {
    const options = RedisCacheOptions.create().withUrl('rediss://localhost:6379');
    expect(() => new RedisCache(options)).not.toThrow();
  });
});

describe('RedisCache — close() semantics', () => {
  test('close is idempotent (no double-quit)', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.set('k', 1); // forces client construction
    await cache.close();
    await cache.close(); // second close is a no-op
    expect(fake.log.filter(l => l.op === 'quit')).toHaveLength(1);
  });

  test('close before any operation does NOT trigger quit (client never built)', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.close();
    // The lazy client was never evaluated → quit not called.
    expect(fake.log.filter(l => l.op === 'quit')).toHaveLength(0);
  });

  test('after close: get returns None silently', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.set('k', 1);
    await cache.close();
    expect((await cache.get('k')).isNone()).toBe(true);
  });

  test('after close: set / delete / mset / mget are no-ops', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.close();
    // None of these should crash, and none should issue a wire-level call.
    await cache.set('k', 1);
    await cache.delete('k');
    await cache.mset(new Map([['a', 1]] as const));
    const empty = await cache.mget(['k']);
    expect(empty.size).toBe(0);
    // After close the only wire op is the initial quit-from-set above
    // (which we didn't issue — there's no client at all).  But the
    // first thing set() did was check `closed`, so no client construction.
  });

  test('after close: incr throws CacheError', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const cache = new RedisCache(redisOptions);
    await cache.close();
    await expect(cache.incr('k')).rejects.toBeInstanceOf(CacheError);
  });

  test('after close: setIfAbsent throws CacheError', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const cache = new RedisCache(redisOptions);
    await cache.close();
    await expect(cache.setIfAbsent('k', 1)).rejects.toBeInstanceOf(CacheError);
  });
});

describe('RedisCache — additional edges', () => {
  test('delete with no keys is a no-op (no DEL command issued)', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    await cache.delete();
    expect(fake.log.filter(l => l.op === 'del')).toHaveLength(0);
  });

  test('mget with empty keys returns an empty Map without a wire call', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    const got = await cache.mget([]);
    expect(got.size).toBe(0);
    expect(fake.log.filter(l => l.op === 'mget')).toHaveLength(0);
  });

  test('get returns None when stored value is not valid JSON', async () => {
    // Same defensive behaviour as transient backend failure.
    const fake = new FakeRedis();
    fake.store.set('bad', '{not json');
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    expect((await cache.get('bad')).isNone()).toBe(true);
  });

  test('setIfAbsent without TTL still uses the NX flag', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const cache = new RedisCache(redisOptions);
    expect(await cache.setIfAbsent('k', 'v')).toBe(true);
    const setCall = fake.log.find(l => l.op === 'set');
    expect(setCall?.args).toContain('NX');
    expect(setCall?.args).not.toContain('PX');
  });

  test('setIfAbsent propagates non-collision errors as CacheError', async () => {
    const broken: RedisClientLike = {
      async get() { return null; },
      async set() { throw new Error('connection refused'); },
      async incr() { return 0; },
      async pexpire() { return 0; },
      async del() { return 0; },
      async mget() { return []; },
      async mset() { return 'OK'; },
      async quit() { return 'OK'; },
    };
    const redisOptions = RedisCacheOptions.create()
      .withClient(broken);
    const cache = new RedisCache(redisOptions);
    await expect(cache.setIfAbsent('k', 1)).rejects.toBeInstanceOf(CacheError);
  });

  test('incr swallows pexpire errors silently after the counter increments', async () => {
    // The first-increment TTL set is best-effort — if pexpire fails,
    // the counter still returns successfully.  Pin that.
    let pexpireCalls = 0;
    const flaky: RedisClientLike = {
      async get() { return null; },
      async set() { return 'OK'; },
      async incr() { return 1; }, // first call
      async pexpire() { pexpireCalls++; throw new Error('boom'); },
      async del() { return 0; },
      async mget() { return []; },
      async mset() { return 'OK'; },
      async quit() { return 'OK'; },
    };
    const redisOptions = RedisCacheOptions.create()
      .withClient(flaky);
    const cache = new RedisCache(redisOptions);
    expect(await cache.incr('rate', 60_000)).toBe(1);
    expect(pexpireCalls).toBe(1);
  });
});

/**
 * `actor-ts.cache.redis` → `RedisCacheOptionsType`, leaf by leaf (#876).
 *
 * Written against `Config.parseString` rather than `Config.fromObject({'a.b':
 * 1})`: the object form keeps the dotted string as a literal top-level key, so
 * `hasPath` would go on resolving a *nested* value and the test would assert
 * nothing.
 *
 * These are also the only guard on the block.  `NoDeadConfigKeys` cannot be
 * one: its `coveringAccessor` resolves every `actor-ts.cache.*.*` leaf onto
 * `ConfigKeys.cache.root`, a name `CacheExtension.ts` has always carried, so a
 * wholly unread redis block passes it green.
 */
describe('RedisCache — reading the config block', () => {
  test('maps every leaf, and returns only the ones that are set', () => {
    const config = Config.parseString(`
      actor-ts.cache.redis {
        host = "redis.internal"
        port = 6380
        db = 3
        key-prefix = "billing:"
        password = "s3cret"
      }
    `);
    expect(readRedisCacheOptionsFromConfig(config)).toEqual({
      host: 'redis.internal',
      port: 6380,
      db: 3,
      keyPrefix: 'billing:',
      password: 's3cret',
    });
  });

  test('treats an empty string as unset, on every string leaf', () => {
    // This is what keeps the shipped block usable at all: the validator runs
    // `new URL('')`, which throws, so a published `url = ""` handed on verbatim
    // would refuse every config-built RedisCache before it ever connected.
    const config = Config.parseString('actor-ts.cache.redis { url = "", key-prefix = "", password = "" }');
    const settings = readRedisCacheOptionsFromConfig(config);
    expect(settings).toEqual({});
    expect(() => new RedisCache(settings)).not.toThrow();
  });

  test('the shipped block alone selects the logical database and nothing else', () => {
    // What an operator who wrote no application.conf gets.  `db` is the block's
    // one real default; `host` and `port` are comments precisely so that
    // "unset" survives to ioredis, and the rest are `""` placeholders.
    expect(readRedisCacheOptionsFromConfig(Config.parseString(REFERENCE_CONF)))
      .toEqual({ db: DEFAULT_REDIS_DB });
  });

  test('host and port are read when an operator writes them', () => {
    // They carry no reference.conf leaf, so no leaf-driven guard would notice
    // if the reader stopped looking at them.
    const config = Config.parseString('actor-ts.cache.redis { host = "h", port = 6390 }');
    expect(readRedisCacheOptionsFromConfig(config)).toEqual({ host: 'h', port: 6390 });
  });

  test('url together with host is passed on, and refused where that rule lives', () => {
    // The reader deliberately does NOT drop one of them.  Silently discarding a
    // host an operator wrote is how a config file stops meaning what it says,
    // and the mutual-exclusion rule is reachable exactly because both arrive.
    const config = Config.parseString('actor-ts.cache.redis { url = "redis://a:6379", host = "b" }');
    const settings = readRedisCacheOptionsFromConfig(config);
    expect(settings).toEqual({ url: 'redis://a:6379', host: 'b' });
    expect(() => new RedisCache(settings)).toThrow(OptionsError);
    expect(() => new RedisCache(settings)).toThrow(/mutually exclusive/);
  });

  test('redisCacheKeysUnder composes the kebab spellings under any root', () => {
    expect(redisCacheKeysUnder('actor-ts.cache.rate-limit.redis')).toEqual({
      root: 'actor-ts.cache.rate-limit.redis',
      url: 'actor-ts.cache.rate-limit.redis.url',
      host: 'actor-ts.cache.rate-limit.redis.host',
      port: 'actor-ts.cache.rate-limit.redis.port',
      db: 'actor-ts.cache.rate-limit.redis.db',
      keyPrefix: 'actor-ts.cache.rate-limit.redis.key-prefix',
      password: 'actor-ts.cache.rate-limit.redis.password',
    });
  });

  test('a per-name block is read through those keys, and not as the global one', () => {
    const config = Config.parseString('actor-ts.cache.rate-limit.redis.db = 7');
    expect(readRedisCacheOptionsFromConfig(config, redisCacheKeysUnder('actor-ts.cache.rate-limit.redis')))
      .toEqual({ db: 7 });
    expect(readRedisCacheOptionsFromConfig(config)).toEqual({});
  });
});
