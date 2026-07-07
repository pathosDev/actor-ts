import { describe, expect, test } from 'bun:test';
import { RedisCache, type RedisClientLike } from '../../../src/cache/RedisCache.js';
import { RedisCacheOptions } from '../../../src/cache/RedisCacheOptions.js';
import { CacheError } from '../../../src/cache/Cache.js';

/**
 * Mock ioredis client — captures the calls and lets the tests assert on
 * the wire-level commands.  We don't run a real Redis here; integration
 * tests against a live container live elsewhere (skipped when Redis is
 * unavailable).
 */
class FakeRedis implements RedisClientLike {
  store = new Map<string, string>();
  ttls = new Map<string, number>();
  log: Array<{ op: string; args: unknown[] }> = [];

  async get(key: string): Promise<string | null> {
    this.log.push({ op: 'get', args: [key] });
    return this.store.get(key) ?? null;
  }
  async set(...args: unknown[]): Promise<unknown> {
    this.log.push({ op: 'set', args });
    const [key, value, ...rest] = args as [string, string, ...unknown[]];
    let ttlMs: number | undefined;
    let nx = false;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === 'PX') ttlMs = rest[++i] as number;
      else if (flag === 'NX') nx = true;
    }
    if (nx && this.store.has(key)) return null;
    this.store.set(key, value);
    if (ttlMs !== undefined) this.ttls.set(key, ttlMs);
    return 'OK';
  }
  async incr(key: string): Promise<number> {
    this.log.push({ op: 'incr', args: [key] });
    const cur = Number(this.store.get(key) ?? '0');
    const next = cur + 1;
    this.store.set(key, String(next));
    return next;
  }
  async pexpire(key: string, ttlMs: number): Promise<number> {
    this.log.push({ op: 'pexpire', args: [key, ttlMs] });
    if (!this.store.has(key)) return 0;
    this.ttls.set(key, ttlMs);
    return 1;
  }
  async del(...keys: string[]): Promise<number> {
    this.log.push({ op: 'del', args: keys });
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
  async mget(...keys: string[]): Promise<Array<string | null>> {
    this.log.push({ op: 'mget', args: keys });
    return keys.map((k) => this.store.get(k) ?? null);
  }
  async mset(...kv: string[]): Promise<unknown> {
    this.log.push({ op: 'mset', args: kv });
    for (let i = 0; i < kv.length; i += 2) {
      this.store.set(kv[i]!, kv[i + 1]!);
    }
    return 'OK';
  }
  async quit(): Promise<unknown> {
    this.log.push({ op: 'quit', args: [] });
    return 'OK';
  }
}

