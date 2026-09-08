import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { PROPERTY_RUNS, PROPERTY_SEED } from '../../setup/property-seed.js';

/**
 * **Every property test runs against a pinned seed.**
 *
 * A generative test with a random seed can fail on one run and pass on the
 * next, which is the definition of a flake — and the worst kind, because the
 * counterexample lives only in the run log and is gone when that rotates.
 * #1372 measured the state this replaces: no `seed`, no `endOnFailure`, no
 * `configureGlobal` and no regression corpus anywhere across ~52 `fc.assert`
 * call sites.
 *
 * The policy is applied by a `bunfig.toml` preload, which is two things that
 * can drift apart — a registration and a file. The last assertion here is the
 * one that matters most: it asks **fast-check itself** what seed it is running
 * with, so a preload that was registered and never loaded fails rather than
 * quietly restoring the random default.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const PRELOAD_PATH = 'tests/setup/property-seed.ts';

const bunfig = readFileSync(join(REPOSITORY_ROOT, 'bunfig.toml'), 'utf8');
const preloadSource = readFileSync(join(REPOSITORY_ROOT, PRELOAD_PATH), 'utf8');

describe('the property seed policy is wired, not just written', () => {
  test('bunfig.toml preloads the seed file', () => {
    expect(
      bunfig,
      `bunfig.toml no longer preloads ${PRELOAD_PATH}, so every property test is `
      + 'back on a random seed and a failing case cannot be reproduced once the '
      + 'run log ages out (#1372).',
    ).toContain(`./${PRELOAD_PATH}`);
  });

  test('fast-check is actually running with that seed', () => {
    // The half a file check cannot see. A preload named in bunfig.toml but not
    // loaded — a renamed file, a `bun test` invoked with a different config —
    // leaves fast-check on its random default while the assertion above still
    // passes.
    const configured = fc.readConfigureGlobal();
    expect(
      configured.seed,
      'fast-check is not running with the pinned seed, so the preload in '
      + 'bunfig.toml is registered but not taking effect. Every property test is '
      + 'on a random seed right now.',
    ).toBe(PROPERTY_SEED);
    expect(configured.numRuns).toBe(PROPERTY_RUNS);
    expect(
      configured.endOnFailure,
      'endOnFailure is off, so a failing property buries its first '
      + 'counterexample — the one being copied into an example test — under the '
      + 'rest of the run.',
    ).toBe(true);
  });

  test('the seed is a literal constant, not something derived at run time', () => {
    // A seed from the clock, the environment or `Math.random` would satisfy
    // "a seed is set" while reproducing nothing, which is the state #1372
    // describes rather than the one it asks for.
    expect(typeof PROPERTY_SEED).toBe('number');
    expect(Number.isInteger(PROPERTY_SEED)).toBe(true);
    for (const derived of ['Date.now', 'Math.random', 'process.env', 'performance.now']) {
      expect(
        preloadSource.includes(derived),
        `${PRELOAD_PATH} derives its seed from ${derived}, which reproduces nothing. `
        + 'The point of the pin is that the same arbitrary value is used on every '
        + 'machine and every run.',
      ).toBe(false);
    }
  });

  test('the global floor is no lower than what the property files used to ask for', () => {
    // The three large property files set `numRuns: 120` themselves and the rest
    // took fast-check's default of 100. A global below either would quietly
    // reduce coverage while looking like configuration.
    expect(PROPERTY_RUNS).toBeGreaterThanOrEqual(120);
  });
});
