import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  ISSUE_TITLE_PREFIX,
  buildReport,
  isGreen,
  offendersOf,
  parseSummaryArgument,
  readSummary,
} from '../../../scripts/nightly-flake-report.mjs';
import {
  aggregate,
  parseReport,
  summaryDocument,
  type CollectedRun,
  type ReportedTestCase,
  type StressOptions,
  type SummaryDocument,
} from '../../../scripts/stress-test.mjs';

/**
 * The nightly measurement has to reach somebody.
 *
 * `nightly-flakes.yml` has measured this suite every night for months and the
 * result reached nobody: both jobs were `continue-on-error`, the verdict went
 * into a step summary and a run annotation, and the workflow said so about
 * itself — *"Nothing accumulates the streak. It is counted by a human reading
 * these annotations, which is the same failure that made the quarantine
 * permanent in the first place."*
 *
 * That was not hypothetical. The exit criterion for the #538 quarantine was
 * fourteen consecutive green nights; it stood at twenty-one before anyone
 * looked, and one of the three suites it was hiding turned out to be a product
 * defect rather than a runner problem (#839).
 *
 * So the report has to get three things right: a green night must not raise an
 * alarm, **a night that produced no verdict must not read as a green one**, and
 * — the one this file was rewritten for — **a night that named offenders must
 * print them**.
 *
 * ## Why every fixture below is built by the writer
 *
 * The first version of this file wrote its own summaries, by hand, with a
 * `flaky` and a `consistent` array. `scripts/stress-test.mjs` has never written
 * either: it writes one `offenders` array. So did the reader's hand-written
 * `.d.mts`, declaring both above a comment claiming they were the harness's
 * shape, and `skipLibCheck` means no compiler ever compared that claim with the
 * module. Three artifacts agreeing with each other and none of them with the
 * program.
 *
 * The first real red night found it: run 34329418185 had three tests failing in
 * **all five** runs, aggregated correctly, written to the artifact correctly —
 * and filed an issue reading *"No test was named by any run"* (#1506).
 *
 * The fix is structural rather than a corrected literal. `summaryDocument` is
 * now an exported pure function, so the document on disk is a value, and every
 * fixture here is produced by calling it and round-tripping it through JSON
 * exactly as `main()` does. A field renamed on the writing side now fails these
 * tests on the value. A fixture typed by hand could not have failed at all,
 * which is precisely what happened.
 */

const scratch = (): string => mkdtempSync(join(tmpdir(), 'nightly-report-'));

/**
 * The harness's options, spelled out rather than parsed.
 *
 * `parseArguments([])` would be the more faithful source and is not used: it
 * reads `ACTOR_TS_STRESS_*` from the environment, so a developer with one
 * exported would silently test a different document. The type annotation is
 * what keeps this honest instead — a renamed option fails `typecheck:dev`.
 */
const OPTIONS: StressOptions = {
  runs: 5,
  concurrency: 1,
  maximumFlakyTests: 0,
  runTimeoutMs: 1_200_000,
  reportDirectory: '.stress',
  randomize: false,
  seed: undefined,
  filters: [],
};

const testCase = (file: string, suite: string, name: string): ReportedTestCase =>
  ({ file, suite, name });

/** A run that reported, with `status` following from whether anything failed. */
const reportedRun = (
  index: number,
  failures: readonly ReportedTestCase[],
  overrides: Partial<CollectedRun> = {},
): CollectedRun => ({
  index,
  status: failures.length === 0 ? 0 : 1,
  timedOut: false,
  durationMs: 278_000,
  executed: 12_244,
  skipped: 18,
  failures,
  reportMissing: false,
  ...overrides,
});

/**
 * The document a night leaves on disk, produced the way the harness produces
 * it: aggregate the runs, render the document, then through `JSON` — which is
 * not ceremony, it is what drops every `undefined` and is therefore the only
 * form the reader ever sees.
 */
const documentFor = (
  results: readonly CollectedRun[],
  runs = results.length,
): SummaryDocument => JSON.parse(JSON.stringify(summaryDocument({
  aggregated: aggregate(results, runs),
  options: OPTIONS,
  results,
  bunVersion: '1.4.0',
})));

/** Five green runs — the shape of a night nobody needs to read. */
const green = documentFor([1, 2, 3, 4, 5].map((index) => reportedRun(index, [])));

const summaryFile = (body: unknown): string => {
  const path = join(scratch(), 'summary.json');
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return path;
};

