import { describe, expect, test } from 'bun:test';
import { RedisCache, type RedisClientLike } from '../../../src/cache/RedisCache.js';

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
  async quit(): Promise<unknown> {
    this.log.push({ op: 'quit', args: [] });
    return 'OK';
  }
}

describe('RedisCache — wire-protocol shape', () => {
  test('set with TTL emits PX command', async () => {
    const fake = new FakeRedis();
    const c = new RedisCache({ client: fake });
    await c.set('k', { x: 1 }, 5_000);
    const setCall = fake.log.find(l => l.op === 'set');
    expect(setCall?.args).toContain('PX');
    expect(setCall?.args).toContain(5_000);
    expect(JSON.parse(fake.store.get('k')!)).toEqual({ x: 1 });
  });

  test('set without TTL omits PX', async () => {
    const fake = new FakeRedis();
    const c = new RedisCache({ client: fake });
    await c.set('k', 1);
    const setCall = fake.log.find(l => l.op === 'set');
    expect(setCall?.args).not.toContain('PX');
  });

  test('setIfAbsent uses NX flag and returns boolean', async () => {
    const fake = new FakeRedis();
    const c = new RedisCache({ client: fake });
    expect(await c.setIfAbsent('k', 'v1', 1_000)).toBe(true);
    expect(await c.setIfAbsent('k', 'v2', 1_000)).toBe(false);
    expect(JSON.parse(fake.store.get('k')!)).toBe('v1');
    const nxCalls = fake.log.filter(l => l.op === 'set' && l.args.includes('NX'));
    expect(nxCalls).toHaveLength(2);
  });

  test('incr first call sets TTL via pexpire; subsequent calls do not', async () => {
    const fake = new FakeRedis();
    const c = new RedisCache({ client: fake });
    expect(await c.incr('rate', 60_000)).toBe(1);
    expect(await c.incr('rate', 60_000)).toBe(2);
    const expireCalls = fake.log.filter(l => l.op === 'pexpire');
    expect(expireCalls).toHaveLength(1);
    expect(expireCalls[0]!.args).toEqual(['rate', 60_000]);
  });

  test('get parses JSON; miss returns None', async () => {
    const fake = new FakeRedis();
    const c = new RedisCache({ client: fake });
    await c.set('k', { a: 1 });
    expect((await c.get<{ a: number }>('k')).toNullable()).toEqual({ a: 1 });
    expect((await c.get('absent')).isNone()).toBe(true);
  });

  test('delete is variadic and idempotent', async () => {
    const fake = new FakeRedis();
    const c = new RedisCache({ client: fake });
    await c.set('a', 1); await c.set('b', 2);
    await c.delete('a', 'b', 'missing');
    expect(fake.store.size).toBe(0);
  });

  test('keyPrefix is prepended to every key', async () => {
    const fake = new FakeRedis();
    const c = new RedisCache({ client: fake, keyPrefix: 'app:' });
    await c.set('user:42', { id: 42 });
    expect(fake.store.has('app:user:42')).toBe(true);
    expect((await c.get('user:42')).isSome()).toBe(true);
  });

  test('close calls quit on the underlying client', async () => {
    const fake = new FakeRedis();
    const c = new RedisCache({ client: fake });
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
    const c = new RedisCache({ client: broken });
    expect((await c.get('k')).isNone()).toBe(true);
  });

  test('set swallows transient errors silently (cache misses are tolerable)', async () => {
    const broken: RedisClientLike = {
      async get() { return null; },
      async set() { throw new Error('connection refused'); },
      async incr() { return 0; },
      async pexpire() { return 0; },
      async del() { return 0; },
      async quit() { return 'OK'; },
    };
    const c = new RedisCache({ client: broken });
    await c.set('k', 1);  // must not throw
  });

  test('incr propagates errors (atomicity is required)', async () => {
    const broken: RedisClientLike = {
      async get() { return null; },
      async set() { return 'OK'; },
      async incr() { throw new Error('connection refused'); },
      async pexpire() { return 0; },
      async del() { return 0; },
      async quit() { return 'OK'; },
    };
    const c = new RedisCache({ client: broken });
    await expect(c.incr('k')).rejects.toThrow();
  });
});
