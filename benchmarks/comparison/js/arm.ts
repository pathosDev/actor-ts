/**
 * Runs one framework's arm through the shared harness and writes its result
 * file.
 *
 * Every JavaScript arm goes through here, which is the whole point: the
 * warmup, the clock, the percentile maths and the completion accounting are
 * then literally the same code for actor-ts and for every framework it is
 * measured against.  Only the four `run()` bodies differ.  That is a much
 * stronger claim than "we used the same methodology", and it is available
 * only on this side of the comparison — the cross-language runners mirror
 * this protocol by hand and say so.
 *
 * ## Completion accounting
 *
 * An arm's `run()` does not return `void` like a plain `BenchmarkSpec`; it
 * returns **how many operations the system actually completed**.  That
 * signature difference is the entire defence against the failure that has
 * already produced one published figure roughly 10x too high (#1027) and one
 * memory row measuring a tenth of its label (#972), and that this repo's two
 * spawn benchmarks still exhibit in a third form (#1204).
 *
 * It is enforced twice, deliberately:
 *
 *  1. **Per call, by throwing.**  A shortfall fails the run immediately, with
 *     the two numbers in the message.  This catches the common case and works
 *     under smoke mode's single unwarmed iteration.
 *  2. **In the result file, as data.**  `completedOperations` is derived from
 *     what was observed rather than from what was requested, so `report.ts`
 *     can re-check it — which is what actually matters for the hand-mirrored
 *     cross-language runners, where this module's guarantees do not reach.
 */
import { runGroup, type BenchmarkResult, type BenchmarkSpec } from '../../lib/harness.js';
import { captureEnvironment, detectRuntime } from './environment.js';
import {
  RESULT_SCHEMA_VERSION,
  writeResultFile,
  type FrameworkIdentity,
  type ScenarioResult,
  type SkippedScenario,
} from './result-file.js';
import type { WorkloadCase } from './workload.js';

/**
 * One measured case of one arm.
 *
 * `run` is a method rather than a function-typed property because this is a
 * contract an arm implements, not a data shape it fills in.
 */
export interface ArmCase {
  /** Which row of the shared workload this implements. */
  readonly workload: WorkloadCase;
  /** A caveat that must travel with the published number, if any. */
  readonly notes?: string;
  /** Runs once before warmup. */
  setup?(): Promise<void> | void;
  /**
   * Performs one iteration and returns **the number of operations the system
   * was observed to complete** — not the number requested.  Returning the
   * requested count without checking defeats the entire apparatus.
   */
  run(): Promise<number> | number;
  /** Runs after every iteration, warmup included.  Excluded from `p50`/`p99`. */
  teardown?(): Promise<void> | void;
}

/** Everything needed to measure and publish one framework. */
export interface ArmDefinition {
  readonly framework: FrameworkIdentity;
  readonly cases: ReadonlyArray<ArmCase>;
  /** Scenarios this framework cannot express, with the reason. */
  readonly skipped?: ReadonlyArray<SkippedScenario>;
  /** Tear down whatever `setup` built — actor systems, sockets, pools. */
  shutdown?(): Promise<void> | void;
}

/**
 * Smoke mode collapses every case to one unwarmed iteration.  The numbers it
 * produces measure the JIT, so they must never reach `results/` — a smoke run
 * that overwrote a real measurement would replace data with noise and leave a
 * plausible-looking file behind.  Read once, like the harness does.
 */
const smokeMode = process.env.ACTOR_TS_BENCH_SMOKE === '1';

/**
 * Which round of an interleaved multi-round run this process is.
 *
 * Set by `run-comparison.ts --rounds=N`.  When present the arm writes into
 * `results/.rounds/` and the driver takes the per-row median afterwards;
 * when absent it writes the published file directly.
 */
const roundNumber = ((): number | undefined => {
  const raw = process.env.ACTOR_TS_COMPARISON_ROUND;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
})();

/** Per-case tally of what the system under test was seen to do. */
type CompletionTally = {
  calls: number;
  completedOperations: number;
};

function toScenarioResult(
  armCase: ArmCase,
  result: BenchmarkResult,
  tally: CompletionTally,
): ScenarioResult {
  // Derived from observation, not from the request: every call contributed
  // its own observed count, so the mean per call times the measured iteration
  // count is what the measured window actually completed.  Warmup calls are
  // in the mean but not in `result.iterations`, which is correct — they are
  // the same work, just untimed.
  const completedPerCall = tally.calls === 0 ? 0 : tally.completedOperations / tally.calls;

  return {
    scenario: armCase.workload.scenario,
    case: armCase.workload.case,
    unit: result.unit,
    iterations: result.iterations,
    opsPerIteration: result.opsPerIteration,
    totalNs: result.totalNs,
    opsPerSecond: result.opsPerSec,
    perOperationNs: result.perOpNs,
    meanNs: result.iterationStats.mean,
    stddevNs: result.iterationStats.stddev,
    minNs: result.iterationStats.min,
    maxNs: result.iterationStats.max,
    p50Ns: result.iterationStats.p50,
    p95Ns: result.iterationStats.p95,
    p99Ns: result.iterationStats.p99,
    expectedOperations: result.totalOps,
    completedOperations: Math.round(completedPerCall * result.iterations),
    rssDeltaBytes: result.rssDeltaBytes,
    ...(armCase.notes === undefined ? {} : { notes: armCase.notes }),
  };
}

/**
 * Measure every case of one arm, print the table, and — outside smoke mode —
 * write the result file.
 */
export async function runArm(arm: ArmDefinition): Promise<void> {
  const runtime = detectRuntime();
  const label = `comparison · ${arm.framework.name} (${runtime.name} ${runtime.version})`;

  const tallies = arm.cases.map((): CompletionTally => ({ calls: 0, completedOperations: 0 }));

  const specs: BenchmarkSpec[] = arm.cases.map((armCase, index) => ({
    name: `${armCase.workload.scenario} · ${armCase.workload.case}`,
    unit: armCase.workload.unit,
    iterations: armCase.workload.iterations,
    opsPerIteration: armCase.workload.opsPerIteration,
    setup: armCase.setup?.bind(armCase),
    teardown: armCase.teardown?.bind(armCase),
    run: async (): Promise<void> => {
      const completed = await armCase.run();
      const tally = tallies[index]!;
      tally.calls++;
      tally.completedOperations += completed;
      if (completed !== armCase.workload.opsPerIteration) {
        throw new Error(
          `${arm.framework.name} / ${armCase.workload.scenario} / ${armCase.workload.case}: `
          + `completed ${completed} of ${armCase.workload.opsPerIteration} operations. `
          + 'A comparison row may not be published for work that did not happen (#1027).',
        );
      }
    },
  }));

  let results: BenchmarkResult[];
  try {
    results = await runGroup(label, specs);
  } finally {
    await arm.shutdown?.();
  }

  const scenarios = arm.cases.map((armCase, index) =>
    toScenarioResult(armCase, results[index]!, tallies[index]!));

  if (smokeMode) {
    console.log(
      `\n  smoke mode — ${scenarios.length} case(s) executed, results NOT written `
      + '(one unwarmed iteration measures the JIT, not the framework)',
    );
    return;
  }

  const path = writeResultFile({
    schemaVersion: RESULT_SCHEMA_VERSION,
    framework: arm.framework,
    runtime,
    environment: captureEnvironment(),
    scenarios,
    skippedScenarios: arm.skipped ?? [],
  }, roundNumber);
  console.log(`\n  wrote ${path}`);
}
