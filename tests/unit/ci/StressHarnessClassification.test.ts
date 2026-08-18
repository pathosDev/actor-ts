import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';

/**
 * The flake harness, driven against suites whose flakiness is known in advance
 * (#290).
 *
 * `tests/unit/ci/StressHarnessAggregation.test.ts` proves the classifier over
 * fixture XML.  This file proves the whole pipeline — spawn, JUnit report,
 * identity, aggregation, `summary.json`, exit status — by giving it a suite
 * whose behaviour across runs is decided by a counter file rather than by
 * timing.  A synthetic flake is the only kind whose expected verdict is a fact:
 * over a real suite, "reported as flaky" and "misclassified" produce the same
 * output.
 *
 * Three fixtures, one per outcome the harness has to keep apart:
 *
 *  - a test that fails in exactly one of five runs is **flaky** — the entry a
 *    catalog is built from;
 *  - a test that fails in all five is **consistently failing** — broken, and
 *    repetition has nothing more to say about it;
 *  - a run that never exits is a **hang** — and the runs around it stay green
 *    individually while the night as a whole must not.
 *
 * That last one is the case the nightly actually meets.  `StressHarnessWatchdog`
 * covers a run where *every* repeat hangs; the dangerous shape is the mixed one,
 * where two of three runs are green and the third stopped making progress.  If
 * that reads as "no test failed in any run", the un-quarantine streak counts a
 * night in which the measurement did not happen.
 *
 * Refs #290, #538.
 */

const SCRIPT = join(import.meta.dir, '..', '..', '..', 'scripts', 'stress-test.mjs');

/**
 * The run number, carried in a file beside the fixture because the harness puts
 * a process boundary between runs.  Deliberately not timing-based: a fixture
 * that flaked *by racing* would make this file as unreliable as the suites it
 * is here to measure.
 *
 * The file is named `run-counter` with no extension, so bun's own discovery
 * (which requires `.test` / `_test_` / `.spec` in the name) leaves it alone.
 */
const RUN_COUNTER_PREAMBLE = [
  "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "import { describe, expect, test } from 'bun:test';",
  '',
  "const counterPath = join(import.meta.dir, 'run-counter');",
  "const runNumber = (existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) : 0) + 1;",
  'writeFileSync(counterPath, String(runNumber));',
  '',
];

/** One flake, one always-red test, one always-green test, one skip. */
const MIXED_SUITE = [
  ...RUN_COUNTER_PREAMBLE,
  "describe('synthetic', () => {",
  "  test('fails on the third run only', () => {",
  '    expect(runNumber).not.toBe(3);',
  '  });',
  "  test('fails in every run', () => {",
  '    expect(runNumber).toBe(-1);',
  '  });',
  "  test('passes in every run', () => {",
  '    expect(runNumber).toBeGreaterThan(0);',
  '  });',
  "  test.skip('is skipped in every run', () => {",
  '    expect(true).toBe(false);',
  '  });',
  '});',
  '',
].join('\n');

/** One flake and nothing else, so most runs really are green. */
const SINGLE_FLAKE_SUITE = [
  ...RUN_COUNTER_PREAMBLE,
  "describe('synthetic', () => {",
  "  test('fails on the second run only', () => {",
  '    expect(runNumber).not.toBe(2);',
  '  });',
  '});',
  '',
].join('\n');

/**
 * Hangs on run 2 and only run 2.  The per-test timeout is far beyond the
 * harness's `--run-timeout` on purpose: otherwise bun ends the run itself and
 * the case would pass against a harness with no watchdog at all.
 */
const HANG_ON_ONE_RUN_SUITE = [
  ...RUN_COUNTER_PREAMBLE,
  "describe('synthetic', () => {",
  "  test('never finishes on the second run', async () => {",
  '    if (runNumber === 2) await new Promise(() => {});',
  '    expect(runNumber).toBeGreaterThan(0);',
  '  }, 600_000);',
  '});',
  '',
].join('\n');

