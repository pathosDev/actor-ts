#!/usr/bin/env bun
/**
 * Repeat-run flake harness (#290).
 *
 * A single `bun test` run answers "is the suite green right now".  It cannot
 * answer "which tests are green *most* of the time", which is the only
 * question a flake catalog is built from.  This script runs the suite N
 * times, keeps each run's JUnit report, and aggregates failures by test
 * identity — so a test that failed in 2 of 10 runs is named, with its count,
 * instead of appearing as two unrelated red builds a week apart.
 *
 *   bun run test:stress                       # 10 runs of the whole suite
 *   bun run test:stress -- --runs=3 tests/multi-node/LeaseMajority.test.ts
 *
 * Trailing non-flag arguments are passed to `bun test` as path filters.
 *
 * **What it measures is the whole suite, and that is now structural.**  This
 * script used to delete `ACTOR_TS_SKIP_FLAKY_MNS` from the child environment,
 * because three suites were gated behind it (#538) and they were precisely the
 * ones most likely to flake — a harness that inherited the flag would have
 * reported a reliable pass rate over exactly the tests that were not reliable.
 * The gating is gone, and `tests/unit/ci/NoEnvironmentGatedSkips.test.ts` is
 * what keeps it gone: no environment variable may decide whether a test runs,
 * so there is nothing left for this script to defend against.
 *
 * **What a green stress run does and does not prove.**  The loop drives up
 * the probability of a load-sensitive flake — a fixed sleep that is long
 * enough on an idle machine and short under contention.  It says nothing
 * about a *deterministic* ordering bug: #1145 was 0/200 even at a 1 ms poll,
 * because `src/Dispatcher.ts` schedules via `setImmediate` and the actor's
 * turn was already ahead of the poller in the same macrotask queue.  That
 * family is found by reading, not by repeating.  See
 * `docs/src/content/docs/testing/diagnosing-flakes.mdx`.
 *
 * **A run that hangs is data, not an abort.**  `--run-timeout` (see
 * `DEFAULT_RUN_TIMEOUT_MS`) kills a `bun test` that has stopped making
 * progress, records the run as a *hang* — distinct from a failure and from a
 * truncated report — and carries on with the next one.  That is the whole
 * reason the harness exists in the quarantine's case: the documented
 * hosted-runner symptom of the three gated suites is that workers spawn,
 * handshake and then never run, which is not a red test but a `bun test` that
 * never exits.
 *
 * Output: a per-run line, then a table of every test that failed at least
 * once, split into *flaky* (failed in some runs) and *consistent* (failed in
 * all of them — a broken test, which repetition cannot tell you anything new
 * about).  Reports, logs and a machine-readable `summary.json` are left in
 * the report directory so a nightly job can upload them as an artifact and a
 * later run can compare identities across nights.
 *
 * **This module is importable, and that is a requirement rather than a
 * convenience.**  A harness whose job is to tell a flake from a broken test is
 * itself a classifier, and an unverified classifier is worth less than the
 * measurement it replaces: read `parseReport` wrong and a `<skipped>` counts as
 * a pass, read `identityOf` wrong and one test failing three times reads as
 * three tests failing once.  The pure functions below are therefore exported
 * and the driver runs under `import.meta.main`, so
 * `tests/unit/ci/StressHarnessAggregation.test.ts` can drive them against
 * fixture XML and synthetic run arrays instead of against a live suite, where
 * a wrong classification is indistinguishable from a real flake.  Nothing
 * about a normal `bun run test:stress` changes: the entry point still is the
 * entry point.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const DEFAULT_RUNS = 10;
const DEFAULT_REPORT_DIRECTORY = '.stress';
/** A flake budget of zero: any test that failed at least once is reported and fails the gate. */
const DEFAULT_MAXIMUM_FLAKY_TESTS = 0;
/**
 * How long one `bun test` may take before the run is called a hang.
 *
 * 20 minutes against a full local suite of about 4.5 minutes — deliberately
 * loose, because the watchdog exists to catch a run that has stopped making
 * progress at all, not a slow runner.  A hosted runner under contention can be
 * several times slower than a laptop and must not be declared hung for it.
 */
const DEFAULT_RUN_TIMEOUT_MS = 20 * 60 * 1_000;
/**
 * Between `SIGTERM` and `SIGKILL`, and again between `SIGKILL` and giving up on
 * the child entirely.  A wedged worker pool will not tidy up in 5 s, but a bun
 * that is merely slow to exit will — and an unkillable child must not become an
 * unkillable harness, which is the failure this whole watchdog removes.
 */
