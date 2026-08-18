import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  aggregate,
  attributesOf,
  collectRun,
  identityOf,
  normalisePath,
  parseArguments,
  parseReport,
  parseSummary,
  render,
  unescapeXml,
  type CollectedRun,
  type ReportedTestCase,
  type RunOutcome,
  type StressOptions,
} from '../../../scripts/stress-test.mjs';

/**
 * The flake harness is a classifier, and nothing checked it (#290).
 *
 * `scripts/stress-test.mjs` exists to answer two questions a single `bun test`
 * cannot: *which test* failed across N runs, and whether it failed in **some**
 * of them (flaky — worth cataloguing) or in **all** of them (broken — worth an
 * issue).  Both answers are computed, not observed, and every step of the
 * computation can be wrong in a way that is indistinguishable from a real
 * measurement:
 *
 *  - read a `<skipped/>` child as a pass and a quarantined suite reports a
 *    reliable pass rate over tests that never ran;
 *  - normalise the `file` attribute wrong and the same test failing three
 *    times on a Windows clone reads as three unrelated tests failing once,
 *    which is exactly the "two red builds a week apart" the harness replaces;
 *  - miss the entity decoding and a test called `expect(a && b)` splits in two
 *    across two bun releases;
 *  - count a hung run as green and a night that measured nothing counts
 *    towards the fourteen needed to lift the quarantine.
 *
 * Wave 2 shipped the harness, the docs and the nightly workflow, and its own
 * verification recorded the issue as `unproven`: the only guard was
 * `tests/unit/ci/StressHarnessWatchdog.test.ts`, which covers the hang path and
 * nothing else.  The classifier itself had no test and could not have one — the
 * script had no `export` and ran its driver at module scope, so importing it
 * started a full stress run.  It now runs under `import.meta.main`; this file is
 * what that seam was for.
 *
 * The division of labour: everything here is pure, driven by fixture XML and
 * synthetic run arrays, so a wrong classification is a red test rather than a
 * plausible-looking number.  The spawning half —  a suite that really does fail
 * in some runs and not others, and the quarantine flag really reaching a child
 * process — is covered end to end by
 * `tests/unit/ci/StressHarnessClassification.test.ts` and
 * `tests/unit/ci/StressHarnessQuarantine.test.ts`, because a stub child would
 * let a broken one pass.
 *
 * Refs #290, #538.
 */

const SCRIPT = join(import.meta.dir, '..', '..', '..', 'scripts', 'stress-test.mjs');

/**
 * bun 1.3.1's actual JUnit output, over a four-test fixture with one pass, one
 * failed `expect`, one `test.skip` and one thrown error.  Kept verbatim (only
 * the fixture's directory name is changed) because every claim the parser's
 * JSDoc makes is a claim about *this* shape:
 *
 *  - a passing case is self-closing; a failing one carries `<failure … />` and
 *    a skipped one `<skipped />`, both as children;
 *  - `tests` on the root counts skips, so `executed + skipped` is the
 *    cross-check and `executed` alone is not;
 *  - `classname` is the innermost `describe`;
 *  - **the `file` attribute is written with the host's separator.**  That is
 *    not hypothetical portability work: this is a Windows checkout, and the
 *    backslashes below are what bun wrote.  A nightly artifact from a Linux
 *    runner spells the same test the other way.
 */
const BUN_JUNIT_REPORT = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuites name="bun test" tests="4" assertions="2" failures="2" skipped="1" time="0.0610637">',
  '  <testsuite name="fixture\\Shape.test.ts" file="fixture\\Shape.test.ts" tests="4" assertions="2" failures="2" skipped="1" time="0" hostname="">',
  '    <testsuite name="shapes" file="fixture\\Shape.test.ts" line="3" tests="4" assertions="2" failures="2" skipped="1" time="0" hostname="">',
  '      <testcase name="passes" classname="shapes" time="0" file="fixture\\Shape.test.ts" line="4" assertions="1" />',
  '      <testcase name="fails with a &gt; and an &amp; in the name" classname="shapes" time="0" file="fixture\\Shape.test.ts" line="5" assertions="1">',
  '        <failure type="AssertionError" />',
  '      </testcase>',
  '      <testcase name="is skipped" classname="shapes" time="0" file="fixture\\Shape.test.ts" line="6" assertions="0">',
  '        <skipped />',
  '      </testcase>',
  '      <testcase name="throws outside expect" classname="shapes" time="0" file="fixture\\Shape.test.ts" line="7" assertions="0">',
  '        <failure type="AssertionError" />',
  '      </testcase>',
  '    </testsuite>',
  '  </testsuite>',
  '</testsuites>',
].join('\n');

