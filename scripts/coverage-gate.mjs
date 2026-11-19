#!/usr/bin/env bun
/**
 * Coverage-floor gate (#294, #541).
 *
 * Two floors, measured from the two artifacts of a single
 * `bun test --coverage` run:
 *
 *   - the **aggregate** line-coverage floor, `Σ LH / Σ LF` over every lcov
 *     record under {@link AGGREGATE_PREFIX} (#1016).  `COVERAGE_LINE_FLOOR`
 *     overrides {@link DEFAULT_LINE_FLOOR};
 *   - **per-module** line-coverage floors for the subsystems where an
 *     unnoticed regression is the expensive kind, read from the lcov report.
 *     {@link MODULE_LINE_FLOORS} is the only place they are configured.
 *
 *   bun run test:coverage:gate                       # run the suite, then gate
 *   bun scripts/coverage-gate.mjs \
 *     --lcov=<lcov.info> [--log=<bun-test.log>]      # gate captured artifacts
 *
 * **This file is the only coverage parser in the repository.**
 * `.github/workflows/test.yml` used to re-derive the aggregate in bash — `grep
 * "^All files" | awk -F'|' '{print $3}'`, then `${LINES%.*}` and an integer
 * compare — and enforced the floor from *that* number, so the figure CI gated
 * and the figure this script gated were two implementations that agreed only
 * because the floor happened to be a whole number.  The workflow now runs the
 * suite once and hands both of its artifacts to the second form above; the
 * badge integer it publishes comes back out of this file too (see
 * {@link badgeLineCoverage}).  One parse, one floor, one place to change
 * either.  #541, #1016.
 *
 * **Every floor is `Σ LH / Σ LF` from lcov, the aggregate included (#1016).**
 * Bun prints a percentage per file, and the `All files` row of its text table
 * is the unweighted mean of those percentages: a 1000-line coordinator at 40 %
 * is cancelled out by ten 12-line barrels at 100 %.  lcov carries `LF:` / `LH:`
 * counts per file, so a population is `Σ LH / Σ LF`, weighted by the lines
 * that actually exist.  The per-module floors were always computed that way.
 * The aggregate kept reading the row until v0.19.0, for one reason: that cell
 * is what the README badge had published for its whole history, and changing
 * the statistic underneath it moves the front-page number.  #1016 is that
 * change, made deliberately and in its own commit.  The aggregate is now the
 * rollup over {@link AGGREGATE_PREFIX}, and the badge publishes the same
 * figure.
 *
 * Restricting it to `src/` is what makes it product-code coverage *by
 * construction*.  Bun 1.4.0 changed the default of `coverageSkipTestFiles`, so
 * test files no longer appear in the report.  This was measured on 2026-08-25
 * by A/B over `tests/unit/util/Lazy.test.ts`: with `bunfig.toml` as committed
 * the report holds the single row `src/util/Lazy.ts`, and an explicit
 * `coverageSkipTestFiles = false` brings the test file back.  A toolchain
 * default can flip again, though.  A prefix cannot match a test file.
 *
 * The row is still printed when `--log` hands this script a table, labelled as
 * bun's per-file mean, so a reader comparing the badge with an older run can
 * see both numbers.  It decides nothing.
 *
 * **`--lcov` exists so CI never runs the suite twice.**  Without it the script
 * runs `bun test --coverage` itself.  That is right for a developer and wrong
 * for `test.yml`, where the suite has already run once on purpose; the
 * workflow's header records the two-runs-two-numbers failure that the single
 * run was introduced to remove.  The lcov report carries every number the gate
 * decides on, so it is the one artifact that turns this file into a pure gate
 * over someone else's run.  `--log` alone is refused, because it can gate
 * nothing, and a gate that reports PASS having evaluated none of itself is the
 * failure mode #1194 taught this repository to write assertions against.
 *
 * **`GITHUB_OUTPUT`, when the environment sets it.**  The workflow's `badge`
 * job renders `coverage-~N%` from a step output, and that output used to come
 * from the bash parse this file replaced.  So the gate publishes `lines=` on
 * its way through — *before* it decides anything, because a run that fails the
 * floor is precisely a run whose true figure the README should be showing.
 *
 * The pure functions below are exported (typed by `coverage-gate.d.mts`) and
 * the driver runs under `import.meta.main`, so
 * `tests/unit/ci/CoverageGate.test.ts` can drive the rollup against synthetic
 * lcov instead of against a live suite — where a wrong verdict is
 * indistinguishable from a real regression.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The aggregate floor.  **This is the only place it is configured** — the same
 * rule {@link MODULE_LINE_FLOORS} has, and for the same reason: an env var in a
 * workflow file is a second place the number lives and a way to loosen the gate
 * without the loosening appearing in a diff of the gate.  `test.yml` used to
 * carry `COVERAGE_LINE_FLOOR: '80'`; it no longer sets it, and
 * `tests/unit/ci/CoverageGate.test.ts` fails if it comes back or if `AGENTS.md`
 * stops quoting this value.  `COVERAGE_LINE_FLOOR` still overrides it for a
 * local experiment, which is why the workflow not setting it is asserted rather
 * than assumed.
 *
 * **90, ratcheted from 80 on 2026-08-25 (#541).**  The measurement the ratchet
 * policy in `AGENTS.md` requires beside the number, taken when three suites
 * were still removed from the CI population by `ACTOR_TS_SKIP_FLAKY_MNS=1`
 * (8186 pass / 35 skip across 522 files, bun 1.4.0).  **Re-measured
 * 2026-09-07 over the whole suite, now that nothing is quarantined: 94.39 %
 * aggregate, 11 664 pass across 615 files** — so the floor has more headroom
 * than these figures show, not less:
 *
 *   bun `All files` % Lines (what this floor gates) ....... 93.63 %
 *   Σ LH / Σ LF over the same 679 lcov records ............ 92.85 %
 *   Σ LH / Σ LF over the 636 records under `src/` ......... 93.81 %
 *   hosted CI, README badge bot, 2026-08-22 (`d219e970`) ... 93 %
 *
 * **Re-measured 2026-09-10 on the bun 1.4.2 pin (#1519): 94.61 % aggregate,
 * 13 943 pass across 643 files**, with `src/cluster/` at 97.79 % (9805/10027)
 * and `src/persistence/` at 96.20 % (10978/11412).  Every figure is above its
 * 2026-09-07 reading, so the toolchain bump moved the headroom up rather than
 * down, and all three floors stay where they are — the ratchet only goes up,
 * and a floor is raised on a hosted number rather than a local one.
 *
 * **Re-measured 2026-11-14 for #1016, which made the aggregate `Σ LH / Σ LF`
 * over `src/` instead of the `All files` row.**  On the pinned bun 1.4.2,
 * 22 640 pass across 953 files, the new statistic reads **97.34 %**
 * (66008/67811 lines, 736 files), against **96.49 %** for the old row over the
 * same run.  The weighted figure is the *higher* of the two on this tree, so
 * the switch moved the headroom up and the floor stays at 90.  A cautionary
 * figure from the same day: the same tree measured under bun 1.4.4 reads
 * 94.96 % weighted and 94.35 % as the row, so a toolchain bump alone moves the
 * aggregate by more than two points.  The badge changes with the statistic and
 * with the runtime, never on its own, which is why the pin matters to it.
 *
 * Three properties are what make 90 safe to enforce rather than merely true
 * today.  The gap that forced `83b0a4af` down from 89 to 80 — hosted CI
 * measuring 86 % against a higher local figure — has closed: hosted reads 93
 * and this machine reads 93.63, because the ~3-point local/hosted spread the
 * 2026-08-19 note recorded lived in the test-file rows bun 1.4.0 stopped
 * counting.  The floor clears *every* candidate statistic above, so #1016
 * switching the aggregate to the weighted figure cannot turn CI red on its own
 * fix — the objection that kept this at 80.  And the mean moves slowly by
 * construction: one new wholly-uncovered file shifts it by about 93/679 ≈ 0.14
 * points, so 3.6 points of headroom is roughly 25 files, which is a decision
 * rather than an accident.
 */
