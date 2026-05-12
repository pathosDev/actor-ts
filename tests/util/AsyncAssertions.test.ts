import { describe, expect, test } from 'bun:test';
import { assertCompletesWithin, assertDoesNotCompleteWithin } from './AsyncAssertions.js';

describe('assertCompletesWithin', () => {
  test('passes when promise resolves within budget', async () => {
    const fast = Promise.resolve(42);
    const v = await assertCompletesWithin(fast, 100, 'fast');
    expect(v).toBe(42);
  });

  test('rejects with a descriptive error on timeout', async () => {
    const slow = new Promise<number>(() => { /* never resolves */ });
    await expect(assertCompletesWithin(slow, 50, 'should-timeout'))
      .rejects.toThrow(/should-timeout: did not complete within 50ms \(waited \d+ms\)/);
  });

  test('propagates the original error when the inner promise rejects', async () => {
    const bad = Promise.reject(new Error('inner failure'));
    await expect(assertCompletesWithin(bad, 100, 'never-runs')).rejects.toThrow(/inner failure/);
  });

  test('does not leak a timer after success (timer cleared)', async () => {
    // Hard to assert directly; surrogate is that many fast calls
    // don't exhaust the event-loop or leave dangling handles.
    for (let i = 0; i < 100; i++) {
      await assertCompletesWithin(Promise.resolve(i), 50, `iter-${i}`);
    }
  });

  test('rejects on invalid ms', async () => {
    await expect(assertCompletesWithin(Promise.resolve(1), 0, 'x'))
      .rejects.toThrow(/must be a positive finite number/);
    await expect(assertCompletesWithin(Promise.resolve(1), Number.NaN, 'x'))
      .rejects.toThrow(/must be a positive finite number/);
  });
});

describe('assertDoesNotCompleteWithin', () => {
  test('returns normally after ms when promise stays pending', async () => {
    const pending = new Promise<number>(() => { /* never */ });
    const t0 = performance.now();
    await assertDoesNotCompleteWithin(pending, 30, 'expected-pending');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(25);
  });

  test('rejects when promise settles early', async () => {
    const fast = new Promise<number>((resolve) => setTimeout(() => resolve(42), 10));
    await expect(assertDoesNotCompleteWithin(fast, 100, 'should-not-settle'))
      .rejects.toThrow(/settled within \d+ms/);
  });

  test('rejection also counts as "settled early"', async () => {
    const bad = new Promise<number>((_, reject) => setTimeout(() => reject(new Error('boom')), 10));
    await expect(assertDoesNotCompleteWithin(bad, 100, 'rejects-early'))
      .rejects.toThrow(/settled within/);
  });
});
