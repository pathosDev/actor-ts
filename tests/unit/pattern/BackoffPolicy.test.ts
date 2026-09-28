/**
 * Pure unit tests for the backoff-policy primitives.  These functions
 * are stateless and don't touch any actor — keep the tests trivial and
 * deterministic via the `random` injection point.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  applyJitter,
  exponentialBackoff,
  linearBackoff,
} from '../../../src/pattern/BackoffPolicy.js';
import { retry } from '../../../src/pattern/Retry.js';

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
 * Half structural, half behavioural, because neither half alone is the claim.
 * Two *identical* implementations agree on every input, so no draw-count or
 * edge test can tell a shared helper from a freshly pasted one — that part
 * only a structural check sees.  Two *divergent* ones are the thing that
 * actually hurts a caller, and that only a behavioural check sees.  The
 * duplication this guard was written for starts as the first and becomes the
 * second the moment somebody edits one side, which is why both are here.
 *
 * The first version of this guard was structural only, and name-based with it:
 * it asserted the literal `'export function applyJitter('` in one file and the
 * absence of `/function\s+applyJitter\s*\(/` in the other.  Both halves were
 * satisfiable, and were measured to be (#1509 repair):
 *
 *   - the import makes the name `applyJitter` unavailable inside `Retry.ts`,
 *     so the realistic way the copy returns is under *another* name.  Pasting
 *     the body back in as `spreadDelay` and calling it instead of the import,
 *     leaving the now-unused import in place: 144 pass / 0 fail, `bun run
 *     typecheck` exit 0.  Nothing saw it.
 *   - `toContain` reads comments, so the owning declaration could change shape
 *     entirely as long as the literal survived somewhere in the file.
 *
 * What replaced them: the ownership half is answered by *importing* the helper
 * and calling it, which no comment can fake and which does not care whether it
 * is declared as a `function` or a `const`; and the absence half is answered
 * by three independent signatures of the jitter rule itself rather than of its
 * name, over `Retry.ts` with its comments removed.  A copy has to evade all
 * three, and a copy-paste of the body trips all three.
 *
 * The two halves were measured to be independently load-bearing, which is the
 * whole reason for keeping both:
 *
 *   - the `spreadDelay` paste above — structural red, behavioural green,
 *     because an identical copy is by definition identical;
 *   - a copy inlined with the floor dropped, `* 2 - 1` rewritten as
 *     `(random() - 0.5)` and the factor renamed, so that none of the three
 *     signatures matches — structural green, behavioural red, 1 fail.
 *
 * Neither half would have caught both.  What still gets past both is a copy
 * that is identical *and* stays identical, which is the case that costs a
 * caller nothing until somebody edits one side — at which point it is the
 * second bullet.
 *
 * Scoped to the two files the claim is about.  `CircuitBreaker.ts` holds a
 * third copy with its own note; folding that one in is a change to a file this
 * guard has no opinion about, and widening the check to the directory would
 * make it fail for a reason it is not testing.
 */