const KILL_GRACE_MS = 5_000;

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

/**
 * Flags before path filters, `--name=value` only.  Deliberately hand-rolled:
 * `node:util`'s `parseArgs` would have to be told about the pass-through
 * filters, which is more configuration than three options are worth.
 */
export function parseArguments(argv) {
  const options = {
    runs: Number(process.env.ACTOR_TS_STRESS_RUNS ?? DEFAULT_RUNS),
    concurrency: Number(process.env.ACTOR_TS_STRESS_CONCURRENCY ?? '1'),
    maximumFlakyTests: Number(
      process.env.ACTOR_TS_STRESS_MAX_FLAKY ?? DEFAULT_MAXIMUM_FLAKY_TESTS,
    ),
    runTimeoutMs: Number(
      process.env.ACTOR_TS_STRESS_RUN_TIMEOUT_MS ?? DEFAULT_RUN_TIMEOUT_MS,
    ),
    reportDirectory: process.env.ACTOR_TS_STRESS_REPORT_DIR ?? DEFAULT_REPORT_DIRECTORY,
    randomize: process.env.ACTOR_TS_STRESS_RANDOMIZE === '1',
    seed: process.env.ACTOR_TS_STRESS_SEED === undefined
      ? undefined
      : Number(process.env.ACTOR_TS_STRESS_SEED),
    filters: [],
  };
  for (const argument of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match) {
      options.filters.push(argument);
      continue;
    }
    const [, name, value] = match;
    switch (name) {
      case 'runs': options.runs = Number(value); break;
      case 'concurrency': options.concurrency = Number(value); break;
      case 'max-flaky': options.maximumFlakyTests = Number(value); break;
      case 'run-timeout': options.runTimeoutMs = Number(value); break;
      case 'report-dir': options.reportDirectory = value ?? DEFAULT_REPORT_DIRECTORY; break;
      case 'randomize': options.randomize = true; break;
      // A seed implies the shuffle it seeds: `--seed` alone would be silently
      // inert, which is the shape of a flag that looks obeyed and is not.
      case 'seed': options.seed = Number(value); options.randomize = true; break;
      case 'help': printUsage(); process.exit(0); break;
      default:
        console.error(`stress-test: unknown option "${argument}" (try --help)`);
        process.exit(2);
    }
  }
  return options;
}

function printUsage() {
  console.log(`Usage: bun run test:stress [-- <options>] [<bun test path filters>]

  --runs=N              how many times to run the suite      (default ${DEFAULT_RUNS})
  --concurrency=N       runs executed at once                (default 1)
  --max-flaky=N         tests allowed to fail at least once  (default ${DEFAULT_MAXIMUM_FLAKY_TESTS})
  --run-timeout=MS      one run's watchdog, then it is a HANG (default ${DEFAULT_RUN_TIMEOUT_MS})
  --report-dir=DIR      where reports and logs are written   (default ${DEFAULT_REPORT_DIRECTORY})
  --randomize           shuffle test order, to surface order dependence
  --seed=N              fix the shuffle's seed (implies --randomize)
  --help                this text

Every option also reads an env var: ACTOR_TS_STRESS_RUNS, _CONCURRENCY,
_MAX_FLAKY, _RUN_TIMEOUT_MS, _REPORT_DIR, _RANDOMIZE, _SEED.

Keep --run-timeout x --runs (divided by --concurrency) safely under the CI
job's timeout-minutes: the point of the watchdog is that a hang produces a
report, and it cannot if the job is killed first.`);
}

function validate(options) {
  const positiveInteger = (value, name) =>
    Number.isInteger(value) && value > 0
      ? undefined
      : `stress-test: ${name} must be a positive integer, got ${value}`;
  const problems = [
    positiveInteger(options.runs, '--runs'),
    positiveInteger(options.concurrency, '--concurrency'),
    positiveInteger(options.runTimeoutMs, '--run-timeout'),
    Number.isInteger(options.maximumFlakyTests) && options.maximumFlakyTests >= 0
      ? undefined
      : `stress-test: --max-flaky must be a non-negative integer, got ${options.maximumFlakyTests}`,
  ].filter((problem) => problem !== undefined);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(2);
  }
}

