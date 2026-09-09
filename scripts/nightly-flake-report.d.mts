/**
 * The nightly flake report's importable surface, typed for its own tests.
 *
 * `scripts/nightly-flake-report.mjs` is plain ESM JavaScript and the repository
 * compiles with `allowJs` off, so a `.ts` test cannot import it without a
 * declaration to resolve.  This file is that declaration and nothing more — no
 * behaviour, and not shipped (`package.json`'s `files` publishes `dist/` only).
 * Same arrangement, and the same reason, as `scripts/coverage-gate.d.mts`.
 *
 * Hand-written, so it can drift from the script.  What keeps it honest is
 * `tests/unit/ci/NightlyFlakeReport.test.ts` reading real values through it: a
 * field renamed in the script and not here fails that test on the value rather
 * than on the type.
 *
 * The surface is the pure half — parsing, the green predicate and the rendering.
 * The driver, which writes files and prints workflow outputs, is absent
 * deliberately: it is exercised by running the script.
 */

/**
 * One offender, as `scripts/stress-test.mjs` records it in `summary.json`.
 *
 * The authority for this shape is `summaryDocument` in that script, not this
 * file: a declaration is never checked against the module it describes
 * (`skipLibCheck`), so what keeps the two honest is
 * `tests/unit/ci/NightlyFlakeReport.test.ts` building its fixtures by calling
 * the writer.  Before #1506 this file declared two fields nothing wrote, in
 * agreement with a reader that read them and a guard that invented them.
 */
export type StressOffender = {
  /** `file :: describe > test`, the identity failures are aggregated under. */
  readonly identity: string;
  /** Which run indices this identity failed in — counted once per run. */
  readonly failedRuns: readonly number[];
  /**
   * Whether it failed in *every* run — broken rather than flaky.  Optional
   * because an artifact written before #1506 has no such flag, and for those
   * {@link offendersOf} falls back to comparing `failedRuns.length` with `runs`.
   */
  readonly consistent?: boolean;
};

/**
 * A night's `summary.json`, as the stress harness writes it.
 *
 * Every field beyond `runs` and `greenRuns` is optional here because a summary
 * from an older harness is still worth reporting: a report that threw on a
 * missing key would turn "the night is unreadable" into "the report job is
 * red", which is a worse place for the same information.
 */
export type StressSummary = {
  readonly runs: number;
  readonly greenRuns: number;
  readonly runsTimedOut?: readonly number[];
  readonly runsWithoutReport?: readonly number[];
  readonly runsRedWithoutFailures?: readonly number[];
  readonly unexplainedRedRuns?: readonly number[];
  readonly totalExecuted?: number;
  readonly totalFailures?: number;
  /**
   * Every test that failed at least once, flaky and broken together —
   * {@link offendersOf} does the splitting.  Absent only in a summary this
   * reader does not understand, which the report says out loud rather than
   * rendering as "no test was named".
   */
  readonly offenders?: readonly StressOffender[];
};

/**
 * What {@link readSummary} returns when there is nothing to read.
 *
 * Opaque on purpose: a caller cannot construct one, so the only way to get a
 * missing summary is to actually fail to read one — which is what stops "no
 * verdict" from being confused with "green".
 */
export type MissingSummary = { readonly __missing: unique symbol };

/** One job's contribution to the report. */
export type ReportSection = {
  readonly label: string;
  readonly summary: StressSummary | MissingSummary;
};

/** The rendered report: whether to file, and what to file. */
export type Report = {
  readonly red: boolean;
  readonly title: string;
  readonly body: string;
};

/** Marker every issue title carries, so the workflow can find the open one. */
export const ISSUE_TITLE_PREFIX: string;

/** Split a `label:path` argument on its first colon. */
export function parseSummaryArgument(value: string): { label: string; path: string };

/** Read one `summary.json`, or a {@link MissingSummary} when it is absent or unparseable. */
export function readSummary(path: string): StressSummary | MissingSummary;

/**
 * Was this night clean?
 *
 * Stricter than `greenRuns === runs`: a run that never exited, wrote no report,
 * exited non-zero with no failing test, or whose failures no offender explains
 * each disqualify it — and a missing summary is never green.
 */
export function isGreen(summary: StressSummary | MissingSummary): boolean;

/**
 * Split a summary's `offenders` into broken and flaky, or `undefined` when it
 * carries no offender list at all.
 *
 * The `undefined` is load-bearing: "this summary names nobody" and "this
 * reader could not find the list" are opposite facts, and #1506 rendered the
 * second as the first for every red night.
 */
export function offendersOf(summary: StressSummary): {
  readonly consistent: readonly StressOffender[];
  readonly flaky: readonly StressOffender[];
} | undefined;

/** Render every section into one issue body. */
export function buildReport(
  sections: readonly ReportSection[],
  options?: { readonly runUrl?: string; readonly bunVersion?: string },
): Report;