export const DEFAULT_LINE_FLOOR = 90;

/**
 * Per-module line-coverage floors, as `Σ LH / Σ LF` over every lcov record
 * whose repository-relative path starts with the key.
 *
 * Deliberately **not** overridable by an environment variable at all — the
 * aggregate floor keeps `COVERAGE_LINE_FLOOR` for local experiments, but no
 * workflow sets it any more.  An override in a workflow file is a second place
 * the number lives, and the one thing this table exists to prevent is a floor
 * that can be loosened without the loosening being visible in a diff of the
 * gate itself.
 *
 * The two entries are the subsystems #541 names, and they are the right two:
 * both coordinate distributed state, both fail in ways a unit test only catches
 * if it exists, and both are quoted in `83b0a4af`'s justification for the
 * aggregate floor ("product code (cluster, persistence, …) stays well above
 * it") — a claim that, until this table, nothing measured.
 *
 * **Re-measured 2026-09-07** over the whole suite.  The 2026-08-25 figures
 * beside them were taken while `ACTOR_TS_SKIP_FLAKY_MNS=1` removed
 * `LeaseMajority` and with it some of `src/cluster/`'s own coverage; nothing is
 * quarantined now, so the population is the same one CI runs:
 *
 *   src/cluster/      97.55 %  (9568/9808  lines,  90 files)   was 97.29 %
 *   src/persistence/  95.56 %  (10903/11409 lines, 166 files)  was 95.22 %
 *
 * Both moved *up* when the quarantined suites came back, which is the direction
 * the un-quarantining predicted and the reason it was worth re-measuring rather
 * than assuming.
 *
 * Both held to within a tenth of a point across ~500 added tests, which is the
 * evidence that would justify raising them — and the reason not to yet is that
 * these are still *local* numbers.  Wiring this script into `test.yml` (#541)
 * means the next hosted run prints a hosted figure for each module for the
 * first time; ratcheting on a number the enforcing machine has actually
 * produced is the whole lesson of `83b0a4af`, which lowered the aggregate floor
 * from 89 to 80 after hosted CI measured 86 % against a healthier local one.
 * Until then 90 buys 5–7 points of regression detection where there were none.
 *
 * Un-quarantining raises both, `src/cluster/` most — see step 5 of the checklist
 * in `docs/…/testing/diagnosing-flakes.mdx`.
 *
 * **What a per-module floor cannot see.**  bun instruments the modules a run
 * loads, so a *new* runtime file under one of these prefixes that no test
 * imports is absent from the report altogether and does not dilute the
 * denominator.  (Six files are absent today and all six are type-only —
 * `src/cluster/sharding/ShardInfo.ts`, `src/persistence/SnapshotStore.ts` and
 * four more — which is the correct outcome, not a hole.)  The floor catches
 * coverage *lost* in a floored module; "an entire feature arrived untested" is
 * still a review question.
 */
