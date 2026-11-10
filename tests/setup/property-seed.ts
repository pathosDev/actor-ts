/**
 * Pin fast-check's seed for the whole test process.
 *
 * ## Why the seed is pinned rather than random
 *
 * A generative test with a random seed is a test that can fail on one run and
 * pass on the next.  That is the definition of a flake, and it is the worst
 * kind: the failing case exists only in the run log, so once the log ages out
 * the counterexample is gone and nobody can reproduce what happened.  #1372
 * measured the state this replaces — no `seed`, no `endOnFailure`, no
 * `configureGlobal`, and no regression corpus anywhere.
 *
 * Pinning trades away one thing and the trade is worth stating.  A fixed seed
 * explores the same cases every run, so the suite stops finding *new*
 * counterexamples on its own.  That is fine, because it was never really doing
 * that: a case found by an unlucky nightly and then lost to log rotation was
 * never turned into a regression test, so the exploration produced red builds
 * rather than knowledge.  New cases now come from raising {@link PROPERTY_RUNS}
 * or changing {@link PROPERTY_SEED} — a decision somebody makes, in a diff.
 *
 * ## When a property does fail
 *
 * fast-check shrinks and prints the minimal counterexample.  **Add it as a
 * plain example test beside the property**, with the issue number, before
 * fixing anything.  The property proves the law; the example is what stops the
 * specific case coming back, and it survives the log.
 *
 * ## Mechanism
 *
 * `fc.configureGlobal` rather than an options object at each of the ~52
 * `fc.assert` call sites: one place to read, one place to change, and a new
 * property file gets the policy without its author having to know about it.
 * Loaded through `bunfig.toml`'s `preload`, so it applies to `bun test` however
 * it is invoked — `tests/unit/ci/PropertySeedPolicy.test.ts` checks both halves
 * are still wired together.
 */
import fc from 'fast-check';

/**
 * The seed every property runs against.
 *
 * The value is arbitrary and that is the point — what matters is that it is the
 * *same* arbitrary value on every machine and every run.  Change it in a commit
 * when you want the properties to explore elsewhere, and expect that commit to
 * be the one that finds something.
 */
export const PROPERTY_SEED = 1_424;

/**
 * Cases per property.
 *
 * The three large property files already asked for 120 and the rest took
 * fast-check's default of 100; 120 everywhere is the larger of the two, so no
 * property gets *less* exploration than it had.  A file that wants more still
 * says so in its own `fc.assert` options — a global is a floor here, not a
 * ceiling.
 */
export const PROPERTY_RUNS = 120;

fc.configureGlobal({
  seed: PROPERTY_SEED,
  numRuns: PROPERTY_RUNS,
  // Stop at the first failure rather than continuing to shrink other cases.
  // The first counterexample is the one being copied into an example test, and
  // a wall of further failures buries it.
  endOnFailure: true,
});
