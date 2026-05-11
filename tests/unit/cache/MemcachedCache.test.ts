import { describe, expect, test } from 'bun:test';
import { MemcachedCache, type MemcachedClientLike } from '../../../src/cache/MemcachedCache.js';

/**
 * Mock memjs client.  We don't actually run a memcached process —
 * integration tests against a live container would live elsewhere
 * (skipped when not reachable).  These tests exercise the wire-protocol
 * shape and the failure semantics.
 */
class FakeMemcached implements MemcachedClientLike {
  store = new Map<string, { value: string; expires: number }>();
  log: Array<{ op: string; args: unknown[] }> = [];

  async get(key: string): Promise<{ value: Buffer | null }> {
    this.log.push({ op: 'get', args: [key] });
    const entry = this.store.get(key);
    if (!entry) return { value: null };
    if (entry.expires > 0 && entry.expires < Date.now() / 1000) {
      this.store.delete(key);
      return { value: null };
    }
    return { value: Buffer.from(entry.value, 'utf8') };
  }
  async set(key: string, value: string | Buffer, opts: { expires?: number } = {}): Promise<boolean> {
    this.log.push({ op: 'set', args: [key, value, opts] });
    this.store.set(key, { value: value.toString(), expires: secondsAhead(opts.expires) });
    return true;
  }
  async add(key: string, value: string | Buffer, opts: { expires?: number } = {}): Promise<boolean> {
    this.log.push({ op: 'add', args: [key, value, opts] });
    if (this.store.has(key)) {
      const entry = this.store.get(key)!;
      if (entry.expires === 0 || entry.expires >= Date.now() / 1000) return false;
    }
    this.store.set(key, { value: value.toString(), expires: secondsAhead(opts.expires) });
    return true;
  }
  async delete(key: string): Promise<boolean> {
    this.log.push({ op: 'delete', args: [key] });
    return this.store.delete(key);
  }
  async increment(
    key: string, amount: number, opts: { initial?: number; expires?: number } = {},
  ): Promise<{ value: number | null }> {
    this.log.push({ op: 'increment', args: [key, amount, opts] });
    const entry = this.store.get(key);
    if (!entry) {
      const initial = opts.initial ?? 0;
      this.store.set(key, { value: String(initial), expires: secondsAhead(opts.expires) });
      return { value: initial };
    }
    const next = Number(entry.value) + amount;
    entry.value = String(next);
    return { value: next };
  }
  async quit(): Promise<void> {
    this.log.push({ op: 'quit', args: [] });
  }
}
function secondsAhead(seconds: number | undefined): number {
  if (seconds === undefined) return 0;  // 0 = no expiry in memcached
  return Math.floor(Date.now() / 1000) + seconds;
}

describe('MemcachedCache — round-trip', () => {
  test('set with TTL converts ms → seconds (rounded up)', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake });
    await c.set('k', { x: 1 }, 1500);  // 1.5s → 2s
    const setCall = fake.log.find((l) => l.op === 'set');
    expect((setCall!.args[2] as { expires: number }).expires).toBe(2);
  });

  test('set without TTL stores with no expires (memcached default = no expiry)', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake });
    await c.set('k', 'v');
    // memjs's default-arg `{}` may absorb our undefined, so we assert
    // the *behaviour* — `expires` is absent or 0, equivalent to "no TTL".
    const setCall = fake.log.find((l) => l.op === 'set');
    const opts = setCall!.args[2] as { expires?: number } | undefined;
    expect(opts === undefined || opts.expires === undefined).toBe(true);
  });

  test('get parses JSON; miss returns None', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake });
    await c.set('k', { hello: 'world' });
    expect((await c.get<{ hello: string }>('k')).toNullable()).toEqual({ hello: 'world' });
    expect((await c.get('absent')).isNone()).toBe(true);
  });

  test('TTL of 0.5s rounds up to 1 second (memcached minimum)', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake });
    await c.set('k', 1, 500);
    const setCall = fake.log.find((l) => l.op === 'set');
    expect((setCall!.args[2] as { expires: number }).expires).toBe(1);
  });
});

