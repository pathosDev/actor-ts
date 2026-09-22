/**
 * Pure unit tests for the backoff-policy primitives.  These functions
 * are stateless and don't touch any actor — keep the tests trivial and
 * deterministic via the `random` injection point.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    const options = { minMs: 1000, maxMs: 1000, randomFactor: 0.5 };
    const lo = exponentialBackoff({ ...options, random: MIN_RANDOM });
    const hi = exponentialBackoff({ ...options, random: MAX_RANDOM });
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

/**
 * The jitter rule has one spelling, and it is this file's (#1509).
 *
 * `Retry.ts` used to carry a byte-for-byte second copy under a JSDoc asserting
 * that "the jitter contract is identical to the primitive's" — a claim about
 * two functions with nothing keeping them equal, and the kind that stays true
 * right up until someone edits one of them.  The reason recorded for the copy
 * argues against calling `exponentialBackoff` (it hardcodes base 2 and throws
 * on an infinite `maxMs`), not against sharing the helper underneath it.
 *
 * Structural rather than behavioural on purpose.  Two identical
 * implementations agree on every input, so no draw-count or edge test can tell
 * a shared helper from a duplicated one — which is exactly why the claim went
 * unchecked.  What a test *can* see is that there is only one declaration.
 *
 * Scoped to the two files the claim is about.  `CircuitBreaker.ts` holds a
 * third copy with its own note; folding that one in is a change to a file this
 * guard has no opinion about, and widening the check to the directory would
 * make it fail for a reason it is not testing.
 */
describe('applyJitter has one implementation — #1509', () => {
  const sourceOf = (file: string): string =>
    readFileSync(join(import.meta.dir, '..', '..', '..', 'src', 'pattern', file), 'utf8');

  test('BackoffPolicy owns it and Retry imports it', () => {
    const backoffPolicy = sourceOf('BackoffPolicy.ts');
    const retry = sourceOf('Retry.ts');

    expect(backoffPolicy).toContain('export function applyJitter(');
    // A relative specifier with the `.js` suffix — the import the build's
    // module resolution actually needs, not just the identifier appearing
    // somewhere in the file.
    expect(retry).toMatch(/import\s*\{[^}]*\bapplyJitter\b[^}]*\}\s*from\s*'\.\/BackoffPolicy\.js'/);
    expect(retry).not.toMatch(/function\s+applyJitter\s*\(/);
  });

  test('the floor is real — an injected random outside [0, 1) cannot go sub-zero', () => {
    // The half of the contract neither caller can reach through its own
    // arithmetic: with `random()` in `[0, 1)` and `randomFactor` in `[0, 1]`
    // the multiplier is never negative, and `retry` additionally drops any
    // non-positive delay at `if (delay > 0)`.  So the `Math.max(0, …)` looked
    // like dead code and deleting it left every test in this directory green
    // — measured.  It is reachable through the one input that is *not*
    // constrained, the injected source itself, which is the seam both public
    // options expose for tests.  `-5` gives a multiplier of `-11`, i.e. a
    // delay of `-1000` ms without the floor.
    const policy = exponentialBackoff({
      minMs: 100,
      maxMs: 100,
      randomFactor: 1,
      random: () => -5,
    });
    expect(policy.delayFor(0)).toBe(0);

    const linear = linearBackoff({
      minMs: 100,
      maxMs: 100,
      stepMs: 0,
      randomFactor: 1,
      random: () => -5,
    });
    expect(linear.delayFor(0)).toBe(0);
  });
});