describe('RedisCache — wire-protocol shape', () => {
  test('set with TTL emits PX command', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.set('k', { x: 1 }, 5_000);
    const setCall = fake.log.find(l => l.op === 'set');
    expect(setCall?.args).toContain('PX');
    expect(setCall?.args).toContain(5_000);
    expect(JSON.parse(fake.store.get('k')!)).toEqual({ x: 1 });
  });

  test('set without TTL omits PX', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.set('k', 1);
    const setCall = fake.log.find(l => l.op === 'set');
    expect(setCall?.args).not.toContain('PX');
  });

  test('setIfAbsent uses NX flag and returns boolean', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    expect(await c.setIfAbsent('k', 'v1', 1_000)).toBe(true);
    expect(await c.setIfAbsent('k', 'v2', 1_000)).toBe(false);
    expect(JSON.parse(fake.store.get('k')!)).toBe('v1');
    const nxCalls = fake.log.filter(l => l.op === 'set' && l.args.includes('NX'));
    expect(nxCalls).toHaveLength(2);
  });

  test('incr first call sets TTL via pexpire; subsequent calls do not', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    expect(await c.incr('rate', 60_000)).toBe(1);
    expect(await c.incr('rate', 60_000)).toBe(2);
    const expireCalls = fake.log.filter(l => l.op === 'pexpire');
    expect(expireCalls).toHaveLength(1);
    expect(expireCalls[0]!.args).toEqual(['rate', 60_000]);
  });

  test('get parses JSON; miss returns None', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.set('k', { a: 1 });
    expect((await c.get<{ a: number }>('k')).toNullable()).toEqual({ a: 1 });
    expect((await c.get('absent')).isNone()).toBe(true);
  });

  test('delete is variadic and idempotent', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.set('a', 1); await c.set('b', 2);
    await c.delete('a', 'b', 'missing');
    expect(fake.store.size).toBe(0);
  });

  test('keyPrefix is prepended to every key', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake)
      .withKeyPrefix('app:');
    const c = new RedisCache(redisOptions);
    await c.set('user:42', { id: 42 });
    expect(fake.store.has('app:user:42')).toBe(true);
    expect((await c.get('user:42')).isSome()).toBe(true);
  });

  test('close calls quit on the underlying client', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.set('k', 1);
    await c.close();
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
      async quit() { return 'OK'; },
    };
    const redisOptions = RedisCacheOptions.create()
      .withClient(broken);
    const c = new RedisCache(redisOptions);
    expect((await c.get('k')).isNone()).toBe(true);
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
    const c = new RedisCache(redisOptions);
    await c.set('k', 1);  // must not throw
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
    const c = new RedisCache(redisOptions);
    await expect(c.incr('k')).rejects.toThrow();
  });
});

describe('RedisCache — mget / mset (#14)', () => {
  test('mget issues a single MGET command and returns a Map of hits', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.set('a', 1);
    await c.set('b', 'two');
    const got = await c.mget<unknown>(['a', 'b', 'missing']);
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
    const c = new RedisCache(redisOptions);
    await c.mset(new Map([['a', 1], ['b', 2]] as const));
    const mset = fake.log.filter(l => l.op === 'mset');
    expect(mset).toHaveLength(1);
    // Flat [k1, v1, k2, v2, ...] — values JSON-stringified.
    expect(mset[0]!.args).toEqual(['a', '1', 'b', '2']);
  });

  test('mset with TTL falls back to parallel SET ... PX (MSET has no per-key TTL)', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.mset(new Map([['a', 1], ['b', 2]] as const), 5_000);
    // No MSET emitted; instead two SETs with PX flag.
    expect(fake.log.some(l => l.op === 'mset')).toBe(false);
    const sets = fake.log.filter(l => l.op === 'set');
    expect(sets).toHaveLength(2);
    for (const s of sets) {
      expect(s.args).toContain('PX');
      expect(s.args).toContain(5_000);
    }
  });

  test('mset on empty Map is a no-op (no MSET / SET issued)', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.mset(new Map());
    expect(fake.log.filter(l => l.op === 'mset' || l.op === 'set')).toHaveLength(0);
  });

  test('mget honours the keyPrefix', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake)
      .withKeyPrefix('app:');
    const c = new RedisCache(redisOptions);
    await c.set('a', 1);
    await c.mget(['a', 'b']);
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
    const c = new RedisCache(redisOptions);
    const got = await c.mget(['a', 'b']);
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
    const c = new RedisCache(redisOptions);
    const got = await c.mget<unknown>(['a', 'b']);
    expect(got.has('a')).toBe(false);
    expect(got.get('b')).toBe('hello');
  });
});