type HarnessOffender = {
  readonly identity: string;
  readonly file: string;
  readonly suite: string;
  readonly name: string;
  readonly failedRuns: readonly number[];
};

type HarnessSummary = {
  readonly runs: number;
  readonly greenRuns: number;
  readonly totalExecuted: number;
  readonly totalFailures: number;
  readonly quarantinedSuitesIncluded: boolean;
  readonly runsTimedOut: readonly number[];
  readonly runsWithoutReport: readonly number[];
  readonly runsRedWithoutFailures: readonly number[];
  readonly offenders: readonly HarnessOffender[];
};

type HarnessRun = {
  readonly status: number | null;
  readonly output: string;
  readonly summary: HarnessSummary | undefined;
};

/**
 * A fresh directory per invocation — the counter file is the fixture's state and
 * the harness only wipes its report directory, so a reused directory would put
 * run 6 where run 1 belongs.
 *
 * `spawnSync`'s own `timeout` is the backstop: a harness whose watchdog does not
 * fire must fail *this* test rather than hang the suite that contains it.
 */
function runHarness(suite: string, argv: readonly string[]): HarnessRun {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-stress-classify-'));
  try {
    writeFileSync(join(directory, 'Synthetic.test.ts'), suite);
    const child = spawnSync('bun', [SCRIPT, '--report-dir=.stress', ...argv], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 150_000,
      killSignal: 'SIGKILL',
    });
    let summary: HarnessSummary | undefined;
    try {
      summary = JSON.parse(readFileSync(join(directory, '.stress', 'summary.json'), 'utf8'));
    } catch {
      summary = undefined;
    }
    return { status: child.status, output: `${child.stdout ?? ''}${child.stderr ?? ''}`, summary };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const offenderNamed = (summary: HarnessSummary, name: string): HarnessOffender | undefined =>
  summary.offenders.find((offender) => offender.name === name);

describe('the harness sorts a synthetic suite into flaky and broken', () => {
  /**
   * The measurement this issue was opened to make, over inputs whose answer is
   * known: one test fails in run 3 of 5, another fails in all five, a third
   * never fails and a fourth never runs.  Everything about the verdict is
   * checkable — including the counts, which is what makes a misclassification
   * visible instead of plausible.
   */
  test('one failure in five runs is flaky; five in five is broken', () => {
    const result = runHarness(MIXED_SUITE, ['--runs=5']);

    expect(result.summary, `no summary.json was written\n${result.output.slice(-2_000)}`).toBeDefined();
    const summary = result.summary!;

    expect(summary.runs).toBe(5);
    // Every run carries the always-failing test, so no run is green.
    expect(summary.greenRuns).toBe(0);
    expect(summary.runsTimedOut).toEqual([]);
    expect(summary.runsWithoutReport).toEqual([]);
    expect(summary.runsRedWithoutFailures).toEqual([]);

    const flake = offenderNamed(summary, 'fails on the third run only');
    expect(
      flake,
      'the test that fails in exactly one of five runs is not in the offender list at all',
    ).toBeDefined();
    expect(flake!.failedRuns).toEqual([3]);
    expect(flake!.suite).toBe('synthetic');
    expect(flake!.file).toBe('Synthetic.test.ts');
    // The identity as it is written into the artifact, spelled out: it is the
    // key a later night compares against, so a change to its shape is a change
    // to whether two nights can be compared at all.
    expect(flake!.identity).toBe('Synthetic.test.ts :: synthetic :: fails on the third run only');

    const broken = offenderNamed(summary, 'fails in every run');
    expect(broken).toBeDefined();
    expect(broken!.failedRuns).toEqual([1, 2, 3, 4, 5]);
    expect(broken!.identity).toBe('Synthetic.test.ts :: synthetic :: fails in every run');

    // The always-green test must not appear, and neither must the skipped one:
    // a skip recorded as a failure or as an execution is the same defect from
    // two directions.
    expect(offenderNamed(summary, 'passes in every run')).toBeUndefined();
    expect(offenderNamed(summary, 'is skipped in every run')).toBeUndefined();
    expect(summary.offenders).toHaveLength(2);

    // 3 executed x 5 runs. If the skip were counted it would be 20.
    expect(summary.totalExecuted).toBe(15);
    // 5 always-red plus 1 flake.
    expect(summary.totalFailures).toBe(6);

    // The split is in the human-readable output too, with its counts, because
    // that is the half a nightly reader actually sees.
    expect(result.output).toContain('FLAKY — failed in some runs but not all (1)');
    expect(result.output).toContain('CONSISTENTLY FAILING — failed in every run (1)');
    expect(result.output).toContain('1/5');
    expect(result.output).toContain('5/5');
    expect(result.status).toBe(1);
    expect(result.output).toContain('2 test(s) failed at least once');
  });

  /**
   * The same flake with nothing else in the suite, so the green runs are real.
   * "4 of 5 green with one named offender" is the shape a catalog entry is
   * written from; "0 of 5 green" above cannot show that the count is right.
   */
  test('the green runs around a flake are still counted green', () => {
    const result = runHarness(SINGLE_FLAKE_SUITE, ['--runs=3']);

    const summary = result.summary!;
    expect(summary.greenRuns).toBe(2);
    expect(summary.offenders).toHaveLength(1);
    expect(summary.offenders[0]!.failedRuns).toEqual([2]);
    expect(summary.totalExecuted).toBe(3);
    expect(summary.totalFailures).toBe(1);
    expect(result.output).toContain('runs:            2/3 green');
    // The default budget is zero, so one flake is still a failed gate.
    expect(result.status).toBe(1);
  });

  /**
   * `--max-flaky` is the only escape hatch, and it has to be reachable — a gate
   * with no way to say "this one is known" gets deleted rather than tuned.
   */
  test('--max-flaky tolerates a known flake without hiding it', () => {
    const result = runHarness(SINGLE_FLAKE_SUITE, ['--runs=3', '--max-flaky=1']);

    expect(result.status).toBe(0);
    expect(result.output).toContain('stress-test: PASS (2/3 runs green)');
    // Tolerated, not silenced: it is still named in the table and the summary.
    expect(result.output).toContain('FLAKY — failed in some runs but not all (1)');
    expect(result.summary!.offenders).toHaveLength(1);
  });
});

describe('a hang among green runs is a hang, not a green night', () => {
  /**
   * Run 1 green, run 2 killed by the watchdog, run 3 green.  Each *reported*
   * run really did pass, so every count except one says "clean" — which is
   * exactly why this shape is dangerous: the quarantined suites' documented
   * symptom is that workers spawn, handshake and never run, and a night that
   * measured nothing must not be counted towards the fourteen that lift the
   * quarantine.
   */
  test('a run that never exits is recorded as a hang and fails the gate', () => {
    const result = runHarness(HANG_ON_ONE_RUN_SUITE, ['--runs=3', '--run-timeout=4000']);

    const summary = result.summary!;
    expect(summary.runsTimedOut).toEqual([2]);
    // A hang has one diagnosis, and "bun died before the reporter flushed" is
    // not it.
    expect(summary.runsWithoutReport).toEqual([]);
    // Two runs genuinely passed. The point is what happens to the third.
    expect(summary.greenRuns).toBe(2);
    expect(summary.runs).toBe(3);
    expect(summary.offenders).toEqual([]);

    expect(result.output).toContain('run 2: HUNG');
    expect(result.output).toContain('1 run(s) never exited');
    expect(
      result.status,
      'the harness passed a night in which one run stopped making progress — '
      + 'no test failed, so the only thing standing between that and a green '
      + 'streak is this exit status.',
    ).toBe(1);
    expect(result.output).not.toContain('stress-test: PASS');
  }, 150_000);
});