/* ------------------------------------------------------------------ */
/* JUnit report                                                        */
/* ------------------------------------------------------------------ */

const NAMED_XML_ENTITIES = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
]);

/**
 * Test names reach the report as attribute values, so a name containing `&`,
 * `<` or a quote comes back escaped.  Decoding matters for identity, not for
 * looks: `expect(a && b)` and `expect(a &amp;&amp; b)` would otherwise count
 * as two different tests across runs written by two bun versions.
 */
export function unescapeXml(value) {
  return value.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|[a-zA-Z]+);/g, (entity, hex, decimal) => {
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return NAMED_XML_ENTITIES.get(entity) ?? entity;
  });
}

/**
 * The attribute list is matched as a whole rather than scanning to the first
 * `>`: XML does not require `>` to be escaped inside an attribute value, and
 * a test named `expect(a > b)` would otherwise truncate the tag mid-way and
 * lose every attribute after it.
 */
const TESTCASE_TAG = /<testcase\b((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*"[^"]*")*)\s*(\/)?>/g;
const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
const SUMMARY_TAG = /<testsuites\b((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*"[^"]*")*)\s*\/?>/;

export function attributesOf(source) {
  const attributes = new Map();
  for (const match of source.matchAll(ATTRIBUTE)) {
    attributes.set(match[1], unescapeXml(match[2]));
  }
  return attributes;
}

/**
 * Paths are normalised to repository-relative POSIX form because the same
 * test carries a different `file` attribute depending on how the run was
 * invoked (`tests\Actor.test.ts` on a Windows clone, an absolute path when
 * the filter was absolute).  Identity has to survive that or a nightly
 * artifact cannot be compared with a laptop's.
 */
export function normalisePath(value) {
  const posix = value.replaceAll('\\', '/');
  const root = process.cwd().replaceAll('\\', '/');
  return posix.startsWith(`${root}/`) ? posix.slice(root.length + 1) : posix;
}

/** A test's identity across runs: where it lives, which describe it is in, its name. */
export function identityOf({ file, suite, name }) {
  return `${file} :: ${suite === '' ? '(top level)' : suite} :: ${name}`;
}

/**
 * A passing testcase is self-closing; a failing or skipped one carries a
 * `<failure>` / `<error>` / `<skipped>` child.  That is the whole contract
 * this parser needs, and it is the same one `test.yml` reads its badge counts
 * from — chosen over bun's console summary because the console output is
 * presentation and already vanished once under GitHub Actions (#1194).
 */
export function parseReport(xml) {
  const failures = [];
  let executed = 0;
  let skipped = 0;
  for (const match of xml.matchAll(TESTCASE_TAG)) {
    const attributes = attributesOf(match[1]);
    const testCase = {
      file: normalisePath(attributes.get('file') ?? ''),
      suite: attributes.get('classname') ?? '',
      name: attributes.get('name') ?? '',
    };
    if (match[2] === '/') {
      executed++;
      continue;
    }
    const bodyEnd = xml.indexOf('</testcase>', match.index + match[0].length);
    const body = bodyEnd < 0 ? '' : xml.slice(match.index + match[0].length, bodyEnd);
    if (/<skipped\b/.test(body)) {
      skipped++;
      continue;
    }
    executed++;
    if (/<(?:failure|error)\b/.test(body)) failures.push(testCase);
  }
  return { executed, skipped, failures };
}

/** The root element's own totals — a cross-check on the per-testcase scan. */
export function parseSummary(xml) {
  const match = SUMMARY_TAG.exec(xml);
  if (!match) return undefined;
  const attributes = attributesOf(match[1]);
  const number = (key) => {
    const value = Number(attributes.get(key));
    return Number.isFinite(value) ? value : undefined;
  };
  return { tests: number('tests'), failures: number('failures'), skipped: number('skipped') };
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

/**
 * bun's output goes to a file descriptor the child owns, never to a pipe we
 * read.  Under GitHub Actions bun emits one annotation line per test — an
 * ~8700-line burst for this suite — and pushing that through a pipe is how
 * bun came to die mid-flush with `WriteFailed`, truncating the run and taking
 * the JUnit report with it (#1194).  A regular file cannot short-write that
 * way, and the log is what the nightly uploads anyway.
 *
 * **A run that never exits is the third outcome, and the one that matters.**
 * The quarantined multi-node suites' documented failure on hosted runners is
 * not a failure at all: workers spawn, handshake and then never run, so
 * `bun test` does not exit.  Listening only for `error` and `close` meant this
 * promise never settled, the loop never advanced, and the nightly job sat
 * until its `timeout-minutes` and was killed — no per-run report, no
 * aggregate.  The one measurement the harness exists to make was the one it
 * could not survive.  `timeoutMs` bounds it; the run is then recorded as a
 * hang and the loop goes on, because whether run 2 hangs as well is data.
 */
/**
 * The extra flags the harness hands to each child `bun test`.
 *
 * Only order control lives here.  The reporter flags are added at the spawn
 * because they are how the harness reads a run at all, and a caller must not be
 * able to turn them off.
 */
export function bunArgumentsFor(options) {
  const bunArguments = [];
  if (options.randomize) bunArguments.push('--randomize');
  if (options.seed !== undefined && Number.isFinite(options.seed)) {
    bunArguments.push(`--seed=${options.seed}`);
  }
  return bunArguments;
}

/**
 * The seed bun shuffled a run with, recovered from that run's log.
 *
 * bun prints `--seed=N` in its own summary whenever the order was randomised,
 * so the number that reproduces a run is already written down — it just lives
 * in a log that ages out.  Lifting it into `summary.json` is what makes an
 * order-dependent failure re-runnable a week later from an artifact, which is
 * the whole difference between "this test is flaky" and "this test fails after
 * that one".
 *
 * `undefined` when the run was not randomised, which is the normal case.
 */
export function seedOf(log) {
  const match = /--seed=([0-9]+)/.exec(log);
  return match === null ? undefined : Number(match[1]);
}

/** A run's log, or the empty string when it could not be read. */
function readLog(logPath) {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

function runOnce({ index, reportPath, logPath, filters, bunArguments, environment, timeoutMs }) {
  return new Promise((resolveRun) => {
    const logDescriptor = openSync(logPath, 'w');
    const startedAt = Date.now();
    const child = spawn(
      'bun',
      ['test', ...filters, ...bunArguments, '--reporter=junit', `--reporter-outfile=${reportPath}`],
      { stdio: ['ignore', logDescriptor, logDescriptor], env: environment, shell: false },
    );
    // A failed spawn emits `error` and then `close`, so both handlers fire for
    // one run.  Without the guard the second `closeSync` throws `EBADF` from
    // inside an event handler and takes the whole harness down — turning "one
    // run could not start" into "no results at all".
    let settled = false;
    let timedOut = false;
    const timers = [];
    const finish = (status, spawnError) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      closeSync(logDescriptor);
      resolveRun({ index, status, spawnError, timedOut, durationMs: Date.now() - startedAt });
    };
    timers.push(setTimeout(() => {
      timedOut = true;
      // Into the run's own log, so the artifact says why it stops mid-suite
      // instead of just ending — the log is the only place the wedged test's
      // name still exists.  Guarded because it is a nicety: a write that fails
      // here must not skip the kill below and leave the harness stuck, which
      // is the exact failure this watchdog exists to remove.
      try {
        writeSync(
          logDescriptor,
          `\n[stress-test] run ${index} exceeded --run-timeout=${timeoutMs}ms `
          + 'and never exited; terminating.  The last test named above is where it wedged.\n',
        );
      } catch { /* the log is best-effort; the kill is not */ }
      child.kill('SIGTERM');
      timers.push(setTimeout(() => {
        child.kill('SIGKILL');
        // Even SIGKILL can leave us waiting on a `close` that never comes if
        // the child is stuck in an uninterruptible state.  Settle anyway: the
        // whole point is that no single run can stall the loop.
        timers.push(setTimeout(() => { finish(null, undefined); }, KILL_GRACE_MS));
      }, KILL_GRACE_MS));
    }, timeoutMs));
    child.on('error', (error) => { finish(null, error); });
    child.on('close', (status) => { finish(status, undefined); });
  });
}

/**
 * A run that produced no report is the worst outcome, not a missing one: bun
 * died before the reporter flushed, so the run's failure identity is gone and
 * the aggregate silently gets smaller.  It is recorded as its own kind of
 * result rather than folded into "0 failures".
 */
export function collectRun(result, reportPath) {
  const base = { ...result, executed: 0, skipped: 0, failures: [], reportMissing: false };
  // A hang has its own diagnosis, so it must not also be filed as "bun died
  // before the reporter flushed": the report is missing *because* the run was
  // killed, and reporting both would send a reader after the wrong cause.
  if (result.timedOut) return base;
  if (!existsSync(reportPath)) return { ...base, reportMissing: true };
  const xml = readFileSync(reportPath, 'utf8');
  if (xml.trim() === '') return { ...base, reportMissing: true };
  const parsed = parseReport(xml);
  return { ...base, ...parsed, summary: parseSummary(xml) };
}

/** Runs `total` iterations with at most `concurrency` in flight. */
async function runAll(options, environment, reportDirectory) {
  const results = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= options.runs) return;
      const reportPath = join(reportDirectory, `run-${index + 1}.junit.xml`);
      const logPath = join(reportDirectory, `run-${index + 1}.log`);
      const result = await runOnce({
        index: index + 1,
        reportPath,
        logPath,
        filters: options.filters,
        bunArguments: bunArgumentsFor(options),
        environment,
        timeoutMs: options.runTimeoutMs,
      });
      const collected = { ...collectRun(result, reportPath), seed: seedOf(readLog(logPath)) };
      results[index] = collected;
      reportRun(collected, logPath);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.runs) }, () => worker()),
  );
  return results;
}