describe('a night is green only when nothing at all went wrong', () => {
  test('all runs green, no anomalies', () => {
    expect(isGreen(green)).toBe(true);
  });

  test.each([
    ['a failing run', { greenRuns: 4 }],
    ['a run that never exited', { runsTimedOut: [2] }],
    ['a run that wrote no report', { runsWithoutReport: [3] }],
    ['a non-zero exit with no failing test', { runsRedWithoutFailures: [1] }],
    ['a red run no offender explains', { unexplainedRedRuns: [4] }],
  ])('%s is not green', (_label, override) => {
    expect(isGreen({ ...green, ...override })).toBe(false);
  });

  test('a summary that does not exist is not green', () => {
    // The failure this whole report exists for: "the job produced no verdict"
    // and "the job was green" are opposite facts, and the first two nights of
    // this workflow uploaded no artifact at all while nobody noticed.
    expect(isGreen(readSummary(join(scratch(), 'absent.json')))).toBe(false);
  });

  test('a summary that is not JSON is not green either', () => {
    const path = join(scratch(), 'summary.json');
    writeFileSync(path, 'not json at all', 'utf8');
    expect(isGreen(readSummary(path))).toBe(false);
  });
});

describe('the report says which job and why', () => {
  test('an all-green night is not red and says so', () => {
    const report = buildReport([
      { label: 'whole suite', summary: green },
      { label: 'worker suites', summary: green },
    ]);
    expect(report.red).toBe(false);
    expect(report.title).toBe(`${ISSUE_TITLE_PREFIX} all green`);
    expect(report.body).toContain('Every nightly flake job was green.');
  });

  test('a red night names the failing job in the title', () => {
    const report = buildReport([
      { label: 'whole suite', summary: { ...green, greenRuns: 3 } },
      { label: 'worker suites', summary: green },
    ]);
    expect(report.red).toBe(true);
    expect(report.title).toBe(`${ISSUE_TITLE_PREFIX} whole suite`);
  });

  test('offenders are listed with how often they failed, worst first', () => {
    const sometimes = testCase('tests/A.test.ts', 'a suite', 'sometimes');
    const always = testCase('tests/B.test.ts', 'a suite', 'always');
    const report = buildReport([{
      label: 'whole suite',
      summary: documentFor([
        reportedRun(1, [sometimes, always]),
        reportedRun(2, [sometimes, always]),
        reportedRun(3, [always]),
        reportedRun(4, [always]),
        reportedRun(5, [always]),
      ]),
    }]);
    expect(report.body).toContain('**Failed in every run — broken rather than flaky:**');
    expect(report.body).toContain('`tests/B.test.ts :: a suite :: always` — failed 5 of 5');
    expect(report.body).toContain('**Failed in some runs — flaky:**');
    expect(report.body).toContain('`tests/A.test.ts :: a suite :: sometimes` — failed 2 of 5');
  });

  test('a long offender list is capped rather than pasted whole', () => {
    const many = Array.from(
      { length: 30 },
      (_unused, index) => testCase(`tests/T${index}.test.ts`, '', 'fails once'),
    );
    const report = buildReport([{
      label: 'whole suite',
      summary: documentFor([
        reportedRun(1, many),
        ...[2, 3, 4, 5].map((index) => reportedRun(index, [])),
      ]),
    }]);
    expect(report.body).toContain('…and 10 more, in the uploaded report.');
  });

  test('a hang is reported as its own thing, not as a failing test', () => {
    // "The suite stopped making progress" and "a test failed" are different
    // facts, and only one of them names something to go and look at.
    const report = buildReport([{
      label: 'worker suites', summary: { ...green, greenRuns: 2, runsTimedOut: [3] },
    }]);
    expect(report.body).toContain('1 run(s) never exited');
    expect(report.body).toContain('stopped making progress');
  });

  test('a missing summary is reported as harder than a red run, not softer', () => {
    const report = buildReport([
      { label: 'whole suite', summary: readSummary(join(scratch(), 'absent.json')) },
    ]);
    expect(report.red).toBe(true);
    expect(report.body).toContain('**No summary was produced.**');
  });

  test('the run link and bun version are carried when given', () => {
    const report = buildReport(
      [{ label: 'whole suite', summary: green }],
      { runUrl: 'https://example.invalid/run/1', bunVersion: '1.4.0' },
    );
    expect(report.body).toContain('[Run and artifacts](https://example.invalid/run/1)');
    expect(report.body).toContain('bun 1.4.0');
  });

  test('the body keeps the blank lines Markdown needs between blocks', () => {
    // The first version filtered every empty string out of the assembled array,
    // which also removed Markdown's block separators — headings ran straight
    // into the paragraph below them and the list never rendered as one.
    const report = buildReport([{
      label: 'whole suite',
      summary: documentFor([
        reportedRun(1, [testCase('tests/A.test.ts', '', 'once')]),
        ...[2, 3, 4, 5].map((index) => reportedRun(index, [])),
      ]),
    }]);
    const blank = '\n\n';
    expect(report.body).toContain(`### whole suite${blank}- runs:`);
    expect(report.body).toContain(`${blank}**Failed in some runs`);
  });

  test('every report points at the question to ask first', () => {
    // The lesson #839 cost thirteen nights: a repeatedly red suite is a product
    // defect until shown otherwise, not a runner problem.
    const report = buildReport([{ label: 'whole suite', summary: { ...green, greenRuns: 0 } }]);
    expect(report.body).toContain('whether it is a product defect');
  });
});