/** One `<testcase>` with a `<failure>` child, so it reaches the identity path. */
const failingTestCase = (attributes: string): string =>
  `<testcase ${attributes}>\n  <failure type="AssertionError" />\n</testcase>`;

const reportOf = (...testCases: readonly string[]): string =>
  `<testsuites name="bun test" tests="${testCases.length}" failures="${testCases.length}" skipped="0">\n`
  + `${testCases.join('\n')}\n</testsuites>`;

/**
 * A run that reported. `status` follows from the failures unless the caller
 * overrides it — the one case where it must not is a non-zero exit with no
 * failing test, which is its own signal and must not read as green.
 */
function reportedRun(
  index: number,
  failures: readonly ReportedTestCase[],
  overrides: Partial<CollectedRun> = {},
): CollectedRun {
  return {
    index,
    status: failures.length === 0 ? 0 : 1,
    timedOut: false,
    durationMs: 1_000,
    executed: 100,
    skipped: 2,
    failures,
    reportMissing: false,
    ...overrides,
  };
}

/** A run the watchdog killed: no report, and `reportMissing` deliberately false. */
const hungRun = (index: number): CollectedRun => ({
  index,
  status: null,
  timedOut: true,
  durationMs: 480_000,
  executed: 0,
  skipped: 0,
  failures: [],
  reportMissing: false,
});

/** A run whose reporter never flushed — bun died while writing. */
const silentRun = (index: number): CollectedRun => ({
  index,
  status: 1,
  timedOut: false,
  durationMs: 12_000,
  executed: 0,
  skipped: 0,
  failures: [],
  reportMissing: true,
});

const lease: ReportedTestCase = {
  file: 'tests/multi-node/LeaseMajority.test.ts',
  suite: 'LeaseMajority — end-to-end split-brain',
  name: '4 nodes, 2/2 partition: lease holder side survives, other side downs itself',
};
const bootstrap: ReportedTestCase = {
  file: 'tests/unit/testkit/ParallelMultiNodeSpec.test.ts',
  suite: 'ParallelMultiNodeSpec — bootstrap',
  name: 'addressFor + allRoles work after start',
};

const defaultOptions: StressOptions = {
  runs: 5,
  concurrency: 1,
  maximumFlakyTests: 0,
  runTimeoutMs: 1_200_000,
  reportDirectory: '.stress',
  skipQuarantined: false,
  filters: [],
};