function reportRun(run, logPath) {
  const seconds = (run.durationMs / 1_000).toFixed(1);
  if (run.timedOut) {
    console.log(
      `  run ${run.index}: HUNG — still running after ${seconds}s, killed. `
      + `Nothing can be said about the tests in it; see ${logPath} for where it stopped.`,
    );
    return;
  }
  if (run.reportMissing) {
    console.log(
      `  run ${run.index}: NO REPORT after ${seconds}s `
      + `(exit ${run.spawnError ? run.spawnError.message : run.status}) — see ${logPath}`,
    );
    return;
  }
  const verdict = run.failures.length === 0 ? 'green' : `${run.failures.length} failed`;
  const seed = run.seed === undefined ? '' : `, seed ${run.seed}`;
  console.log(
    `  run ${run.index}: ${verdict} — ${run.executed} executed, ${run.skipped} skipped, ${seconds}s${seed}`,
  );
  for (const failure of run.failures) console.log(`      ✗ ${identityOf(failure)}`);
}

/* ------------------------------------------------------------------ */
/* Aggregation + output                                                */
/* ------------------------------------------------------------------ */

export function aggregate(results, runs) {
  const byIdentity = new Map();
  for (const run of results) {
    // One identity may fail more than once inside a single run — a hook
    // timeout reported per test in the block, a `test.each` row, a retry.
    // `failedRuns` counts *runs*, so the run index goes in once however many
    // testcases carried it; counting occurrences instead put `failedRuns.length`
    // above `runs`, which matched neither the flaky filter (`< runs`) nor the
    // consistent one (`=== runs`), and the offender fell out of both tables,
    // out of `summary.json` and out of the step summary the nightly is read
    // from — while the harness printed PASS over a set of runs that were 0/16
    // green (#1359).  `failureCount` keeps the occurrence count, which is real
    // information, without letting it decide the classification.
    const seenInRun = new Set();
    for (const failure of run.failures) {
      const key = identityOf(failure);
      const entry = byIdentity.get(key)
        ?? { ...failure, identity: key, failedRuns: [], failureCount: 0 };
      entry.failureCount += 1;
      if (!seenInRun.has(key)) {
        seenInRun.add(key);
        entry.failedRuns.push(run.index);
      }
      byIdentity.set(key, entry);
    }
  }
  const offenders = [...byIdentity.values()].sort(
    (a, b) => b.failedRuns.length - a.failedRuns.length || a.identity.localeCompare(b.identity),
  );
  const reportedRuns = results.filter((run) => !run.reportMissing && !run.timedOut);
  const totalExecuted = reportedRuns.reduce((sum, run) => sum + run.executed, 0);
  const totalFailures = reportedRuns.reduce((sum, run) => sum + run.failures.length, 0);
  return {
    runs,
    greenRuns: reportedRuns.filter((run) => run.failures.length === 0 && run.status === 0).length,
    // The outcome the quarantined suites are expected to produce, kept apart
    // from every other kind of red: a hang says the suite stopped making
    // progress, which is a different fact from a test failing.
    runsTimedOut: results.filter((run) => run.timedOut).map((run) => run.index),
    runsWithoutReport: results.filter((run) => run.reportMissing).map((run) => run.index),
    // A non-zero exit with no recorded failure is its own signal: an
    // unreleased handle, a crash in teardown, a bun-level error.  Naming it
    // separately stops it from reading as a green run.
    runsRedWithoutFailures: reportedRuns
      .filter((run) => run.status !== 0 && run.failures.length === 0)
      .map((run) => run.index),
    totalExecuted,
    totalFailures,
    // A run that reported failing tests and yet is named by no offender means
    // the identity map lost it — the #1359 shape, one level up.  It is empty by
    // construction now, and it is computed anyway for the same reason
    // `runsRedWithoutFailures` is: the verdict should be able to say "something
    // escaped" rather than quietly getting smaller.
    unexplainedRedRuns: reportedRuns
      .filter((run) => run.failures.length > 0)
      .filter((run) => !offenders.some((entry) => entry.failedRuns.includes(run.index)))
      .map((run) => run.index),
    flaky: offenders.filter((entry) => entry.failedRuns.length < runs),
    // `>=` rather than `===`: an off-by-one anywhere upstream should widen the
    // "broken" bucket, never re-open the hole that let an offender vanish.
    consistent: offenders.filter((entry) => entry.failedRuns.length >= runs),
  };
}