describe('MemcachedCache — atomic ops', () => {
  test('setIfAbsent uses memcached ADD; second call returns false', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake });
    expect(await c.setIfAbsent('k', 'v1')).toBe(true);
    expect(await c.setIfAbsent('k', 'v2')).toBe(false);
    const addCalls = fake.log.filter((l) => l.op === 'add');
    expect(addCalls).toHaveLength(2);
  });

  test('incr seeds counter at 1 on first call (initial: 1)', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake });
    expect(await c.incr('rate', 60_000)).toBe(1);
    expect(await c.incr('rate', 60_000)).toBe(2);
    const incCalls = fake.log.filter((l) => l.op === 'increment');
    expect(incCalls).toHaveLength(2);
    expect((incCalls[0]!.args[2] as { initial: number; expires: number }).initial).toBe(1);
    expect((incCalls[0]!.args[2] as { expires: number }).expires).toBe(60);
  });
});

describe('MemcachedCache — keyPrefix', () => {
  test('prefix prepended to every key', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake, keyPrefix: 'app:' });
    await c.set('user:42', { id: 42 });
    expect(fake.store.has('app:user:42')).toBe(true);
    expect((await c.get('user:42')).isSome()).toBe(true);
  });
});

describe('MemcachedCache — failure tolerance', () => {
  test('get swallows transient errors and returns None', async () => {
    const broken: MemcachedClientLike = {
      async get() { throw new Error('econnrefused'); },
      async set() { return true; },
      async add() { return true; },
      async delete() { return true; },
      async increment() { return { value: 0 }; },
      async quit() { /* no-op */ },
    };
    const c = new MemcachedCache({ client: broken });
    expect((await c.get('k')).isNone()).toBe(true);
  });

  test('incr propagates errors (atomicity required)', async () => {
    const broken: MemcachedClientLike = {
      async get() { return { value: null }; },
      async set() { return true; },
      async add() { return true; },
      async delete() { return true; },
      async increment() { throw new Error('boom'); },
      async quit() { /* no-op */ },
    };
    const c = new MemcachedCache({ client: broken });
    await expect(c.incr('k')).rejects.toThrow();
  });
});

describe('MemcachedCache — close', () => {
  test('close calls quit on the client', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake });
    await c.set('k', 1);
    await c.close();
    expect(fake.log.some((l) => l.op === 'quit')).toBe(true);
  });
});

describe('MemcachedCache — mget / mset (#14)', () => {
  test('mget falls back to parallel GETs (memjs has no native MGET)', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake });
    await c.set('a', 1);
    await c.set('b', 'two');
    const got = await c.mget<unknown>(['a', 'b', 'missing']);
    expect(got.get('a')).toBe(1);
    expect(got.get('b')).toBe('two');
    expect(got.has('missing')).toBe(false);
    // Three GET calls — one per input key — even though only two had values.
    const gets = fake.log.filter((l) => l.op === 'get');
    expect(gets).toHaveLength(3);
  });

  test('mset falls back to parallel SETs with the shared TTL', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake });
    await c.mset(new Map([['a', 1], ['b', 2]] as const), 3_000);
    const sets = fake.log.filter((l) => l.op === 'set');
    expect(sets).toHaveLength(2);
    // ttlMs=3000 → expires=3 seconds (ceil + 1s floor).
    for (const s of sets) {
      const opts = s.args[2] as { expires?: number } | undefined;
      expect(opts?.expires).toBe(3);
    }
  });

  test('mget honours the keyPrefix', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake, keyPrefix: 'app:' });
    await c.set('a', 1);
    await c.mget(['a', 'b']);
    // Of the three gets (one from set's verification path? no — just
    // two from mget itself), each must carry the prefixed key.
    const mgetCalls = fake.log
      .filter((l) => l.op === 'get')
      .slice(-2);                       // skip the set's audit-noise
    expect(mgetCalls.map((l) => l.args[0])).toEqual(['app:a', 'app:b']);
  });

  test('mset on empty Map is a no-op', async () => {
    const fake = new FakeMemcached();
    const c = new MemcachedCache({ client: fake });
    await c.mset(new Map());
    expect(fake.log.filter((l) => l.op === 'set')).toHaveLength(0);
  });

  test('mset rejects bogus ttlMs', async () => {
    const c = new MemcachedCache({ client: new FakeMemcached() });
    await expect(c.mset(new Map([['a', 1]]), 0)).rejects.toThrow(/ttlMs/);
    await expect(c.mset(new Map([['a', 1]]), -5)).rejects.toThrow(/ttlMs/);
  });
});