describe('the harness reads a JUnit report the way bun writes one', () => {
  test('a pass, a failure, an error and a skip are told apart', () => {
    const parsed = parseReport(BUN_JUNIT_REPORT);

    // Three ran (pass + failed expect + thrown error); the `test.skip` did not.
    expect(parsed.executed).toBe(3);
    expect(parsed.skipped).toBe(1);
    expect(parsed.failures.map((failure) => failure.name)).toEqual([
      'fails with a > and an & in the name',
      'throws outside expect',
    ]);
  });

  /**
   * A skip that counted as a pass is the harness's worst failure mode, because
   * it is silent and self-confirming: the three quarantined suites skip
   * *themselves* through `describeMns`, so a harness that read `<skipped/>` as
   * a pass would report "3/3 green" for a night in which nothing ran.
   */
  test('a skipped test is neither executed nor a failure', () => {
    const parsed = parseReport(reportOf(
      '<testcase name="quarantined" classname="LeaseMajority" file="tests/multi-node/LeaseMajority.test.ts">'
      + '\n  <skipped />\n</testcase>',
    ));

    expect(parsed.executed).toBe(0);
    expect(parsed.skipped).toBe(1);
    expect(parsed.failures).toEqual([]);
  });

  /** `<error>` is the other failing child the parser's contract names. */
  test('an <error> child counts as a failure', () => {
    const parsed = parseReport(reportOf(
      '<testcase name="crashes in beforeAll" classname="Suite" file="tests/A.test.ts">'
      + '\n  <error type="Error" />\n</testcase>',
    ));

    expect(parsed.executed).toBe(1);
    expect(parsed.failures.map((failure) => failure.name)).toEqual(['crashes in beforeAll']);
  });

  /**
   * `tests` on the root element counts skips; `executed` does not.  The script
   * collects these totals as "a cross-check on the per-testcase scan" and then
   * never compares them — so this test is where the two are actually held
   * against each other, and a report whose halves disagree fails here.
   */
  test('the root element totals agree with the per-testcase scan', () => {
    const parsed = parseReport(BUN_JUNIT_REPORT);
    const totals = parseSummary(BUN_JUNIT_REPORT);

    expect(totals).toEqual({ tests: 4, failures: 2, skipped: 1 });
    expect(totals).toEqual({
      tests: parsed.executed + parsed.skipped,
      failures: parsed.failures.length,
      skipped: parsed.skipped,
    });
  });

  test('a report with no root element yields no totals', () => {
    expect(parseSummary('<html>404</html>')).toBeUndefined();
  });

  /**
   * XML permits a raw `>` inside an attribute value, and a parser that scanned
   * to the first `>` would truncate the tag there and lose every attribute
   * after it — including `file`, which is half of the test's identity.  bun
   * escapes it today (see {@link BUN_JUNIT_REPORT}); this asserts the harness
   * survives a reporter that does not.
   */
  test('a raw > inside an attribute value does not truncate the tag', () => {
    const parsed = parseReport(reportOf(
      failingTestCase('name="rejects a > b" classname="Guard" file="tests/Guard.test.ts"'),
    ));

    expect(parsed.failures).toEqual([
      { file: 'tests/Guard.test.ts', suite: 'Guard', name: 'rejects a > b' },
    ]);
  });

  test.each([
    { what: 'named entities', escaped: 'expect(a &amp;&amp; b)', decoded: 'expect(a && b)' },
    { what: 'a decimal character reference', escaped: 'expect(a &#38;&#38; b)', decoded: 'expect(a && b)' },
    { what: 'a hexadecimal character reference', escaped: 'expect(a &#x26;&#x26; b)', decoded: 'expect(a && b)' },
    { what: 'the angle brackets', escaped: '&lt;div&gt; renders', decoded: '<div> renders' },
    { what: 'a quote', escaped: 'the &quot;fast&quot; path', decoded: 'the "fast" path' },
    { what: 'an apostrophe', escaped: 'don&apos;t retry', decoded: "don't retry" },
  ])('a test name escaped with $what decodes back to one name', ({ escaped, decoded }) => {
    expect(unescapeXml(escaped)).toBe(decoded);
    const parsed = parseReport(reportOf(
      failingTestCase(`name="${escaped}" classname="Suite" file="tests/A.test.ts"`),
    ));
    expect(parsed.failures[0]!.name).toBe(decoded);
  });

  /** An entity the map does not know must survive rather than vanish. */
  test('an unknown entity is left alone', () => {
    expect(unescapeXml('caf&eacute; &amp; bar')).toBe('caf&eacute; & bar');
  });

  test('every attribute of a tag is read, decoded, and keyed by name', () => {
    const attributes = attributesOf(
      ' name="a &gt; b" classname="Suite" file="tests\\A.test.ts" line="12" assertions="1"',
    );

    expect(attributes.get('name')).toBe('a > b');
    expect(attributes.get('file')).toBe('tests\\A.test.ts');
    expect([...attributes.keys()]).toEqual(['name', 'classname', 'file', 'line', 'assertions']);
  });
});