function formatTable(entries, runs) {
  return entries
    .map((entry) => {
      const percent = ((entry.failedRuns.length / runs) * 100).toFixed(0);
      // Occurrences are named only when they exceed the run count, because
      // that is the case a reader would otherwise mis-read: "failed 3 of 5
      // runs" and "produced 7 failing testcases" are different facts, and a
      // hook timeout collapsing a whole block is what makes them differ.
      const occurrences = entry.failureCount > entry.failedRuns.length
        ? ` — ${entry.failureCount} failing testcases in total`
        : '';
      return `  ${String(entry.failedRuns.length).padStart(3)}/${runs} (${percent.padStart(3)}%)  `
        + `${entry.identity}${occurrences}\n        runs: ${entry.failedRuns.join(', ')}`;
    })
    .join('\n');
}

export function render(aggregated, options) {
  const lines = [];
  lines.push('');
  lines.push('===== stress summary =====');
  lines.push(`runs:            ${aggregated.greenRuns}/${aggregated.runs} green`);
  lines.push(`test executions: ${aggregated.totalExecuted}`);
  const rate = aggregated.totalExecuted === 0
    ? 'n/a'
    : `${((aggregated.totalFailures / aggregated.totalExecuted) * 100).toFixed(4)}%`;
  lines.push(`failure rate:    ${aggregated.totalFailures} / ${aggregated.totalExecuted} = ${rate}`);
  if (aggregated.runsTimedOut.length > 0) {
    lines.push('');
    lines.push(
      `!! ${aggregated.runsTimedOut.length} run(s) never exited `
      + `(${aggregated.runsTimedOut.join(', ')}) — killed after --run-timeout=${options.runTimeoutMs}ms. `
      + 'A hang, not a failure: the suite stopped making progress, so nothing '
      + 'can be said about the tests in those runs. Read the matching .log for '
      + 'the last test it reached.',
    );
  }
  if (aggregated.runsWithoutReport.length > 0) {
    lines.push('');
    lines.push(
      `!! ${aggregated.runsWithoutReport.length} run(s) produced no JUnit report `
      + `(${aggregated.runsWithoutReport.join(', ')}) — bun died before the reporter flushed. `
      + 'Their failures are NOT in the counts above; read the matching .log.',
    );
  }
  if (aggregated.runsRedWithoutFailures.length > 0) {
    lines.push(
      `!! run(s) ${aggregated.runsRedWithoutFailures.join(', ')} exited non-zero with no failing `
      + 'test — a crash, an unreleased handle, or an error outside a test body.',
    );
  }
  if (aggregated.unexplainedRedRuns.length > 0) {
    lines.push(
      `!! run(s) ${aggregated.unexplainedRedRuns.join(', ')} reported failing tests that no offender `
      + 'below accounts for. That is a defect in this harness rather than in the suite: the identity '
      + 'map lost a failure, so the tables and summary.json are smaller than the truth.',
    );
  }
  if (aggregated.flaky.length > 0) {
    lines.push('');
    lines.push(`FLAKY — failed in some runs but not all (${aggregated.flaky.length}):`);
    lines.push(formatTable(aggregated.flaky, aggregated.runs));
  }
  if (aggregated.consistent.length > 0) {
    lines.push('');
    lines.push(
      `CONSISTENTLY FAILING — failed in every run (${aggregated.consistent.length}). `
      + 'Broken, not flaky; repetition tells you nothing more about these:',
    );
    lines.push(formatTable(aggregated.consistent, aggregated.runs));
  }
  if (aggregated.flaky.length === 0 && aggregated.consistent.length === 0) {
    lines.push('');
    // Qualified when a run went missing: "no test failed" over zero observed
    // runs is a true sentence and a false reassurance.  A hang silences a run
    // exactly as thoroughly as a truncated report does, so it counts here too.
    const silentRuns = new Set([...aggregated.runsWithoutReport, ...aggregated.runsTimedOut]);
    // ... and qualified again when a run reported failures the tables do not
    // carry.  "No test failed" printed over a set of runs that were 0/16 green
    // is the sentence #1359 is named for, and it must not be reachable while
    // any red run is unaccounted for.
    lines.push(
      aggregated.unexplainedRedRuns.length > 0
        ? 'No test could be named for the failures above, which is a harness defect — see the line marked !!.'
        : silentRuns.size === aggregated.runs
          ? 'No run reported anything, so nothing can be said about any test.'
          : 'No test failed in any run that reported.',
    );
  }
  return lines.join('\n');
}

