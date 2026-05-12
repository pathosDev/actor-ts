/**
 * Backend-agnostic contract test suite for `Cache` implementations.
 *
 * Every backend that implements the `Cache` interface should satisfy
 * the same observable behaviour for the core operations.  This
 * suite exercises that contract so each backend's `*.test.ts` can
 * focus on backend-specific concerns (mock-client wiring, protocol
 * edge cases) without re-asserting the basic interface.
 *
 * Usage from a per-backend test file:
 *
 *   import { describe } from 'bun:test';
 *   import { runCacheContractTests } from './_Contract.js';
 *   import { InMemoryCache } from '../../../src/cache/InMemoryCache.js';
 *
 *   describe('InMemoryCache', () => {
 *     runCacheContractTests({
 *       name: 'InMemoryCache',
 *       factory: async () => new InMemoryCache(),
 *     });
 *   });
 *
 * The factory is async so backends needing client setup (Redis,
 * Memcached) can do it lazily.  Cleanup is handled per-test via the
 * suite's internal afterEach — no resources leaked.
 *
 * NOTE: Adding new backends (e.g. Redis/Memcached parameterised over
 * mock clients) requires a small adapter to feed a fresh mock client
 * per test — they're not stateless like InMemoryCache.  Document the
 * pattern in the backend's per-file test once added.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Cache } from '../../../src/cache/Cache.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

export interface CacheContractSpec {
  /** Display name for the backend.  Used as the test-name prefix. */
  readonly name: string;
  /** Fresh-cache factory.  Called once per test for isolation. */
  readonly factory: () => Promise<Cache>;
  /**
   * Whether this backend honours sub-second TTLs precisely.  If false,
   * the TTL test asserts only that the key eventually expires, not
   * the timing window (Memcached only supports second-granular TTLs).
   * Default: true.
   */
  readonly supportsSubSecondTtl?: boolean;
}

/**
 * Run the contract test suite against a backend factory.  Call from
 * inside a `describe(...)` block.
 */
export function runCacheContractTests(spec: CacheContractSpec): void {
  const supportsSubSecondTtl = spec.supportsSubSecondTtl ?? true;
  let cache: Cache;

  beforeEach(async () => {
    cache = await spec.factory();
  });

  afterEach(async () => {
    if (typeof cache.close === 'function') await cache.close();
  });

  test(`${spec.name} contract: set + get round-trip`, async () => {
    await cache.set('k', { hello: 'world' });
    const result = await cache.get<{ hello: string }>('k');
    expect(result.toNullable()).toEqual({ hello: 'world' });
  });

  test(`${spec.name} contract: get on missing key returns None`, async () => {
    expect((await cache.get('absent')).isNone()).toBe(true);
  });

  test(`${spec.name} contract: delete removes a key`, async () => {
    await cache.set('k', 'v');
    expect((await cache.get('k')).toNullable()).toBe('v');
    await cache.delete('k');
    expect((await cache.get('k')).isNone()).toBe(true);
  });

  test(`${spec.name} contract: set rejects non-positive TTL`, async () => {
    await expect(cache.set('k', 1, 0)).rejects.toThrow();
    await expect(cache.set('k', 1, -5)).rejects.toThrow();
  });

  if (supportsSubSecondTtl) {
    test(`${spec.name} contract: set with sub-second TTL expires`, async () => {
      await cache.set('k', 'temp', 30);
      expect((await cache.get('k')).toNullable()).toBe('temp');
      await sleep(50);
      expect((await cache.get('k')).isNone()).toBe(true);
    });
  }

  test(`${spec.name} contract: setIfAbsent — first writer wins, second is rejected`, async () => {
    expect(await cache.setIfAbsent('k', 'first')).toBe(true);
    expect(await cache.setIfAbsent('k', 'second')).toBe(false);
    expect((await cache.get<string>('k')).toNullable()).toBe('first');
  });

  test(`${spec.name} contract: incr seeds at 1 and counts up`, async () => {
    expect(await cache.incr('counter')).toBe(1);
    expect(await cache.incr('counter')).toBe(2);
    expect(await cache.incr('counter')).toBe(3);
  });
}
