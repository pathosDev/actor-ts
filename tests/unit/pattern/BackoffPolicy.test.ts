/**
 * Pure unit tests for the backoff-policy primitives.  These functions
 * are stateless and don't touch any actor — keep the tests trivial and
 * deterministic via the `random` injection point.
 */
import { describe, expect, test } from 'bun:test';
import {
  exponentialBackoff,
  linearBackoff,
} from '../../../src/pattern/BackoffPolicy.js';

/** Returns 0.5 always — the no-jitter midpoint, so `1 ± randomFactor` ≡ `1`. */
const MID_RANDOM = (): number => 0.5;
/** Returns 0 always — the lower jitter bound: `1 - randomFactor`. */
const MIN_RANDOM = (): number => 0;
/** Returns ε close to 1 — the upper jitter bound: `1 + randomFactor`. */
const MAX_RANDOM = (): number => 0.999_999;

describe('exponentialBackoff', () => {
  test('doubles per restart, clamps at maxMs', () => {
    const policy = exponentialBackoff({ minMs: 100, maxMs: 800, randomFactor: 0, random: MID_RANDOM });
    expect(policy.delayFor(0)).toBe(100);
    expect(policy.delayFor(1)).toBe(200);
    expect(policy.delayFor(2)).toBe(400);
    expect(policy.delayFor(3)).toBe(800);
    expect(policy.delayFor(4)).toBe(800);   // clamped
    expect(policy.delayFor(20)).toBe(800);  // still clamped
  });

  test('jitter is bounded by ± randomFactor of the un-jittered delay', () => {
    const policy = exponentialBackoff({ minMs: 1000, maxMs: 1000, randomFactor: 0.2 });
    for (let i = 0; i < 200; i++) {
      const delay = policy.delayFor(0);
      expect(delay).toBeGreaterThanOrEqual(800);  // 1000 × (1 - 0.2)
      expect(delay).toBeLessThanOrEqual(1200);    // 1000 × (1 + 0.2)
    }
  });

  test('randomFactor=0 makes the policy fully deterministic', () => {
    const policy = exponentialBackoff({ minMs: 250, maxMs: 5_000, randomFactor: 0 });
    expect(policy.delayFor(0)).toBe(250);
    expect(policy.delayFor(3)).toBe(2_000);
  });

  test('jitter low/high bounds match expectations exactly', () => {
    const opts = { minMs: 1000, maxMs: 1000, randomFactor: 0.5 };
    const lo = exponentialBackoff({ ...opts, random: MIN_RANDOM });
    const hi = exponentialBackoff({ ...opts, random: MAX_RANDOM });
    expect(lo.delayFor(0)).toBe(500);          // 1000 × (1 - 0.5)
    expect(hi.delayFor(0)).toBeCloseTo(1500, 0); // 1000 × (1 + 0.5)
  });

  test('handles huge restartCount without overflowing to Infinity', () => {
    const policy = exponentialBackoff({ minMs: 100, maxMs: 60_000, randomFactor: 0, random: MID_RANDOM });
    expect(policy.delayFor(1000)).toBe(60_000);
  });

  test('treats negative restartCount as 0', () => {
    const policy = exponentialBackoff({ minMs: 100, maxMs: 1000, randomFactor: 0, random: MID_RANDOM });
    expect(policy.delayFor(-3)).toBe(100);
  });

  test('rejects nonsensical options', () => {
    expect(() => exponentialBackoff({ minMs: -1, maxMs: 1000 })).toThrow(/minMs/);
    expect(() => exponentialBackoff({ minMs: 100, maxMs: 50 })).toThrow(/maxMs/);
    expect(() => exponentialBackoff({ minMs: 100, maxMs: 1000, randomFactor: 1.5 })).toThrow(/randomFactor/);
    expect(() => exponentialBackoff({ minMs: Infinity, maxMs: 1000 })).toThrow();
  });
});

describe('linearBackoff', () => {
  test('grows by step per restart, clamped at maxMs', () => {
    const policy = linearBackoff({ minMs: 100, maxMs: 500, stepMs: 100, randomFactor: 0, random: MID_RANDOM });
    expect(policy.delayFor(0)).toBe(100);
    expect(policy.delayFor(1)).toBe(200);
    expect(policy.delayFor(4)).toBe(500);
    expect(policy.delayFor(10)).toBe(500);
  });

  test('rejects negative step', () => {
    expect(() => linearBackoff({ minMs: 100, maxMs: 1000, stepMs: -1 })).toThrow(/stepMs/);
  });
});