export const MODULE_LINE_FLOORS = Object.freeze({
  'src/cluster/': 90,
  'src/persistence/': 90,
});

/**
 * The population the aggregate floor and the README badge measure: every lcov
 * record under `src/`, rolled up as `Σ LH / Σ LF` exactly like a module floor
 * (#1016).  A prefix and not "everything in the report" so that no test file,
 * script or example can enter the denominator whatever bun's
 * `coverageSkipTestFiles` default happens to be.
 */
export const AGGREGATE_PREFIX = 'src/';

/** Where the script's own run leaves bun's lcov report.  Git-ignored. */
const COVERAGE_DIRECTORY = 'coverage';

/**
 * Normalise one lcov `SF:` path to a repository-relative POSIX path.
 *
 * **This is the difference between a per-module floor and a vacuous one.**  On
 * Windows bun writes `SF:src\cluster\Sharding.ts`; a prefix test against
 * `src/cluster/` matches nothing there, every module rolls up to zero records,
 * and — without {@link evaluateModuleFloors} treating that as a failure — every
 * floor would pass while measuring nothing at all.  Both halves are needed:
 * normalise here, and refuse to pass on an empty match there.
 *
 * Absolute paths are made relative when they sit under the repository, matched
 * case-insensitively because a Windows drive letter's case is not stable across
 * the tools that produce these files.
 */
