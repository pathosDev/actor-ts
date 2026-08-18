/**
 * Collapses several interleaved measurement rounds into one publishable file
 * per arm, by taking the **median row** for every scenario.
 *
 * This exists because a single round is not a measurement on any machine that
 * is not otherwise idle, and the machines these benchmarks actually run on
 * never are.  Measured here across five consecutive rounds on an otherwise
 * ordinary desktop: nact's ask rate varied by 2 %, actor-ts's by 15 %, and
 * XState's by 34 % — while the *ordering* of the three was identical in every
 * round.  Publishing one arbitrary round would have put a 34 % coin toss in a
 * table that readers will quote to three significant figures.
 *
 * Two decisions worth keeping:
 *
 *  - **Median, not mean.**  A round disturbed by something else on the machine
 *    is an outlier, and the mean carries outliers into the published number
 *    while the median discards them.
 *  - **A real row, never a synthesised one.**  The median row is one round's
 *    actual measurement, carried across whole — throughput, percentiles, ΔRSS
 *    and completion counts all from the same run.  Averaging the columns
 *    separately would produce a row where the p99 belongs to one round and the
 *    throughput to another, which is a number no execution ever produced.
 *    With an even round count this takes the lower-middle row for the same
 *    reason: interpolating would invent one.
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

/**
 * The median row by throughput, carried across whole.
 *
 * Ties and even counts both resolve to the lower-middle element, so the result
 * is always a row some round actually produced.
 */
function medianScenario(rows: ReadonlyArray<ScenarioResult>): ScenarioResult {
  const sorted = [...rows].sort((a, b) => a.opsPerSecond - b.opsPerSecond);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
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
      return medianScenario(sameCase);
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
