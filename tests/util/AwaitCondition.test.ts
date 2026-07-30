import { describe, expect, test } from 'bun:test';
import { awaitCondition, sleep } from './AwaitCondition.js';
import { minimumElapsedMs } from './TimerTolerance.js';

describe('awaitCondition', () => {
  test('returns without sleeping when the condition already holds', async () => {
    const t0 = performance.now();
    await awaitCondition(() => true, { intervalMs: 50, label: 'already true' });
    // The pre-sleep check is the whole point: a generous interval must not
    // be paid by a condition that is true on entry.
    expect(performance.now() - t0).toBeLessThan(50);
  });

  test('resolves once a background step flips the condition', async () => {
    let done = false;
    setTimeout(() => { done = true; }, 20);
    await awaitCondition(() => done, { label: 'background step finished' });
    expect(done).toBe(true);
  });

  test('awaits an async predicate', async () => {
    let count = 0;
    const predicate = async (): Promise<boolean> => {
      await Promise.resolve();
      return ++count >= 3;
    };
    await awaitCondition(predicate, { intervalMs: 1, label: 'third poll' });
    expect(count).toBe(3);
  });

  test('throws a diagnostic error naming the label on timeout', async () => {
    await expect(awaitCondition(() => false, { timeoutMs: 30, intervalMs: 1, label: 'never happens' }))
      .rejects.toThrow(/awaitCondition: never happens did not become true within 30ms \(waited \d+ms, \d+ polls\)/);
  });

  test('waits at least the timeout before failing', async () => {
    const timeoutMs = 30;
    const t0 = performance.now();
    await expect(awaitCondition(() => false, { timeoutMs, intervalMs: 1 })).rejects.toThrow();
    // Lower bound only, a full timer quantum below the budget — Bun fires a
    // 30ms timer early on Windows (#477); see TimerTolerance.
    expect(performance.now() - t0).toBeGreaterThanOrEqual(minimumElapsedMs(timeoutMs));
  });

  test('propagates a throwing predicate instead of retrying it', async () => {
    let calls = 0;
    const predicate = (): boolean => { calls++; throw new Error('broken check'); };
    await expect(awaitCondition(predicate, { timeoutMs: 500 })).rejects.toThrow(/broken check/);
    expect(calls).toBe(1);
  });

  test('rejects invalid timings', async () => {
    await expect(awaitCondition(() => false, { timeoutMs: 0 }))
      .rejects.toThrow(/timeoutMs must be a positive finite number/);
    await expect(awaitCondition(() => false, { intervalMs: Number.NaN }))
      .rejects.toThrow(/intervalMs must be a positive finite number/);
  });
});

describe('sleep', () => {
  test('resolves after roughly the requested delay', async () => {
    const nominalMs = 30;
    const t0 = performance.now();
    await sleep(nominalMs);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(minimumElapsedMs(nominalMs));
  });
});