export function normaliseCoveragePath(value) {
  let path = value.trim().replaceAll('\\', '/');
  const rootPrefix = `${REPOSITORY_ROOT.replaceAll('\\', '/').replace(/\/$/, '')}/`;
  if (path.toLowerCase().startsWith(rootPrefix.toLowerCase())) path = path.slice(rootPrefix.length);
  while (path.startsWith('./')) path = path.slice(2);
  return path;
}

/**
 * The `SF:` / `LF:` / `LH:` triples of an lcov report, one per source file.
 *
 * A record without both counts is dropped rather than defaulted to zero: bun
 * emits `LF:`/`LH:` for every file it instruments, so a missing pair means the
 * input is not the report this gate thinks it is, and inventing a 0/0 for it
 * would quietly move a module's weighted average.
 */
export function parseLcovRecords(text) {
  const records = [];
  let path;
  let linesFound;
  let linesHit;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      path = normaliseCoveragePath(line.slice(3));
      linesFound = undefined;
      linesHit = undefined;
      continue;
    }
    if (line.startsWith('LF:')) {
      linesFound = Number(line.slice(3));
      continue;
    }
    if (line.startsWith('LH:')) {
      linesHit = Number(line.slice(3));
      continue;
    }
    if (line !== 'end_of_record') continue;
    if (path !== undefined && Number.isFinite(linesFound) && Number.isFinite(linesHit)) {
      records.push({ path, linesFound, linesHit });
    }
    path = undefined;
    linesFound = undefined;
    linesHit = undefined;
  }
  return records;
}

/**
 * Roll `records` up over one path prefix.
 *
 * The percentage is `linesHit * 100 / linesFound` and not
 * `100 * (linesHit / linesFound)`: the multiplication is exact for every count
 * a coverage report can hold, so a module sitting exactly on its floor is not
 * failed by a rounding artefact in the last bit.
 */
export function rollUpModule(records, prefix) {
  let files = 0;
  let linesFound = 0;
  let linesHit = 0;
  for (const record of records) {
    if (!record.path.startsWith(prefix)) continue;
    files += 1;
    linesFound += record.linesFound;
    linesHit += record.linesHit;
  }
  return {
    prefix,
    files,
    linesFound,
    linesHit,
    percentage: linesFound === 0 ? undefined : (linesHit * 100) / linesFound,
  };
}

/**
 * Compare every floored module against its floor.
 *
 * A prefix that matched no record — or matched records with no measurable
 * lines — is `'no-records'`, which the driver treats as a failure.  That is the
 * point of the verdict existing: a mistyped prefix, a report from the wrong
 * directory and a Windows separator all present as "nothing matched", and all
 * three would otherwise read as a module comfortably above its floor.
 */
export function evaluateModuleFloors(records, floors = MODULE_LINE_FLOORS) {
  return Object.entries(floors).map(([prefix, floor]) => {
    const rolled = rollUpModule(records, prefix);
    if (rolled.percentage === undefined) {
      return { ...rolled, floor, kind: 'no-records' };
    }
    return { ...rolled, floor, kind: rolled.percentage < floor ? 'below-floor' : 'pass' };
  });
}

/**
 * The aggregate the floor gates and the badge publishes: the weighted rollup of
 * {@link AGGREGATE_PREFIX}.  `percentage` is `undefined` when nothing under the
 * prefix was measured, which the driver refuses to read as any figure at all.
 */
export function aggregateLineCoverage(records) {
  return rollUpModule(records, AGGREGATE_PREFIX);
}

/**
 * The line-coverage percentage from bun's text table.  Informational since
 * #1016: printed beside the weighted aggregate, never gated on.
 *
 * The table is `File | % Funcs | % Lines | Uncovered Line #s`, so line coverage
 * is the SECOND numeric column — `c35fd0c5` fixed this gate reading the first.
 * It was once shaped to match `.github/workflows/test.yml`'s `awk -F'|'
 * '{print $3}'`; that bash parse is gone and this is the only one left, so the
 * shape is now free to be strict.  It still is: the `% Funcs` cell has to be
 * numeric before the `% Lines` cell is captured, because a table whose columns
 * moved should read as unparseable rather than as a coverage figure taken from
 * the wrong column.
 */