describe('a test keeps one identity however its file is spelled', () => {
  /**
   * The identity is the whole point of aggregating: "failed 3 of 5 runs" is one
   * fact, three identities would be three unrelated reds.  The `file` attribute
   * is the unstable half — bun writes the host separator, and an absolute path
   * when the filter was absolute — so the same test compared across a nightly
   * Linux artifact and a Windows laptop has to collapse to one key.
   */
  test.each([
    { what: 'a POSIX relative path', file: 'tests/Actor.test.ts' },
    { what: 'a Windows relative path', file: 'tests\\Actor.test.ts' },
    { what: 'the absolute path of this checkout', file: join(process.cwd(), 'tests', 'Actor.test.ts') },
  ])('$what normalises to the repository-relative POSIX form', ({ file }) => {
    expect(normalisePath(file)).toBe('tests/Actor.test.ts');
  });

  test('the three spellings collapse to a single identity through parseReport', () => {
    const spellings = [
      'tests/Actor.test.ts',
      'tests\\Actor.test.ts',
      join(process.cwd(), 'tests', 'Actor.test.ts'),
    ];
    // Interpolated raw: XML attribute values have no backslash escape, so a
    // Windows separator goes into the report exactly as bun writes it.
    const identities = spellings.map((file) => {
      const parsed = parseReport(reportOf(failingTestCase(
        `name="stops a failing child" classname="supervision" file="${file}"`,
      )));
      return identityOf(parsed.failures[0]!);
    });

    expect(new Set(identities).size).toBe(1);
    expect(identities[0]).toBe('tests/Actor.test.ts :: supervision :: stops a failing child');
  });

  /** A top-level `test` has no `describe`, so bun leaves `classname` empty. */
  test('a test outside any describe gets a stable placeholder, not an empty gap', () => {
    expect(identityOf({ file: 'tests/A.test.ts', suite: '', name: 'works' }))
      .toBe('tests/A.test.ts :: (top level) :: works');
  });

  /**
   * Two tests with the same name in different describes are two tests, and two
   * describes with the same name in different files likewise.  A key that
   * dropped either component would merge them and halve the reported count.
   */
  test('name, suite and file are all part of the key', () => {
    const identities = new Set([
      identityOf({ file: 'tests/A.test.ts', suite: 'S', name: 'n' }),
      identityOf({ file: 'tests/B.test.ts', suite: 'S', name: 'n' }),
      identityOf({ file: 'tests/A.test.ts', suite: 'T', name: 'n' }),
      identityOf({ file: 'tests/A.test.ts', suite: 'S', name: 'm' }),
    ]);
    expect(identities.size).toBe(4);
  });
});

