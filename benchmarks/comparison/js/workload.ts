/**
 * The workload every comparison arm runs — the single source of truth for
 * what "the same benchmark" means across frameworks (#27).
 *
 * A comparison is only a comparison if every side does the identical amount
 * of work.  That sounds obvious and is the easiest thing in the exercise to
 * get wrong: the arms live in different files, some of them in different
 * languages, and a batch size that drifts in one runner leaves every
 * individual row looking entirely plausible while the table as a whole
 * becomes fiction.  So the numbers live here, once.
 *
 * The JavaScript arms import this module.  The cross-language runners cannot,
 * so they mirror these values as literals with a pointer back to this file —
 * and `report.ts` cross-checks every arm's reported `opsPerIteration` against
 * these before it renders anything, which is what turns "please keep them in
 * sync" into something that fails loudly instead of silently.
 *
 * The counts deliberately match the equivalent suites one level up
 * (`single-node/actor-creation.ts`, `tell-throughput.ts`,
 * `ask-throughput.ts`).  That makes the actor-ts arm cross-checkable against
 * a benchmark that has been in the repo for months: if this suite's actor-ts
 * row and that suite's row disagree, the apparatus is wrong, not the
 * framework.
 */

/** The four operations every framework is measured on. */
export type ScenarioName =
  | 'spawn'
  | 'tell-throughput'
  | 'ask-round-trip'
  | 'ping-pong';

/** One row of the published table: a scenario at one parameterisation. */
export type WorkloadCase = {
  readonly scenario: ScenarioName;
  /** Row label — unique within a scenario. */
  readonly case: string;
  /** What one operation is, for the throughput column: `actor`, `msg`, … */
  readonly unit: string;
  /** Measured iterations.  One iteration = `opsPerIteration` operations. */
  readonly iterations: number;
  /** Batch size, so throughput reads per-operation rather than per-batch. */
  readonly opsPerIteration: number;
};

/**
 * Every case, in publication order.
 *
 * `iterations x opsPerIteration` is the total work per arm, and it is chosen
 * so a full run of one arm stays in the tens of seconds: a comparison nobody
 * re-runs is a comparison that silently goes stale.
 */
export const WORKLOAD: ReadonlyArray<WorkloadCase> = [
  // Spawn is batched rather than one-per-iteration because a single
  // spawn+stop is short enough that the harness's own per-iteration
  // bookkeeping would be a visible share of it — and because the
  // cross-language arms have to route spawning through an actor anyway,
  // where the batch amortises the one round trip that costs.
  { scenario: 'spawn',           case: 'batch=100',   unit: 'actor',    iterations: 100,   opsPerIteration: 100 },

  // Two batch sizes, because the interesting difference between frameworks
  // here is how throughput *scales* with queue depth, not its value at one
  // depth.  A framework that wins at 1k and loses at 10k is telling you
  // something about its scheduler that neither row says alone.
  { scenario: 'tell-throughput', case: 'batch=1k',    unit: 'msg',      iterations: 100,   opsPerIteration: 1_000 },
  { scenario: 'tell-throughput', case: 'batch=10k',   unit: 'msg',      iterations: 30,    opsPerIteration: 10_000 },

  // Sequential and depth-1 on purpose: this row is round-trip *latency*, so
  // p50/p99 are the point and throughput is a derived convenience.  A
  // pipelined variant would answer a different question and is deliberately
  // not folded in here.
  { scenario: 'ask-round-trip',  case: 'sequential',  unit: 'ask',      iterations: 5_000, opsPerIteration: 1 },

  // Two actors volleying: the one scenario where the framework's scheduler
  // is the entire subject, with no user code, no payload and no allocation
  // worth speaking of between the hops.
  { scenario: 'ping-pong',       case: 'exchanges=10k', unit: 'exchange', iterations: 20,  opsPerIteration: 10_000 },
];

/**
 * Look up one case, failing loudly when it does not exist.
 *
 * Arms index into the workload by name, so a typo would otherwise surface as
 * `undefined` iterations — i.e. as the harness's default of 1 000, silently
 * measuring something nobody asked for.
 */
export function workloadCase(scenario: ScenarioName, caseName: string): WorkloadCase {
  const found = WORKLOAD.find((w) => w.scenario === scenario && w.case === caseName);
  if (!found) {
    throw new Error(
      `Unknown workload case "${scenario}/${caseName}".  Known: `
      + WORKLOAD.map((w) => `${w.scenario}/${w.case}`).join(', '),
    );
  }
  return found;
}

/** Every case of one scenario, in publication order. */
export function scenarioCases(scenario: ScenarioName): ReadonlyArray<WorkloadCase> {
  return WORKLOAD.filter((w) => w.scenario === scenario);
}
