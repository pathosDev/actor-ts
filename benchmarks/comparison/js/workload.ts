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

/** The five operations every framework is measured on. */
export type ScenarioName =
  | 'spawn'
  | 'tell-throughput'
  | 'ask-round-trip'
  | 'ping-pong'
  | 'parallel-workload';

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
  /**
   * Unmeasured iterations run first, stated explicitly rather than left to the
   * harness default.
   *
   * The default is `min(100, iterations / 10)`, which for the batched cases
   * works out at **three** warmup iterations for `tell batch=10k` and **two**
   * for ping-pong.  That is fine for a JavaScript arm and actively unfair to a
   * JVM one, which needs thousands of executions before its optimising
   * compiler produces steady-state code.  Measured: raising warmup from 100 to
   * 3 000 moved the JVM arm's ask rate by 33 % and its tell rate by 11 %,
   * while the JavaScript arms barely moved.
   *
   * So warmup is part of the workload definition, identical across arms and
   * generous enough that no runtime is measured mid-compilation.  It costs a
   * few seconds per arm.
   */
  readonly warmupIterations: number;
  /**
   * `parallel-workload` only: independent actors, one message each per
   * iteration (so `opsPerIteration === actorCount`), and the CPU work every
   * message carries — see {@link workRounds}.  Absent on every other row.
   */
  readonly actorCount?: number;
  readonly workIterationsPerMessage?: number;
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
  { scenario: 'spawn',           case: 'batch=100',   unit: 'actor',    iterations: 100,   opsPerIteration: 100,     warmupIterations: 50 },

  // Two batch sizes, because the interesting difference between frameworks
  // here is how throughput *scales* with queue depth, not its value at one
  // depth.  A framework that wins at 1k and loses at 10k is telling you
  // something about its scheduler that neither row says alone.
  { scenario: 'tell-throughput', case: 'batch=1k',    unit: 'msg',      iterations: 100,   opsPerIteration: 1_000,   warmupIterations: 50 },
  { scenario: 'tell-throughput', case: 'batch=10k',   unit: 'msg',      iterations: 30,    opsPerIteration: 10_000,  warmupIterations: 15 },

  // Sequential and depth-1 on purpose: this row is round-trip *latency*, so
  // p50/p99 are the point and throughput is a derived convenience.  A
  // pipelined variant would answer a different question and is deliberately
  // not folded in here.
  { scenario: 'ask-round-trip',  case: 'sequential',  unit: 'ask',      iterations: 5_000, opsPerIteration: 1,       warmupIterations: 2_000 },

  // Two actors volleying: the one scenario where the framework's scheduler
  // is the entire subject, with no user code, no payload and no allocation
  // worth speaking of between the hops.
  { scenario: 'ping-pong',       case: 'exchanges=10k', unit: 'exchange', iterations: 20,  opsPerIteration: 10_000, warmupIterations: 10 },

  // The one scenario multithreading exists for (#1565): sixty-four independent
  // actors — well above any core count in the table, so distribution is
  // measured rather than luck — each handed one message per iteration that
  // carries real CPU work.  The JVM and .NET arms spread them over their
  // default schedulers; actor-ts places them on worker threads through
  // `actor-ts.parallelism.workers = auto`, exactly as an operator would;
  // nact and XState run them on one thread and say so.  `light` is a few
  // microseconds of work per message, where the thread boundary costs more
  // than it saves; `heavy` is where it pays.
  { scenario: 'parallel-workload', case: 'load=light', unit: 'msg', iterations: 200, opsPerIteration: 64, warmupIterations: 100, actorCount: 64, workIterationsPerMessage: 5_000 },
  { scenario: 'parallel-workload', case: 'load=heavy', unit: 'msg', iterations: 50,  opsPerIteration: 64, warmupIterations: 20,  actorCount: 64, workIterationsPerMessage: 100_000 },
];

/**
 * The CPU work of `parallel-workload`, language-neutral and not optimisable
 * away: `rounds` of xorshift32 from a seed, every round feeding the next,
 * the final state returned.  Every cross-language arm mirrors this loop bit
 * for bit — 32-bit lanes with logical right shifts are the same on the JVM's
 * `int`, .NET's `uint` and JavaScript's `>>> 0` — and every reply carries the
 * result, so a JIT that elided the loop, or an arm that skipped a message,
 * produces a checksum the report refuses.
 */
export function workRounds(seed: number, rounds: number): number {
  let x = seed >>> 0;
  for (let i = 0; i < rounds; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
  }
  return x >>> 0;
}

/**
 * The seed of one message: a function of the actor and the message index
 * (warmup and measured calls counted together, from zero), never zero
 * because xorshift is stuck there.  Mirrored by the cross-language arms.
 */
export function workSeed(actorIndex: number, messageIndex: number): number {
  const seed = (Math.imul(actorIndex + 1, 0x9E3779B1) ^ Math.imul(messageIndex + 1, 0x85EBCA77)) >>> 0;
  return seed === 0 ? 1 : seed;
}

/**
 * What a `parallel-workload` arm has to report as its checksum: the sum,
 * modulo 2^32, of every reply over every call — warmup and measured — so
 * `report.ts` can recompute it from this file alone and refuse a row whose
 * work did not happen.
 */
export function expectedChecksum(workload: WorkloadCase): number {
  const actors = workload.actorCount ?? 0;
  const rounds = workload.workIterationsPerMessage ?? 0;
  const calls = workload.warmupIterations + workload.iterations;
  let total = 0;
  for (let message = 0; message < calls; message++) {
    for (let actor = 0; actor < actors; actor++) {
      total = (total + workRounds(workSeed(actor, message), rounds)) >>> 0;
    }
  }
  return total;
}

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