describe('aggregate tells a flaky test from a broken one', () => {
  /**
   * The split this issue exists for.  "Failed in some runs" is a flake and
   * belongs in the catalog; "failed in every run" is a broken test and
   * repetition has nothing further to say about it.  A classifier that put
   * everything in one bucket would still print a plausible table.
   */
  test('a test that failed in some runs but not all is flaky', () => {
    const aggregated = aggregate(
      [reportedRun(1, [lease]), reportedRun(2, [lease]), reportedRun(3, [])],
      3,
    );

    expect(aggregated.greenRuns).toBe(1);
    expect(aggregated.consistent).toEqual([]);
    expect(aggregated.flaky).toHaveLength(1);
    expect(aggregated.flaky[0]!.identity).toBe(identityOf(lease));
    // One offender, not two — the whole reason identity is computed.
    expect(aggregated.flaky[0]!.failedRuns).toEqual([1, 2]);
    expect(aggregated.totalFailures).toBe(2);
    expect(aggregated.totalExecuted).toBe(300);
  });

  test('a test that failed in every run is consistent, not flaky', () => {
    const aggregated = aggregate(
      [reportedRun(1, [lease]), reportedRun(2, [lease]), reportedRun(3, [lease])],
      3,
    );

    expect(aggregated.flaky).toEqual([]);
    expect(aggregated.consistent).toHaveLength(1);
    expect(aggregated.consistent[0]!.failedRuns).toEqual([1, 2, 3]);
    expect(aggregated.greenRuns).toBe(0);
  });

  test('two tests failing in the same run are two offenders', () => {
    const aggregated = aggregate(
      [reportedRun(1, [lease, bootstrap]), reportedRun(2, [lease])],
      2,
    );

    expect(aggregated.consistent.map((entry) => entry.identity)).toEqual([identityOf(lease)]);
    expect(aggregated.flaky.map((entry) => entry.identity)).toEqual([identityOf(bootstrap)]);
  });

  /** Worst first: the table is read top-down and the count is why. */
  test('offenders are ordered by how often they failed', () => {
    const aggregated = aggregate(
      [reportedRun(1, [bootstrap]), reportedRun(2, [lease, bootstrap]), reportedRun(3, [bootstrap])],
      4,
    );

    expect(aggregated.flaky.map((entry) => entry.failedRuns.length)).toEqual([3, 1]);
    expect(aggregated.flaky[0]!.identity).toBe(identityOf(bootstrap));
  });

  /**
   * A hang is not a failure and not a truncated report.  It excludes the run
   * from every total — nothing can be said about the tests in a run that
   * stopped making progress — and it must stay out of `runsWithoutReport`,
   * whose diagnosis (bun died while flushing) has a different fix.
   */
  test('a hung run is counted as a hang and nothing else', () => {
    const aggregated = aggregate([reportedRun(1, []), hungRun(2)], 2);

    expect(aggregated.runsTimedOut).toEqual([2]);
    expect(aggregated.runsWithoutReport).toEqual([]);
    expect(aggregated.runsRedWithoutFailures).toEqual([]);
    expect(aggregated.greenRuns).toBe(1);
    // Run 2's executed count is not folded in: it observed nothing.
    expect(aggregated.totalExecuted).toBe(100);
  });

  test('a run whose reporter never flushed is counted as missing, not hung', () => {
    const aggregated = aggregate([reportedRun(1, []), silentRun(2)], 2);

    expect(aggregated.runsWithoutReport).toEqual([2]);
    expect(aggregated.runsTimedOut).toEqual([]);
    expect(aggregated.greenRuns).toBe(1);
    expect(aggregated.totalExecuted).toBe(100);
  });

  /**
   * An unreleased handle, a crash in teardown, a bun-level error: the report is
   * green and the process still exited non-zero.  Counting that as a green run
   * is how a broken night reaches the un-quarantine streak.
   */
  test('a non-zero exit with no failing test is its own signal and is not green', () => {
    const aggregated = aggregate(
      [reportedRun(1, []), reportedRun(2, [], { status: 1 })],
      2,
    );

    expect(aggregated.runsRedWithoutFailures).toEqual([2]);
    expect(aggregated.greenRuns).toBe(1);
    expect(aggregated.flaky).toEqual([]);
    expect(aggregated.consistent).toEqual([]);
  });

  /**
   * `runs` is the number **requested**, not the number that reported — so a
   * test that failed in every run that spoke is still only *flaky* when a run
   * went silent.  That is the conservative reading and the intended one: three
   * reds out of three observations plus two unknowns does not establish "fails
   * always".  Pinned here because it is the kind of asymmetry a later
   * simplification quietly removes, and the script exits non-zero for the
   * silent runs regardless.
   */
  test('an unobserved run keeps a test out of the consistent bucket', () => {
    const aggregated = aggregate(
      [reportedRun(1, [lease]), reportedRun(2, [lease]), reportedRun(3, [lease]), hungRun(4), silentRun(5)],
      5,
    );

    expect(aggregated.consistent).toEqual([]);
    expect(aggregated.flaky[0]!.failedRuns).toEqual([1, 2, 3]);
    expect(aggregated.runsTimedOut).toEqual([4]);
    expect(aggregated.runsWithoutReport).toEqual([5]);
    expect(aggregated.greenRuns).toBe(0);
  });

  test('every run green is the only shape that reports every run green', () => {
    const aggregated = aggregate([reportedRun(1, []), reportedRun(2, []), reportedRun(3, [])], 3);

    expect(aggregated.greenRuns).toBe(3);
    expect(aggregated.flaky).toEqual([]);
    expect(aggregated.consistent).toEqual([]);
    expect(aggregated.totalFailures).toBe(0);
  });
});

