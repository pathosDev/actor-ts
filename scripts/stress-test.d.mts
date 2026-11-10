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
   * The seed bun shuffled this run with, when the order was randomised.
   * Attached by the driver rather than by {@link collectRun}, which reads the
   * report and not the log.
   */
  readonly seed?: number | undefined;
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
  /** The runs it failed in, each named once however many testcases carried it. */
  readonly failedRuns: readonly number[];
  /**
   * Failing testcases in total, which exceeds `failedRuns.length` when one run
   * reported this identity more than once — a hook timeout collapsing a block,
   * a `test.each` row, a retry.  Kept apart from the run count because
   * conflating them is what made an offender vanish from both tables (#1359).
   */
  readonly failureCount: number;
};

/** The verdict over all runs, per {@link aggregate}. */
export type AggregatedRuns = {
  /** The number of runs *requested*, which is not the number that reported. */
  readonly runs: number;
  readonly greenRuns: number;
  readonly runsTimedOut: readonly number[];
  readonly runsWithoutReport: readonly number[];
  readonly runsRedWithoutFailures: readonly number[];
  /**
   * Runs that reported failing tests which no offender accounts for.  Empty by
   * construction; computed so the verdict can say "something escaped the
   * identity map" instead of quietly getting smaller.
   */
  readonly unexplainedRedRuns: readonly number[];
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
  /** Shuffle test order in each child run, to surface order dependence. */
  readonly randomize: boolean;
  /** Fix the shuffle's seed.  Setting it implies {@link StressOptions.randomize}. */
  readonly seed: number | undefined;
  readonly filters: readonly string[];
};

/**
 * One offender as `summary.json` records it — an {@link Offender} with its
 * bucket written down.
 *
 * `consistent` exists so a reader does not re-derive the classification from
 * `failedRuns.length`, which would be a second copy of a rule that lives in
 * {@link aggregate} and free to disagree with it (#1506).
 */
export type SummaryOffender = Offender & { readonly consistent: boolean };

/**
 * The document `summary.json` holds — the harness's contract with
 * `scripts/nightly-flake-report.mjs`, and with a reader comparing two nights.
 *
 * Typed here because it is read by another program.  The version of this shape
 * that lived only in the reader's imagination is what #1506 was.
 */
export type SummaryDocument = {
  readonly generatedAt: string;
  readonly bunVersion: string | null;
  readonly runs: number;
  readonly greenRuns: number;
  readonly filters: readonly string[];
  readonly randomized: boolean;
  readonly totalExecuted: number;
  readonly totalFailures: number;
  readonly runTimeoutMs: number;
  readonly runsTimedOut: readonly number[];
  readonly runsWithoutReport: readonly number[];
  readonly runsRedWithoutFailures: readonly number[];
  readonly unexplainedRedRuns: readonly number[];
  readonly runsDetail: readonly {
    readonly index: number;
    readonly status: number | null;
    readonly durationMs: number;
    readonly executed: number;
    readonly skipped: number;
    readonly failures: number;
    readonly timedOut: boolean;
    readonly reportMissing: boolean;
    readonly seed: number | null;
  }[];
  readonly offenders: readonly SummaryOffender[];
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
export function bunArgumentsFor(options: StressOptions): string[];
export function seedOf(log: string): number | undefined;
export function summaryDocument(input: {
  readonly aggregated: AggregatedRuns;
  readonly options: StressOptions;
  readonly results: readonly CollectedRun[];
  readonly bunVersion?: string | null;
}): SummaryDocument;