describe('RedisCache — TTL validation', () => {
  test('set rejects negative TTL', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const c = new RedisCache(redisOptions);
    await expect(c.set('k', 1, -1)).rejects.toBeInstanceOf(CacheError);
  });

  test('set rejects zero TTL', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const c = new RedisCache(redisOptions);
    await expect(c.set('k', 1, 0)).rejects.toBeInstanceOf(CacheError);
  });

  test('set rejects NaN TTL', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const c = new RedisCache(redisOptions);
    await expect(c.set('k', 1, Number.NaN)).rejects.toBeInstanceOf(CacheError);
  });

  test('set rejects Infinity TTL', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const c = new RedisCache(redisOptions);
    await expect(c.set('k', 1, Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(CacheError);
  });

  test('incr rejects bad TTL identically', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const c = new RedisCache(redisOptions);
    await expect(c.incr('k', -1)).rejects.toBeInstanceOf(CacheError);
    await expect(c.incr('k', 0)).rejects.toBeInstanceOf(CacheError);
    await expect(c.incr('k', Number.NaN)).rejects.toBeInstanceOf(CacheError);
  });

  test('setIfAbsent rejects bad TTL identically', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const c = new RedisCache(redisOptions);
    await expect(c.setIfAbsent('k', 1, -1)).rejects.toBeInstanceOf(CacheError);
    await expect(c.setIfAbsent('k', 1, 0)).rejects.toBeInstanceOf(CacheError);
  });

  test('mset rejects bad TTL identically', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const c = new RedisCache(redisOptions);
    await expect(c.mset(new Map([['a', 1]] as const), -1))
      .rejects.toBeInstanceOf(CacheError);
  });
});

describe('RedisCache — close() semantics', () => {
  test('close is idempotent (no double-quit)', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.set('k', 1); // forces client construction
    await c.close();
    await c.close(); // second close is a no-op
    expect(fake.log.filter(l => l.op === 'quit')).toHaveLength(1);
  });

  test('close before any operation does NOT trigger quit (client never built)', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.close();
    // The lazy client was never evaluated → quit not called.
    expect(fake.log.filter(l => l.op === 'quit')).toHaveLength(0);
  });

  test('after close: get returns None silently', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.set('k', 1);
    await c.close();
    expect((await c.get('k')).isNone()).toBe(true);
  });

  test('after close: set / delete / mset / mget are no-ops', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.close();
    // None of these should crash, and none should issue a wire-level call.
    await c.set('k', 1);
    await c.delete('k');
    await c.mset(new Map([['a', 1]] as const));
    const empty = await c.mget(['k']);
    expect(empty.size).toBe(0);
    // After close the only wire op is the initial quit-from-set above
    // (which we didn't issue — there's no client at all).  But the
    // first thing set() did was check `closed`, so no client construction.
  });

  test('after close: incr throws CacheError', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const c = new RedisCache(redisOptions);
    await c.close();
    await expect(c.incr('k')).rejects.toBeInstanceOf(CacheError);
  });

  test('after close: setIfAbsent throws CacheError', async () => {
    const redisOptions = RedisCacheOptions.create()
      .withClient(new FakeRedis());
    const c = new RedisCache(redisOptions);
    await c.close();
    await expect(c.setIfAbsent('k', 1)).rejects.toBeInstanceOf(CacheError);
  });
});

describe('RedisCache — additional edges', () => {
  test('delete with no keys is a no-op (no DEL command issued)', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    await c.delete();
    expect(fake.log.filter(l => l.op === 'del')).toHaveLength(0);
  });

  test('mget with empty keys returns an empty Map without a wire call', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    const got = await c.mget([]);
    expect(got.size).toBe(0);
    expect(fake.log.filter(l => l.op === 'mget')).toHaveLength(0);
  });

  test('get returns None when stored value is not valid JSON', async () => {
    // Same defensive behaviour as transient backend failure.
    const fake = new FakeRedis();
    fake.store.set('bad', '{not json');
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    expect((await c.get('bad')).isNone()).toBe(true);
  });

  test('setIfAbsent without TTL still uses the NX flag', async () => {
    const fake = new FakeRedis();
    const redisOptions = RedisCacheOptions.create()
      .withClient(fake);
    const c = new RedisCache(redisOptions);
    expect(await c.setIfAbsent('k', 'v')).toBe(true);
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
    const c = new RedisCache(redisOptions);
    await expect(c.setIfAbsent('k', 1)).rejects.toBeInstanceOf(CacheError);
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
    const c = new RedisCache(redisOptions);
    expect(await c.incr('rate', 60_000)).toBe(1);
    expect(pexpireCalls).toBe(1);
  });
});
