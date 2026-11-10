import { describe, expect, test } from 'bun:test';
import { availableParallelism, resetAvailableParallelismCache } from '../../../src/runtime/Parallelism.js';

/**
 * `availableParallelism()` (#1562, #1440) — the number an `'auto'` worker
 * count resolves to.  The value itself is the machine's, so the assertions
 * are about shape and stability: a positive integer, the same answer twice,
 * and never below what the framework has always fallen back to.
 */
describe('availableParallelism', () => {
  test('answers a positive integer and memoises it', async () => {
    resetAvailableParallelismCache();
    const first = await availableParallelism();
    const second = await availableParallelism();
    expect(Number.isInteger(first)).toBe(true);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  test('agrees with the operating system where it reports a quota-aware count', async () => {
    resetAvailableParallelismCache();
    const os = (await import('node:os')) as { availableParallelism?: () => number };
    const fromOs = os.availableParallelism?.();
    const probed = await availableParallelism();
    if (typeof fromOs === 'number' && fromOs > 0) {
      expect(probed).toBe(fromOs);
    } else {
      // No `os.availableParallelism` on this runtime: the navigator or the
      // conservative floor answers, and both are at least 2 or the true count.
      expect(probed).toBeGreaterThanOrEqual(1);
    }
  });
});
