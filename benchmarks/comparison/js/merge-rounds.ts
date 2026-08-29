/**
 * Collapses several interleaved measurement rounds into one publishable file
 * per arm, by **averaging every metric** across the rounds and recording how
 * far they spread.
 *
 * This exists because a single round is not a measurement on any machine that
 * is not otherwise idle, and the machines these benchmarks actually run on
 * never are.  Measured across five consecutive rounds on an ordinary desktop:
 * one arm's ask rate varied by 2 %, another's by 15 %, a third's by 34 % —
 * while the *ordering* of the three was identical in every round.
 *
 * ## Why the mean, and what it costs
 *
 * This used to publish the median row, which threw away everything but one
 * round.  The mean uses all of them, which is the stronger reason: with ten
 * rounds, reporting one of them discards 90 % of the evidence.
 *
 * The trade-off is real and worth stating rather than hiding.  A round
 * disturbed by something else on the machine is discarded by a median and
 * carried by a mean.  Two things keep that honest:
 *
 *  - **`opsPerSecondStddev` is published next to every figure**, so a row
 *    whose rounds disagreed is visible as exactly that instead of averaging
 *    into a confident-looking number.  A reader can see when a gap is smaller
 *    than the noise that produced it.
 *  - **Averaging is per metric, not per row.**  Each published metric is the
 *    mean of that metric across rounds, so the row as a whole is a summary
 *    rather than a single observation.  `minNs` and `maxNs` are the exception:
 *    averaging extremes would blunt exactly what they exist to show, so they
 *    are the minimum of the minima and the maximum of the maxima.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROUNDS_DIRECTORY,
  writeResultFile,
  type ComparisonResultFile,
  type ScenarioResult,
} from './result-file.js';

/** Every round's file for one arm, keyed by the arm's published file name. */
function groupRoundsByArm(): Map<string, ComparisonResultFile[]> {
  const grouped = new Map<string, ComparisonResultFile[]>();

  let entries: string[];
  try {
    entries = readdirSync(ROUNDS_DIRECTORY).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return grouped;
  }

  for (const entry of entries) {
    const armKey = entry.replace(/-r\d+\.json$/, '.json');
    const content = JSON.parse(readFileSync(join(ROUNDS_DIRECTORY, entry), 'utf8')) as ComparisonResultFile;
    const bucket = grouped.get(armKey);
    if (bucket === undefined) grouped.set(armKey, [content]);
    else bucket.push(content);
  }

  return grouped;
}

const mean = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

/** Population standard deviation — these rounds are the whole set, not a sample of one. */
function standardDeviation(values: ReadonlyArray<number>): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

/**
 * One published row from the same scenario measured in every round.
 *
 * The counts (`iterations`, `opsPerIteration`, `warmupIterations`,
 * `expectedOperations`, `completedOperations`) are identical in every round by
 * construction — `report.ts` fails the run otherwise — so they are carried
 * across rather than averaged, which would only introduce rounding.
 */
function averageScenario(rows: ReadonlyArray<ScenarioResult>): ScenarioResult {
  const first = rows[0]!;
  const pick = (select: (row: ScenarioResult) => number): number[] => rows.map(select);
  const rssDeltas = rows
    .map((row) => row.rssDeltaBytes)
    .filter((value): value is number => value !== undefined);

  return {
    ...first,
    totalNs: mean(pick((r) => r.totalNs)),
    opsPerSecond: mean(pick((r) => r.opsPerSecond)),
    opsPerSecondStddev: standardDeviation(pick((r) => r.opsPerSecond)),
    perOperationNs: mean(pick((r) => r.perOperationNs)),
    meanNs: mean(pick((r) => r.meanNs)),
    stddevNs: mean(pick((r) => r.stddevNs)),
    // The extremes stay extremes: the smallest iteration seen anywhere, and
    // the largest.  A mean of minima describes nothing that happened.
    minNs: Math.min(...pick((r) => r.minNs)),
    maxNs: Math.max(...pick((r) => r.maxNs)),
    p50Ns: mean(pick((r) => r.p50Ns)),
    p95Ns: mean(pick((r) => r.p95Ns)),
    p99Ns: mean(pick((r) => r.p99Ns)),
    ...(rssDeltas.length === 0 ? {} : { rssDeltaBytes: mean(rssDeltas) }),
  };
}

/**
 * How many rounds each arm actually completed, keyed by framework name.
 *
 * Arms are not required to reach the same count. One that dies partway leaves
 * the rounds it did finish, and those still merge — so the driver needs a way
 * to say which arms fell short rather than presenting a mixed set as uniform
 * (#1326).
 */
export function roundsPerArm(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [, rounds] of groupRoundsByArm()) {
    const last = rounds[rounds.length - 1];
    if (last !== undefined) counts.set(last.framework.name, rounds.length);
  }
  return counts;
}

/**
 * Merge every arm's rounds into `results/`, returning the written paths.
 *
 * The scenario list comes from the last round, so an arm that gained a case
 * mid-run publishes what it measures now rather than an intersection nobody
 * asked for; a case missing from some rounds simply has fewer samples.
 */
export function mergeRounds(): string[] {
  const written: string[] = [];

  for (const [, rounds] of groupRoundsByArm()) {
    const last = rounds[rounds.length - 1]!;

    const scenarios = last.scenarios.map((reference) => {
      const sameCase = rounds
        .map((round) => round.scenarios.find(
          (s) => s.scenario === reference.scenario && s.case === reference.case,
        ))
        .filter((s): s is ScenarioResult => s !== undefined);
      return averageScenario(sameCase);
    });

    written.push(writeResultFile({
      schemaVersion: last.schemaVersion,
      framework: last.framework,
      runtime: last.runtime,
      environment: last.environment,
      scenarios,
      skippedScenarios: last.skippedScenarios,
      rounds: rounds.length,
    }));
  }

  return written;
}