/**
 * A nightly job's log is read once, when it goes red.  The step summary is
 * read from the run list, so the offender names belong there — otherwise the
 * decision "was tonight green?" costs a log download.
 */
function writeStepSummary(aggregated, options) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path === undefined || path === '') return;
  const scope = options.filters.length === 0 ? 'whole suite' : options.filters.join(', ');
  const rows = [...aggregated.flaky, ...aggregated.consistent]
    .map((entry) => `| ${entry.failedRuns.length}/${aggregated.runs} | \`${entry.identity}\` |`)
    .join('\n');
  const body = [
    `### Stress run — ${scope}`,
    '',
    `- **${aggregated.greenRuns}/${aggregated.runs}** runs green`,
    `- **${aggregated.totalFailures}** failures across **${aggregated.totalExecuted}** test executions`,
    // A hang is the outcome the quarantined suites are most likely to produce,
    // so it belongs in the summary a human reads from the run list rather than
    // only in a log they would have to download to find it.
    ...(aggregated.runsTimedOut.length > 0
      ? [`- ⛔ runs that never exited (killed after ${options.runTimeoutMs}ms): `
        + `${aggregated.runsTimedOut.join(', ')}`]
      : []),
    ...(aggregated.runsWithoutReport.length > 0
      ? [`- ⚠️ runs without a JUnit report: ${aggregated.runsWithoutReport.join(', ')}`]
      : []),
    '',
    ...(rows === ''
      ? ['No test failed in any run that reported.']
      : ['| failed | test |', '| --- | --- |', rows]),
    '',
  ].join('\n');
  appendFileSync(path, body);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

