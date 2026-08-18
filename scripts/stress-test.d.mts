/**
 * The flake harness's importable surface, typed for its own tests (#290).
 *
 * `scripts/stress-test.mjs` is plain ESM JavaScript and the repository compiles
 * with `allowJs` off, so a `.ts` test cannot import it without a declaration to
 * resolve.  This file is that declaration and nothing more — it adds no
 * behaviour and is not shipped (`package.json`'s `files` publishes `dist/`
 * only).
 *
 * It is hand-written, which means it can drift from the script.  Two things
 * bound the risk: `skipLibCheck` means nothing here is checked in isolation, so
 * the only thing that gives these shapes value is
 * `tests/unit/ci/StressHarnessAggregation.test.ts` reading real values through
 * them — a field renamed in the script and not here fails that test on the
 * value, not on the type.  And the surface is deliberately the *pure* half of
 * the harness: no `runOnce`, no `runAll`, nothing that spawns.  The spawning
 * half is covered end-to-end instead, by
 * `tests/unit/ci/StressHarnessClassification.test.ts` and
 * `tests/unit/ci/StressHarnessWatchdog.test.ts`, because a stub child would let
 * a watchdog that never fires pass.
 */

/**
 * A test's coordinates in one run's JUnit report.  `suite` is the JUnit
 * `classname`, which bun fills with the innermost `describe` name and leaves
 * empty for a top-level `test`.
 */
export type ReportedTestCase = {
  readonly file: string;
  readonly suite: string;
  readonly name: string;
};

/** What one run's report says, per {@link parseReport}. */
export type ParsedReport = {
  /** Test cases that ran, whether they passed or failed. Skips are not in it. */
  readonly executed: number;
  readonly skipped: number;
  readonly failures: readonly ReportedTestCase[];
};

/**
 * The `<testsuites>` root element's own totals.  A field is `undefined` when
 * the attribute is absent or not a finite number; the whole value is
 * `undefined` when the root element itself could not be found.
 */
export type ReportTotals = {
  readonly tests: number | undefined;
  readonly failures: number | undefined;
  readonly skipped: number | undefined;
};

/** What `runOnce` observed about one child process, before its report is read. */
export type RunOutcome = {
  readonly index: number;
  /** The child's exit code, or `null` when it was killed or never started. */
  readonly status: number | null;
  readonly spawnError?: Error | undefined;
  readonly timedOut: boolean;
  readonly durationMs: number;
};

/** A {@link RunOutcome} with its report folded in, per {@link collectRun}. */
export type CollectedRun = RunOutcome & ParsedReport & {
  /**
   * True when the run produced no readable report *and* did not time out — the
   * two are kept disjoint on purpose, because a hang and a truncated report
   * have different causes and different fixes.
   */
  readonly reportMissing: boolean;
  readonly summary?: ReportTotals | undefined;
};

/** One test that failed at least once, with the runs it failed in. */
export type Offender = ReportedTestCase & {
  readonly identity: string;
  readonly failedRuns: readonly number[];
};

/** The verdict over all runs, per {@link aggregate}. */
export type AggregatedRuns = {
  /** The number of runs *requested*, which is not the number that reported. */
  readonly runs: number;
  readonly greenRuns: number;
  readonly runsTimedOut: readonly number[];
  readonly runsWithoutReport: readonly number[];
  readonly runsRedWithoutFailures: readonly number[];
  readonly totalExecuted: number;
  readonly totalFailures: number;
  readonly flaky: readonly Offender[];
  readonly consistent: readonly Offender[];
};

/** The harness's own options, per {@link parseArguments}. */
export type StressOptions = {
  readonly runs: number;
  readonly concurrency: number;
  readonly maximumFlakyTests: number;
  readonly runTimeoutMs: number;
  readonly reportDirectory: string;
  readonly skipQuarantined: boolean;
  readonly filters: readonly string[];
};

export function parseArguments(argv: readonly string[]): StressOptions;
export function unescapeXml(value: string): string;
export function attributesOf(source: string): Map<string, string>;
export function normalisePath(value: string): string;
export function identityOf(testCase: ReportedTestCase): string;
export function parseReport(xml: string): ParsedReport;
export function parseSummary(xml: string): ReportTotals | undefined;
export function collectRun(result: RunOutcome, reportPath: string): CollectedRun;
export function aggregate(results: readonly CollectedRun[], runs: number): AggregatedRuns;
export function render(aggregated: AggregatedRuns, options: StressOptions): string;