export function parseAggregateLineCoverage(output) {
  const match = /^All files\s+\|\s+[0-9]+(?:\.[0-9]+)?\s+\|\s+([0-9]+(?:\.[0-9]+)?)/m
    .exec(output);
  if (match === null) return undefined;
  const percentage = Number(match[1]);
  return Number.isFinite(percentage) ? percentage : undefined;
}

/**
 * `--log=` / `--lcov=` — the captured artifacts of a run that already happened.
 *
 * `--lcov` carries every number the gate decides on; `--log` is optional and
 * only supplies bun's per-file mean for the printout.  `--log` alone is
 * refused, because the alternative is a gate that reports PASS having checked
 * none of its floors.
 */
export function parseArguments(argv) {
  const readFlag = (name) => {
    const prefix = `--${name}=`;
    const found = argv.filter((argument) => argument.startsWith(prefix)).at(-1);
    return found === undefined ? undefined : found.slice(prefix.length);
  };
  return { logPath: readFlag('log'), lcovPath: readFlag('lcov') };
}

/**
 * The aggregate as the README badge carries it: whole percent, truncated.
 *
 * Truncated and not rounded, because that is what the bash parse this replaced
 * did (`LINES_INT=${LINES%.*}`) and the badge is a number people compare across
 * commits.  Rounding would move `coverage-~93%` to `~94%` on a measurement that
 * had not moved — a change to README.md attributable to nothing but the
 * refactor that was supposed to leave the figure alone, pushed by the badge bot
 * with no diff to explain it.
 *
 * `Math.trunc` rather than `String(percentage).split('.')`: the string form of
 * a float is not something to parse when the numeric answer is exact.
 */
export function badgeLineCoverage(percentage) {
  return String(Math.trunc(percentage));
}

/**
 * Hand the workflow the badge figure through `GITHUB_OUTPUT`.
 *
 * A no-op everywhere else, so a developer's `bun run test:coverage:gate` writes
 * nothing.  Under Actions the file is append-only `key=value` lines; the value
 * here is digits by construction, so it needs none of the heredoc delimiting a
 * multi-line output would.
 */
function publishBadgeOutput(percentage) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile === undefined || outputFile === '') return;
  appendFileSync(outputFile, `lines=${badgeLineCoverage(percentage)}\n`);
}

/** Render one module verdict as the line the gate prints for it. */
export function describeModuleVerdict(verdict) {
  const { prefix, floor, files, linesFound, linesHit, percentage, kind } = verdict;
  if (kind === 'no-records') {
    return `${prefix} — NO RECORDS in the lcov report (floor ${floor}%);`
      + ' the prefix, the report or the path normalisation is wrong.'
      + '  Refusing to pass a floor that measured nothing.';
  }
  return `${prefix} ${percentage.toFixed(2)}% (${linesHit}/${linesFound} lines,`
    + ` ${files} files) vs floor ${floor}% — ${kind === 'pass' ? 'PASS' : 'FAIL'}`;
}