describe('collectRun keeps a hang and a truncated report apart', () => {
  const withTemporaryDirectory = <T>(body: (directory: string) => T): T => {
    const directory = mkdtempSync(join(tmpdir(), 'actor-ts-stress-collect-'));
    try {
      return body(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  const killedOutcome: RunOutcome = { index: 1, status: null, timedOut: true, durationMs: 480_000 };
  const exitedOutcome: RunOutcome = { index: 1, status: 1, timedOut: false, durationMs: 9_000 };

  /**
   * A killed run has no report *because* it was killed.  Filing it as "bun died
   * before the reporter flushed" as well would send a reader after the wrong
   * cause, and the two are reported with different remedies.
   */
  test('a killed run is not also reported as a missing report', () => {
    const collected = withTemporaryDirectory((directory) =>
      collectRun(killedOutcome, join(directory, 'run-1.junit.xml')));

    expect(collected.timedOut).toBe(true);
    expect(collected.reportMissing).toBe(false);
    expect(collected.failures).toEqual([]);
    expect(collected.executed).toBe(0);
  });

  test('a run that exited without writing a report is reported as missing', () => {
    const collected = withTemporaryDirectory((directory) =>
      collectRun(exitedOutcome, join(directory, 'run-1.junit.xml')));

    expect(collected.reportMissing).toBe(true);
    expect(collected.timedOut).toBe(false);
  });

  /**
   * An empty file is the shape a reporter that was interrupted before its first
   * write leaves behind. `existsSync` alone says the file is there.
   */
  test('an empty report file counts as no report', () => {
    const collected = withTemporaryDirectory((directory) => {
      const path = join(directory, 'run-1.junit.xml');
      writeFileSync(path, '   \n');
      return collectRun(exitedOutcome, path);
    });

    expect(collected.reportMissing).toBe(true);
  });

  test('a readable report is parsed and its root totals carried alongside', () => {
    const collected = withTemporaryDirectory((directory) => {
      const path = join(directory, 'run-1.junit.xml');
      writeFileSync(path, BUN_JUNIT_REPORT);
      return collectRun(exitedOutcome, path);
    });

    expect(collected.reportMissing).toBe(false);
    expect(collected.executed).toBe(3);
    expect(collected.skipped).toBe(1);
    expect(collected.failures).toHaveLength(2);
    expect(collected.summary).toEqual({ tests: 4, failures: 2, skipped: 1 });
  });
});

describe('the rendered summary says what was and was not measured', () => {
  test('no failure and no silence is stated as exactly that', () => {
    const output = render(aggregate([reportedRun(1, []), reportedRun(2, [])], 2), defaultOptions);

    expect(output).toContain('runs:            2/2 green');
    expect(output).toContain('No test failed in any run that reported.');
    expect(output).not.toContain('FLAKY');
  });

  /**
   * "No test failed" over zero observed runs is a true sentence and a false
   * reassurance — and it is the sentence the quarantined suites produce when
   * their workers never start.  The wording has to change, not just the counts.
   */
  test('a run that reported nothing is never rendered as a clean bill of health', () => {
    const output = render(aggregate([hungRun(1), silentRun(2)], 2), defaultOptions);

    expect(output).toContain('No run reported anything, so nothing can be said about any test.');
    expect(output).not.toContain('No test failed in any run that reported.');
    expect(output).toContain('never exited');
    expect(output).toContain('no JUnit report');
  });

  test('the flaky and consistent tables are labelled and counted separately', () => {
    const output = render(
      aggregate([reportedRun(1, [lease, bootstrap]), reportedRun(2, [lease])], 2),
      defaultOptions,
    );

    expect(output).toContain('FLAKY — failed in some runs but not all (1)');
    expect(output).toContain('CONSISTENTLY FAILING — failed in every run (1)');
    expect(output).toContain(identityOf(lease));
    expect(output).toContain(identityOf(bootstrap));
    expect(output).toContain('runs: 1');
  });

  /**
   * Which suites the number covers is part of the number.  A summary that did
   * not say so is how "the suite is reliable" gets quoted for a run that
   * excluded exactly the unreliable suites.
   */
  test('the summary states whether the quarantined suites were in the run', () => {
    const included = render(aggregate([reportedRun(1, [])], 1), defaultOptions);
    const excluded = render(
      aggregate([reportedRun(1, [])], 1),
      { ...defaultOptions, skipQuarantined: true },
    );

    expect(included).toContain('quarantined suites: included');
    expect(excluded).toContain('quarantined suites: SKIPPED (--skip-quarantined)');
  });
});

describe('the harness options parse the way the workflows invoke them', () => {
  test('the defaults are the documented ones', () => {
    const options = parseArguments([]);

    expect(options.runs).toBe(10);
    expect(options.concurrency).toBe(1);
    expect(options.maximumFlakyTests).toBe(0);
    expect(options.runTimeoutMs).toBe(20 * 60 * 1_000);
    expect(options.reportDirectory).toBe('.stress');
    // The default that the whole "do not measure a smaller suite" rationale
    // rests on: quarantined suites are IN unless asked otherwise.
    expect(options.skipQuarantined).toBe(false);
    expect(options.filters).toEqual([]);
  });

  /** Verbatim from `.github/workflows/nightly-flakes.yml`'s quarantined job. */
  test('the nightly quarantined job\'s arguments parse as three path filters', () => {
    const options = parseArguments([
      '--runs=3',
      '--run-timeout=480000',
      '--report-dir=.stress',
      'tests/multi-node/LeaseMajority.test.ts',
      'tests/multi-node/ParallelPubSub.test.ts',
      'tests/unit/testkit/ParallelMultiNodeSpec.test.ts',
    ]);

    expect(options.runs).toBe(3);
    expect(options.runTimeoutMs).toBe(480_000);
    expect(options.filters).toHaveLength(3);
    expect(options.skipQuarantined).toBe(false);
  });

  test('--skip-quarantined is a bare flag and turns the opt-out on', () => {
    expect(parseArguments(['--skip-quarantined']).skipQuarantined).toBe(true);
  });
});

describe('the harness is importable, which is what makes the above possible', () => {
  /**
   * The seam, asserted at the source level as well as by this file existing:
   * with the driver at module scope, importing the script started N `bun test`
   * children, so a test of the classifier was not merely absent but impossible.
   * A regression would be silent in the worst way — `bun test` would appear to
   * hang rather than to fail.
   */
  test('the driver runs only as an entry point', () => {
    const source = readFileSync(SCRIPT, 'utf8');

    expect(source).toContain('if (import.meta.main)');
    const sideEffectsAtModuleScope = source
      .split(/\r?\n/)
      .filter((line) => /^(?:await\s|rmSync\(|mkdirSync\(|console\.log\(|process\.exit\()/.test(line));
    expect(
      sideEffectsAtModuleScope,
      'A statement with a side effect sits at module scope in scripts/stress-test.mjs, so '
      + 'importing it runs a stress loop. Move it inside main() — the import.meta.main guard '
      + 'is what lets this file exist.',
    ).toEqual([]);
  });

  /** Guards the guard: the fixtures must not be vacuous. */
  test('the fixtures still parse into something', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(parseReport(BUN_JUNIT_REPORT).failures.length).toBeGreaterThan(0);
    expect(parseReport('').failures).toEqual([]);
    expect(parseReport('').executed).toBe(0);
  });
});