/**
 * Everything with a side effect, in one function.
 *
 * It is a function rather than module-scope statements for a single reason:
 * `import.meta.main` below has to be able to *not* run it.  A test that imports
 * `parseReport` must not thereby wipe a report directory and start N `bun test`
 * children, which is exactly what module-scope statements did.
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  validate(options);

  const reportDirectory = resolve(process.cwd(), options.reportDirectory);
  rmSync(reportDirectory, { recursive: true, force: true });
  mkdirSync(reportDirectory, { recursive: true });

  const environment = { ...process.env };

  console.log(`stress-test: ${options.runs} run(s), concurrency ${options.concurrency}`);
  if (options.filters.length > 0) console.log(`stress-test: filters — ${options.filters.join(' ')}`);
  console.log(`stress-test: reports in ${relative(process.cwd(), reportDirectory) || '.'}`);
  if (options.concurrency > 1) {
    console.log(
      'stress-test: concurrency > 1 puts real contention on the machine, which is what '
      + 'a load-sensitive flake needs — but parallel runs also share ports, temp roots '
      + 'and the filesystem, so cross-run interference can show up as a flake that a '
      + 'single run never has.  Confirm anything it finds at concurrency 1.',
    );
  }

  const results = await runAll(options, environment, reportDirectory);
  const aggregated = aggregate(results, options.runs);

  console.log(render(aggregated, options));
  writeFileSync(
    join(reportDirectory, 'summary.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        // What produced these numbers.  A night is comparable with another
        // night only while the toolchain is the same one — the quarantine's
        // exit criterion says so in prose and could not check it, because the
        // artifact never recorded which bun ran.
        bunVersion: process.versions.bun ?? null,
        runs: aggregated.runs,
        greenRuns: aggregated.greenRuns,
        filters: options.filters,
        randomized: options.randomize,
        totalExecuted: aggregated.totalExecuted,
        totalFailures: aggregated.totalFailures,
        runTimeoutMs: options.runTimeoutMs,
        runsTimedOut: aggregated.runsTimedOut,
        runsWithoutReport: aggregated.runsWithoutReport,
        runsRedWithoutFailures: aggregated.runsRedWithoutFailures,
        unexplainedRedRuns: aggregated.unexplainedRedRuns,
        // Per run, so a reader can tell a slow night from a failing one and can
        // reproduce an order-dependent failure from the artifact alone.  The
        // aggregate hid both: a run that took four times as long as its
        // siblings and a run shuffled into a losing order look identical in a
        // count of green runs.
        runsDetail: results.map((run) => ({
          index: run.index,
          status: run.status,
          durationMs: run.durationMs,
          executed: run.executed,
          skipped: run.skipped,
          failures: run.failures.length,
          timedOut: run.timedOut,
          reportMissing: run.reportMissing,
          seed: run.seed ?? null,
        })),
        offenders: [...aggregated.flaky, ...aggregated.consistent].map((entry) => ({
          identity: entry.identity,
          file: entry.file,
          suite: entry.suite,
          name: entry.name,
          failedRuns: entry.failedRuns,
          failureCount: entry.failureCount,
        })),
      },
      null,
      2,
    )}\n`,
  );
  writeStepSummary(aggregated, options);

  const offenderCount = aggregated.flaky.length + aggregated.consistent.length;
  // Named separately from "did not report", because the two point at different
  // things: a hang means the suite stopped, a missing report means bun died
  // while writing.  Both are red — a run whose result is unknown can never be
  // counted towards a green night — but they are not the same finding.
  if (aggregated.runsTimedOut.length > 0) {
    console.error(
      `\nstress-test: FAIL — ${aggregated.runsTimedOut.length} run(s) never exited `
      + `(${aggregated.runsTimedOut.join(', ')}).`,
    );
    process.exit(1);
  }
  if (aggregated.runsWithoutReport.length > 0 || aggregated.runsRedWithoutFailures.length > 0) {
    console.error('\nstress-test: FAIL — a run did not report its result.');
    process.exit(1);
  }
  if (aggregated.unexplainedRedRuns.length > 0) {
    console.error(
      `\nstress-test: FAIL — run(s) ${aggregated.unexplainedRedRuns.join(', ')} reported failing `
      + 'tests that no offender accounts for. Fix the harness before believing this run.',
    );
    process.exit(1);
  }
  if (offenderCount > options.maximumFlakyTests) {
    console.error(
      `\nstress-test: FAIL — ${offenderCount} test(s) failed at least once, budget is `
      + `${options.maximumFlakyTests}.`,
    );
    process.exit(1);
  }
  // The last gate, and the one that cannot be escaped by a future shape the
  // identity map mishandles.  Every check above is a statement about *tests*;
  // this one is a statement about *runs*, which is the field the quarantine's
  // exit criterion is written in ("greenRuns == runs") and the one the verdict
  // used to compute, print, and then not act on.  A run that was not green and
  // that no tolerated offender explains is red however the tables read (#1359).
  const runsExplainedByOffenders = new Set(
    [...aggregated.flaky, ...aggregated.consistent].flatMap((entry) => entry.failedRuns),
  );
  const unaccounted = aggregated.runs - aggregated.greenRuns - runsExplainedByOffenders.size;
  if (unaccounted > 0) {
    console.error(
      `\nstress-test: FAIL — only ${aggregated.greenRuns} of ${aggregated.runs} run(s) were green and `
      + `${unaccounted} of the rest are explained by nothing this harness can name.`,
    );
    process.exit(1);
  }
  console.log(`\nstress-test: PASS (${aggregated.greenRuns}/${aggregated.runs} runs green)`);
}

// The seam the harness's own tests need.  `bun scripts/stress-test.mjs` — how
// `bun run test:stress` and every CI job invoke it — is the entry point, so
// this is true and the behaviour is unchanged; an `import` of the same file is
// not, so the classifier can be examined without being run.
if (import.meta.main) await main();
