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
 * All three backends run this suite.  Redis and Memcached are not
 * stateless the way InMemoryCache is, so their factories construct a
 * *fresh* mock client per call — `beforeEach` invokes the factory once
 * per test, which is what keeps the runs isolated.  See the `— contract`
 * describe block in each backend's test file for the shape.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Cache } from '../../../src/cache/Cache.js';
import { acquireLock } from '../../../src/cache/CacheLock.js';
import { sleep } from '../../util/AwaitCondition.js';

export type CacheContractSpec = {
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
};

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
      // The elapsed time IS the assertion: 50 ms outlasts the 30 ms TTL, and every
      // backend expires lazily, so there is no event to poll for.
      await sleep(50);
      expect((await cache.get('k')).isNone()).toBe(true);
    });
  }

  test(`${spec.name} contract: setIfAbsent — first writer wins, second is rejected`, async () => {
    expect(await cache.setIfAbsent('k', 'first')).toBe(true);
    expect(await cache.setIfAbsent('k', 'second')).toBe(false);
    expect((await cache.get<string>('k')).toNullable()).toBe('first');
  });

  test(`${spec.name} contract: setIfAbsent — first writer wins under contention`, async () => {
    // The sequential test above passes even for a `get`-then-`set`
    // implementation, so it does not actually pin the atomicity the
    // interface promises.  This one does: every call suspends at its
    // first `await` before reaching the backend, so all 100 are in
    // flight together and a check-then-act implementation would let
    // several observe the key absent and all report `true`.
    const contenders = 100;
    const results = await Promise.all(
      Array.from({ length: contenders }, (_, i) => cache.setIfAbsent('lock', `writer-${i}`, 30_000)),
    );

    expect(results.filter((won) => won)).toHaveLength(1);
    // ...and the survivor in the cache is the caller that was told it won.
    const winner = results.indexOf(true);
    expect((await cache.get<string>('lock')).toNullable()).toBe(`writer-${winner}`);
  });

  test(`${spec.name} contract: incr seeds at 1 and counts up`, async () => {
    expect(await cache.incr('counter')).toBe(1);
    expect(await cache.incr('counter')).toBe(2);
    expect(await cache.incr('counter')).toBe(3);
  });

  test(`${spec.name} contract: acquireLock — exactly one of N concurrent callers holds it`, async () => {
    const contenders = 100;
    const attempts = await Promise.all(
      Array.from({ length: contenders }, () => acquireLock(cache, 'lock:job', 30_000)),
    );
    expect(attempts.filter((attempt) => attempt.isSome())).toHaveLength(1);
  });

  test(`${spec.name} contract: acquireLock — release readmits the next caller`, async () => {
    const first = await acquireLock(cache, 'lock:job', 30_000);
    expect(first.isSome()).toBe(true);
    expect((await acquireLock(cache, 'lock:job', 30_000)).isNone()).toBe(true);

    if (!first.isSome()) throw new Error('unreachable — asserted above');
    expect(await first.value.release()).toBe(true);
    expect((await acquireLock(cache, 'lock:job', 30_000)).isSome()).toBe(true);
  });

  test(`${spec.name} contract: acquireLock — a lapsed holder cannot release the new owner`, async () => {
    const first = await acquireLock(cache, 'lock:job', 30_000);
    if (!first.isSome()) throw new Error('first acquire must succeed');

    // Stand in for the first holder overrunning its TTL: the entry it
    // wrote is gone while it still believes it holds the lock.
    await cache.delete('lock:job');
    const second = await acquireLock(cache, 'lock:job', 30_000);
    expect(second.isSome()).toBe(true);

    // The token check is what stops the stale holder from evicting the
    // new owner mid-critical-section — and reports the overrun.
    expect(await first.value.release()).toBe(false);
    expect((await cache.get('lock:job')).isSome()).toBe(true);
  });

  test(`${spec.name} contract: acquireLock — release is idempotent`, async () => {
    const lock = await acquireLock(cache, 'lock:job', 30_000);
    if (!lock.isSome()) throw new Error('acquire must succeed');
    expect(await lock.value.release()).toBe(true);
    expect(await lock.value.release()).toBe(false);
  });

  test(`${spec.name} contract: acquireLock rejects a non-positive TTL`, async () => {
    await expect(acquireLock(cache, 'lock:job', 0)).rejects.toThrow();
    await expect(acquireLock(cache, 'lock:job', -5)).rejects.toThrow();
  });
}