/**
 * The three failing testcases of nightly run 34329418185, **verbatim** from
 * `run-1.junit.xml`, wrapped in a root element whose totals describe the
 * excerpt rather than the 12 262-test report it came from.
 *
 * A synthetic fixture would not have caught this and did not: the defect was
 * never in parsing a testcase, it was in what happened to a correctly parsed
 * one four steps later. This is here so the regression is anchored to a report
 * that really was produced, with the attributes bun really writes — including
 * the `classname` that is a describe name and the `&#10;` entities in the
 * failure message.
 */
const NIGHTLY_34329418185_EXCERPT = [
  '<testsuites name="bun test" tests="4" assertions="4" failures="3" skipped="0" time="277.973242617">',
  '<testcase name="fastify" classname="the resolved server policy reaches each backend" time="3.005973" file="tests/unit/http/ServerTuningParity.test.ts" line="99" assertions="1">',
  '        <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: true&#10;Received: false&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: true&#10;Received: false&#10;&#10;      at tests/unit/http/ServerTuningParity.test.ts:108:47&#10;</failure>',
  '      </testcase>',
  '<testcase name="express" classname="the resolved server policy reaches each backend" time="3.005931" file="tests/unit/http/ServerTuningParity.test.ts" line="99" assertions="1">',
  '        <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: true&#10;Received: false&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: true&#10;Received: false&#10;&#10;      at tests/unit/http/ServerTuningParity.test.ts:108:47&#10;</failure>',
  '      </testcase>',
  '<testcase name="max-connections closes the connection past the cap" classname="actor-ts.http.server" time="3.005966" file="tests/unit/http/HttpConfigDefaults.test.ts" line="477" assertions="1">',
  '        <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: true&#10;Received: false&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: true&#10;Received: false&#10;&#10;      at tests/unit/http/HttpConfigDefaults.test.ts:483:47&#10;</failure>',
  '      </testcase>',
  '<testcase name="a passing case" classname="something else" time="0.001" file="tests/unit/http/Other.test.ts" line="12" assertions="1" />',
  '</testsuites>',
].join('\n');

describe('the night that filed an empty issue (#1506)', () => {
  /** All five runs of that night, from the one report they all produced. */
  const results = [1, 2, 3, 4, 5].map((index) => {
    const parsed = parseReport(NIGHTLY_34329418185_EXCERPT);
    return reportedRun(index, parsed.failures, {
      executed: parsed.executed, skipped: parsed.skipped,
    });
  });
  const summary = documentFor(results);

  test('the harness classified that night correctly, which is why the issue was wrong', () => {
    // Stated first and deliberately: the aggregate was never at fault. Reading
    // #1506 as an attribution bug and "fixing" the classifier would have
    // changed a component that was right, left the reader wrong, and produced
    // a green test suite over a still-empty issue.
    const aggregated = aggregate(results, 5);
    expect(aggregated.flaky).toEqual([]);
    expect(aggregated.consistent).toHaveLength(3);
    expect(aggregated.unexplainedRedRuns).toEqual([]);
    expect(aggregated.totalFailures).toBe(15);
    expect(aggregated.greenRuns).toBe(0);
  });

  test('the document on disk names all three, with their bucket', () => {
    expect(summary.offenders).toHaveLength(3);
    expect(summary.offenders.every((entry) => entry.consistent)).toBe(true);
  });

  test('the issue body names all three tests', () => {
    const report = buildReport([{ label: 'whole suite', summary }], {
      runUrl: 'https://github.com/pathosDev/actor-ts/actions/runs/34329418185',
    });
    expect(report.red).toBe(true);
    expect(report.body).toContain('**Failed in every run — broken rather than flaky:**');
    for (const identity of [
      'tests/unit/http/ServerTuningParity.test.ts :: the resolved server policy reaches each backend :: fastify',
      'tests/unit/http/ServerTuningParity.test.ts :: the resolved server policy reaches each backend :: express',
      'tests/unit/http/HttpConfigDefaults.test.ts :: actor-ts.http.server :: max-connections closes the connection past the cap',
    ]) {
      expect(report.body).toContain(`\`${identity}\` — failed 5 of 5`);
    }
  });

  test('and no longer claims nobody was named', () => {
    // The exact sentence the real issue carried, over an artifact that named
    // three tests.
    const report = buildReport([{ label: 'whole suite', summary }]);
    expect(report.body).not.toContain('No test was named by any run');
  });
});