function main() {
  const floor = Number(process.env.COVERAGE_LINE_FLOOR ?? String(DEFAULT_LINE_FLOOR));
  if (!Number.isFinite(floor) || floor < 0 || floor > 100) {
    console.error(`coverage-gate: invalid COVERAGE_LINE_FLOOR=${process.env.COVERAGE_LINE_FLOOR}`);
    process.exit(2);
  }

  const { logPath, lcovPath } = parseArguments(process.argv.slice(2));
  if (logPath !== undefined && lcovPath === undefined) {
    console.error('coverage-gate: --log needs --lcov — every floor is read from the lcov report,'
      + ' so a log alone would gate nothing.  Pass --lcov, or neither to run the suite here.');
    process.exit(2);
  }

  let output;
  let lcovFile;
  if (lcovPath !== undefined) {
    for (const path of [logPath, lcovPath]) {
      if (path !== undefined && !existsSync(path)) {
        console.error(`coverage-gate: no such file: ${path}`);
        process.exit(2);
      }
    }
    output = logPath === undefined ? undefined : readFileSync(logPath, 'utf8');
    lcovFile = lcovPath;
  } else {
    const result = spawnSync(
      'bun',
      [
        'test',
        '--coverage',
        '--coverage-reporter=text',
        '--coverage-reporter=lcov',
        `--coverage-dir=${COVERAGE_DIRECTORY}`,
      ],
      { cwd: REPOSITORY_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    output = (result.stdout ?? '') + (result.stderr ?? '');
    // Replay so the log shows what a normal `bun test` step would have shown.
    process.stdout.write(output);
    if (result.status !== 0) {
      console.error(`\ncoverage-gate: \`bun test --coverage\` exited with ${result.status}; failing.`);
      process.exit(result.status ?? 1);
    }
    lcovFile = join(REPOSITORY_ROOT, COVERAGE_DIRECTORY, 'lcov.info');
  }

  if (!existsSync(lcovFile)) {
    console.error(`coverage-gate: no lcov report at ${lcovFile}.`
      + '  Every floor is read from it, and skipping them would report a PASS for'
      + ' checks that never ran.');
    process.exit(2);
  }
  const records = parseLcovRecords(readFileSync(lcovFile, 'utf8'));
  if (records.length === 0) {
    console.error(`coverage-gate: ${lcovFile} holds no SF:/LF:/LH: records.`);
    process.exit(2);
  }

  const aggregateRollup = aggregateLineCoverage(records);
  const aggregate = aggregateRollup.percentage;
  if (aggregate === undefined) {
    console.error(`coverage-gate: no lcov record under ${AGGREGATE_PREFIX} — the aggregate`
      + ' measured nothing, and a figure taken from nothing is not one to publish.');
    process.exit(2);
  }
  // Before any verdict.  A run that fails a floor is exactly the run whose real
  // figure the badge should carry, and a report with nothing under `src/`
  // publishes nothing at all rather than a plausible-looking number — which is
  // what let a green run rewrite the README to "0 of 0" in #1194.
  publishBadgeOutput(aggregate);

  console.log(`\ncoverage-gate: aggregate line coverage = ${aggregate.toFixed(2)}%`
    + ` (${aggregateRollup.linesHit}/${aggregateRollup.linesFound} lines,`
    + ` ${aggregateRollup.files} files under ${AGGREGATE_PREFIX}), floor = ${floor}%`);
  if (output !== undefined) {
    const mean = parseAggregateLineCoverage(output);
    console.log(mean === undefined
      ? 'coverage-gate: (no "All files" row in the log; bun\'s per-file mean not shown)'
      : `coverage-gate: (bun's unweighted per-file mean, not gated: ${mean.toFixed(2)}%)`);
  }
  const verdicts = evaluateModuleFloors(records);
  for (const verdict of verdicts) console.log(`coverage-gate: ${describeModuleVerdict(verdict)}`);

  // Every reason, not just the first: a contributor who has to rerun a
  // six-minute suite to discover the second failure will fix one and push.
  const reasons = [];
  if (aggregate < floor) {
    reasons.push(`aggregate line coverage ${aggregate.toFixed(2)}% < floor ${floor}%.`
      + '  Add tests for under-covered files (see the per-file table above).');
  }
  const unmeasured = verdicts.filter((verdict) => verdict.kind === 'no-records');
  if (unmeasured.length > 0) {
    reasons.push(`${unmeasured.length} module floor(s) matched no lcov records — see above.`);
  }
  const belowFloor = verdicts.filter((verdict) => verdict.kind === 'below-floor');
  if (belowFloor.length > 0) {
    reasons.push(`${belowFloor.length} module floor(s) not met — see above.`);
  }
  if (reasons.length > 0) {
    for (const reason of reasons) console.error(`coverage-gate: ${reason}`);
    process.exit(1);
  }
  console.log(`coverage-gate: PASS (aggregate ${aggregate.toFixed(2)}% ≥ ${floor}%,`
    + ` ${verdicts.length} module floor(s) met)`);
}

if (import.meta.main) main();