describe('applyJitter has one implementation — #1509', () => {
  const sourceOf = (file: string): string =>
    readFileSync(join(import.meta.dir, '..', '..', '..', 'src', 'pattern', file), 'utf8');

  /**
   * Block comments, then line comments.  Deliberately simple — there are no
   * regex literals and no `//` inside a string in either file — and the
   * landmark assertion below is what stops a stripper that ate too much from
   * making every absence check pass for free.
   */
  const codeOnly = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  /**
   * The jitter rule's three signatures, none of which is its name.
   *
   * `FLOORED_MULTIPLIER` is `Math.max(0, … (1 + …`, the floor wrapped around
   * the multiplier — distinctive enough that `Math.max(0, restartCount)`, which
   * appears twice in `BackoffPolicy.ts`, does not match it.  `SIGN_MAPPING` is
   * the `[0, 1) → [-1, 1)` remap.  `SCALED_BY_FACTOR` is `randomFactor` used as
   * a multiplicand, which a copy keeping the parameter name cannot avoid and
   * which no caller of the helper needs.
   */
  const FLOORED_MULTIPLIER = /Math\.max\(\s*0\s*,[^;\n]*\(\s*1\s*\+/;
  const SIGN_MAPPING = /\*\s*2\s*-\s*1/;
  const SCALED_BY_FACTOR = /\*\s*randomFactor|randomFactor\s*\*/;

  test('BackoffPolicy owns the only implementation and Retry imports it', () => {
    // Not a string match: the helper is imported and called.  A literal
    // surviving in a comment cannot satisfy this, and neither declaration
    // form — `export function` or `export const` — is privileged, because
    // which one it is was never the invariant.
    expect(typeof applyJitter).toBe('function');
    expect(applyJitter(100, 0, () => 0.5)).toBe(100);
    expect(applyJitter(100, 0.5, () => 0)).toBe(50);

    const backoffPolicy = codeOnly(sourceOf('BackoffPolicy.ts'));
    // One implementation in the owning file too — a second one here would be
    // the same defect one file over.
    expect(backoffPolicy.match(new RegExp(FLOORED_MULTIPLIER, 'g'))).toHaveLength(1);

    const retrySource = sourceOf('Retry.ts');
    // A relative specifier with the `.js` suffix — the import the build's
    // module resolution actually needs, not just the identifier appearing
    // somewhere in the file.
    expect(retrySource)
      .toMatch(/import\s*\{[^}]*\bapplyJitter\b[^}]*\}\s*from\s*'\.\/BackoffPolicy\.js'/);
  });

  test('Retry carries no second implementation, under any name', () => {
    const retryCode = codeOnly(sourceOf('Retry.ts'));

    // The stripper found the file rather than emptying it.  Without this the
    // three assertions below would pass on an empty string.
    expect(retryCode).toContain('export async function retry');
    // …and it did remove comments, which is what lets those assertions be
    // about code rather than about prose describing the formula — `Retry.ts`
    // spells the rule out in prose in several places and must be allowed to.
    expect(retryCode).not.toContain('/**');
    expect(retryCode).not.toContain('//');

    expect(retryCode).not.toMatch(FLOORED_MULTIPLIER);
    expect(retryCode).not.toMatch(SIGN_MAPPING);
    expect(retryCode).not.toMatch(SCALED_BY_FACTOR);
  });

  /**
   * The half a structural check cannot reach: the two spellings, if there were
   * two, would have to stay equal.
   *
   * `retry`'s requested delay is `applyJitter` composed with two clamps, so
   * with `factor: 1` and no ceiling it *is* the helper's output — for every
   * draw, not just the midpoint.  A copy that diverges by a sign, a floor or
   * an edge fails here whatever it is called; an identical copy does not,
   * which is what the structural test above is for.
   */
  test('the delay retry asks for is the helper, for every draw', async () => {
    const BASE = 1_000;
    const draws = [0, 0.25, 0.5, 0.75, 0.999_999];
    const randomFactors = [0, 0.2, 1];

    for (const randomFactor of randomFactors) {
      for (const draw of draws) {
        const requestedDelays: number[] = [];
        try {
          await retry(async () => { throw new Error('fail'); }, {
            attempts: 3,
            delayMs: BASE,
            factor: 1,
            maxDelayMs: Number.POSITIVE_INFINITY,
            randomFactor,
            random: () => draw,
            sleep: (ms) => { requestedDelays.push(ms); return Promise.resolve(); },
          });
        } catch { /* the factory always fails; the schedule is the subject */ }

        // Two delays for three attempts, and the `if (delay > 0)` guard drops
        // a jitter result of exactly 0 — which `randomFactor: 1` with a draw
        // of 0 produces, and which is therefore part of the contract rather
        // than an exclusion from it.
        const expected = [
          applyJitter(BASE, randomFactor, () => draw),
          applyJitter(BASE, randomFactor, () => draw),
        ].filter(ms => ms > 0);
        expect(requestedDelays).toEqual(expected);
      }
    }
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
