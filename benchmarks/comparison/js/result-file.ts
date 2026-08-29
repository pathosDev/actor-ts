/**
 * The on-disk result format every arm writes and `report.ts` reads.
 *
 * One file per framework x runtime, committed under `results/`.  Committing
 * them is the point: a benchmark whose output lives only in a terminal
 * scrollback cannot be re-read, diffed against the next release, or checked by
 * anyone who did not run it.  #1177 is about precisely that absence.
 *
 * The two fields that matter most are `expectedOperations` and
 * `completedOperations`.  Everything else is a measurement; those two are the
 * evidence that the measurement was of real work.  `report.ts` refuses to
 * render a row where they differ — see `arm.ts` for how the JavaScript side
 * observes them, and `../README.md` for why (#1027).
 *
 * This module is deliberately free of any actor-ts import: the cross-language
 * runners produce the same shape by hand, so the schema has to be readable as
 * a specification rather than as a consequence of one implementation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScenarioName } from './workload.js';
import type { EnvironmentBlock, RuntimeIdentity } from './environment.js';

/**
 * Bumped when the shape changes incompatibly.  `report.ts` refuses a file it
 * does not recognise rather than silently reading absent fields as zero,
 * because a zero in a throughput table reads as a measurement.
 */
export const RESULT_SCHEMA_VERSION = 1;

/** Which framework produced the numbers, at which version, under which licence. */
export type FrameworkIdentity = {
  readonly name: string;
  readonly version: string;
  readonly language: string;
  /**
   * SPDX-style licence identifier.  Carried because a reader comparing
   * frameworks is usually also choosing one, and because at least one
   * neighbouring project ships under terms that restrict production use —
   * a fact that belongs next to its throughput figure, not three clicks away.
   */
  readonly license: string;
};

/** One measured row: a scenario at one parameterisation, on one arm. */
export type ScenarioResult = {
  readonly scenario: ScenarioName;
  readonly case: string;
  readonly unit: string;
  readonly iterations: number;
  readonly opsPerIteration: number;
  /** Unmeasured iterations run first — published so a row states its own warmup. */
  readonly warmupIterations: number;
  readonly totalNs: number;
  readonly opsPerSecond: number;
  /**
   * Spread of `opsPerSecond` across the rounds this row averages.
   *
   * Published because the row is a mean: without it, a figure whose rounds
   * disagreed by a third looks exactly as confident as one whose rounds agreed
   * to a percent.  Absent (or 0) for a single-round file, where there is no
   * spread to report.
   */
  readonly opsPerSecondStddev?: number;
  readonly perOperationNs: number;
  readonly meanNs: number;
  readonly stddevNs: number;
  readonly minNs: number;
  readonly maxNs: number;
  readonly p50Ns: number;
  readonly p95Ns: number;
  readonly p99Ns: number;
  /** What the harness was told the iteration would do. */
  readonly expectedOperations: number;
  /** What the system under test was observed to actually do. */
  readonly completedOperations: number;
  /**
   * Process RSS change across the measured window.  Present for the
   * JavaScript arms only: comparing a JavaScript heap against a JVM or CLR
   * heap measures the collector's appetite, not the framework's footprint.
   */
  readonly rssDeltaBytes?: number;
  /**
   * A caveat that travels with the row into every published table — used
   * wherever a framework has no exact equivalent of the operation and the
   * nearest thing was measured instead.
   */
  readonly notes?: string;
};

/** A scenario this framework cannot express, and why. */
export type SkippedScenario = {
  readonly scenario: ScenarioName;
  readonly case?: string;
  readonly reason: string;
};

/** The complete contents of one `results/*.json`. */
export type ComparisonResultFile = {
  readonly schemaVersion: number;
  readonly framework: FrameworkIdentity;
  readonly runtime: RuntimeIdentity;
  readonly environment: EnvironmentBlock;
  readonly scenarios: ReadonlyArray<ScenarioResult>;
  readonly skippedScenarios: ReadonlyArray<SkippedScenario>;
  /**
   * How many interleaved rounds this file averages.
   *
   * Absent or 1 means a single round, which on any machine that is not
   * otherwise idle is a coin toss: measured spreads of 15-30 % between
   * consecutive rounds are ordinary.  Anything published should say which
   * it is — and `opsPerSecondStddev` says how far those rounds disagreed.
   */
  readonly rounds?: number;
};

/** Directory holding the committed result files. */
export const RESULTS_DIRECTORY = join(import.meta.dirname ?? '.', '..', 'results');

/**
 * Per-round files, before they are averaged.  Kept out of `results/` (and out
 * of git) because they are working data: the published artefact is the mean
 * over them, and committing every round would bury it.
 */
export const ROUNDS_DIRECTORY = join(RESULTS_DIRECTORY, '.rounds');

/**
 * `<framework>-<runtime>.json`, lower-cased and punctuation-free.
 *
 * The runtime is part of the name because the same framework measured on two
 * runtimes is two results, and a file name that hides that would let the
 * second overwrite the first.
 */
export function resultFileName(framework: FrameworkIdentity, runtime: RuntimeIdentity): string {
  const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug(framework.name)}-${slug(runtime.name)}.json`;
}

/**
 * Write one result file.
 *
 * With a `round`, it lands in `results/.rounds/` under a round-suffixed name
 * and is merged later; without one it is the published file directly.
 */
export function writeResultFile(file: ComparisonResultFile, round?: number): string {
  const directory = round === undefined ? RESULTS_DIRECTORY : ROUNDS_DIRECTORY;
  const base = resultFileName(file.framework, file.runtime);
  const name = round === undefined ? base : base.replace(/\.json$/, `-r${round}.json`);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return path;
}