describe('the writer and the reader agree on one document', () => {
  const offender = testCase('tests/A.test.ts', 'a suite', 'fails');
  const summary = documentFor([
    reportedRun(1, [offender]),
    ...[2, 3, 4, 5].map((index) => reportedRun(index, [])),
  ]);

  test('the reader finds the offenders the writer wrote', () => {
    const split = offendersOf(summary);
    expect(split?.flaky.map((entry) => entry.identity))
      .toEqual(['tests/A.test.ts :: a suite :: fails']);
    expect(split?.consistent).toEqual([]);
  });

  test('the split comes from the flag the writer set, not from a second rule', () => {
    // `failedRuns.length >= runs` lives in `aggregate` and nowhere else. If the
    // reader re-derived it, this entry — flagged flaky but failing in as many
    // runs as were requested — would come back consistent.
    const contradictory = {
      ...summary,
      runs: 1,
      offenders: [{ identity: 'X', failedRuns: [1], consistent: false }],
    };
    expect(offendersOf(contradictory)?.flaky).toHaveLength(1);
    expect(offendersOf(contradictory)?.consistent).toEqual([]);
  });

  test('an older artifact without the flag still splits, by run count', () => {
    // Written before #1506: no flag, so the comparison is the only thing left.
    // Deriving it is strictly better than dropping the entry, which is what
    // the alternative — refusing the document — would amount to.
    const older = {
      runs: 5,
      greenRuns: 0,
      offenders: [
        { identity: 'A :: sometimes', failedRuns: [1, 2] },
        { identity: 'B :: always', failedRuns: [1, 2, 3, 4, 5] },
      ],
    };
    expect(offendersOf(older)?.flaky.map((entry) => entry.identity)).toEqual(['A :: sometimes']);
    expect(offendersOf(older)?.consistent.map((entry) => entry.identity)).toEqual(['B :: always']);
  });

  test('a summary with no offender list at all says so instead of saying nothing failed', () => {
    // The #1506 shape as a document: every field the reader wants except the
    // one it reads offenders from. It must not render as "no test was named" —
    // that sentence is for a night that named nobody, not for a reader that
    // could not look.
    const { offenders: _dropped, ...withoutOffenders } = summary;
    expect(offendersOf(withoutOffenders)).toBeUndefined();
    const report = buildReport([{ label: 'whole suite', summary: withoutOffenders }]);
    expect(report.body).toContain('**This summary names no offenders at all**');
    expect(report.body).not.toContain('No test was named by any run');
  });

  test('the retired field names cannot come back silently', () => {
    // What shipped: a document carrying `flaky`/`consistent` and no
    // `offenders`. If the reader ever went back to those keys this would name
    // the test; as it stands it must report the document as unreadable.
    const retired = {
      ...summary,
      offenders: undefined,
      flaky: [{ identity: 'A :: sometimes', failedRuns: [1] }],
      consistent: [],
    };
    const report = buildReport([{ label: 'whole suite', summary: retired }]);
    expect(report.body).not.toContain('A :: sometimes');
    expect(report.body).toContain('**This summary names no offenders at all**');
  });

  test('a green night with no offenders is silent rather than alarmed', () => {
    // The other direction of the same edge: `offenders: []` on a green night
    // is the normal case and must produce no complaint at all.
    expect(offendersOf(green)).toEqual({ consistent: [], flaky: [] });
    const report = buildReport([{ label: 'whole suite', summary: green }]);
    expect(report.body).not.toContain('No test was named by any run');
    expect(report.body).not.toContain('names no offenders at all');
  });
});

describe('summary arguments', () => {
  test('label and path are split on the first colon only', () => {
    expect(parseSummaryArgument('whole suite:C:/tmp/summary.json'))
      .toEqual({ label: 'whole suite', path: 'C:/tmp/summary.json' });
  });

  test('a value with no label is refused rather than guessed at', () => {
    expect(() => parseSummaryArgument(':/tmp/summary.json')).toThrow(/label:path/);
  });

  test('a well-formed summary round-trips', () => {
    expect(readSummary(summaryFile(green))).toEqual(green);
  });
});
