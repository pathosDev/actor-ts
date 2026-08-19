#!/usr/bin/env bun
/**
 * Coverage-floor gate (#294, #541).
 *
 * Two floors, measured from the two artifacts of a single
 * `bun test --coverage` run:
 *
 *   - the **aggregate** line-coverage floor, read from the `All files` row of
 *     bun's text table.  `COVERAGE_LINE_FLOOR` overrides
 *     {@link DEFAULT_LINE_FLOOR};
 *   - **per-module** line-coverage floors for the subsystems where an
 *     unnoticed regression is the expensive kind, read from the lcov report.
 *     {@link MODULE_LINE_FLOORS} is the only place they are configured.
 *
 *   bun run test:coverage:gate                       # run the suite, then gate
 *   bun scripts/coverage-gate.mjs \
 *     --log=<bun-test.log> --lcov=<lcov.info>        # gate captured artifacts
 *
 * **The two floors deliberately read different artifacts.**  The aggregate row
 * is also parsed, in bash, by `.github/workflows/test.yml` (the `stats` step's
 * `grep "^All files" | awk -F'|' '{print $3}'`), and CI enforces the floor from
 * *that* number — this script has no automated caller at all today.  Keeping
 * the aggregate parse shaped like the workflow's is what stops the two from
 * disagreeing while they coexist; unifying them is #1016, which has to invert
 * this script's control flow first (see the `--log` / `--lcov` note below).
 *
 * The per-module figures cannot come from that table even in principle.  Bun
 * prints a percentage per file, and a per-directory rollup of percentages is an
 * unweighted mean: a 12-line barrel at 100 % would cancel a 600-line
 * coordinator at 40 %.  lcov carries `LF:` / `LH:` counts per file, so a module
 * is `Σ LH / Σ LF` — weighted by the lines that actually exist.  The two
 * statistics measurably disagree on this repository: the same 2026-08-19 run
 * reads 95.88 % in the `All files` row and 96.89 % as `Σ LH / Σ LF` over all
 * 1150 records.  Which is why the aggregate is left reading the row CI reads,
 * and the module floors read lcov — nothing here silently re-defines the number
 * the workflow enforces.
 *
 * **Known caveat on the aggregate, not on the modules.**  `bunfig.toml` does
 * not set `coverageSkipTestFiles` and bun's default for it is `false`, so every
 * file under `tests/` is its own row in the `All files` denominator — 508 of
 * them at 99.05 %, against 93.66 % for the 625 files under `src/`.  The
 * aggregate therefore reads ~2 points above product-code coverage.  That is
 * #1016's subject and this script does not pre-empt it.  The per-module floors
 * are immune to it by construction: a `src/…/` prefix cannot match a test file,
 * so those numbers are product-code coverage and nothing else.
 *
 * **`--log` / `--lcov` exist so CI never runs the suite twice.**  Without them
 * the script runs `bun test --coverage` itself, which is right for a developer
 * and wrong for `test.yml`, where the suite has already run once on purpose —
 * that workflow's header records the two-runs-two-numbers failure the single
 * run was introduced to remove.  Passing both artifacts turns this file into a
 * pure gate over someone else's run.  Both or neither: a gate that silently
 * evaluates half of itself is the failure mode #1194 taught this repository to
 * write assertions against.
 *
 * The pure functions below are exported (typed by `coverage-gate.d.mts`) and
 * the driver runs under `import.meta.main`, so
 * `tests/unit/ci/CoverageGate.test.ts` can drive the rollup against synthetic
 * lcov instead of against a live suite — where a wrong verdict is
 * indistinguishable from a real regression.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The aggregate floor, and the value `.github/workflows/test.yml` has to keep
 * saying.  `tests/unit/ci/CoverageGate.test.ts` fails when the two drift or
 * when `AGENTS.md` stops quoting the same number — the ratchet policy recorded
 * there is only a policy if lowering the floor cannot happen in one silent
 * token edit, which is exactly what it was until that test existed.
 *
 * 80 rather than something near the measured figure is a live decision, not
 * inertia: `83b0a4af` lowered it from 89 because hosted CI then measured 86 %,
 * and the number it would be raised against today is the test-file-inflated
 * aggregate above.  Re-baselining it belongs with #1016, which fixes the
 * metric first.
 */
export const DEFAULT_LINE_FLOOR = 80;

/**
 * Per-module line-coverage floors, as `Σ LH / Σ LF` over every lcov record
 * whose repository-relative path starts with the key.
 *
 * Deliberately **not** overridable by an environment variable, unlike the
 * aggregate floor.  An override in a workflow file is a second place the number
 * lives, and the one thing this table exists to prevent is a floor that can be
 * loosened without the loosening being visible in a diff of the gate itself.
 *
 * The two entries are the subsystems #541 names, and they are the right two:
 * both coordinate distributed state, both fail in ways a unit test only catches
 * if it exists, and both are quoted in `83b0a4af`'s justification for the
 * aggregate floor ("product code (cluster, persistence, …) stays well above
 * it") — a claim that, until this table, nothing measured.
 *
 * **Measured 2026-08-19** over the CI population (`ACTOR_TS_SKIP_FLAKY_MNS=1`,
 * which removes `LeaseMajority` and with it some of `src/cluster/`'s own
 * coverage), 7695 tests, bun 1.3.1:
 *
 *   src/cluster/      97.39 %  (7005/7193 lines, 81 files)
 *   src/persistence/  95.35 %  (8706/9131 lines, 157 files)
 *
 * 90 rather than the ~3-point band #541 asks for, on purpose.  A floor the
 * measurement cannot clear on the machine that enforces it is how the aggregate
 * floor ended up at 80: `83b0a4af` lowered it from 89 because hosted CI
 * measured 86 %.  The same platform gap is visible right now — this local
 * Windows run reads 95.88 % aggregate where the badge bot's hosted-CI figure is
 * 93 % — so a band tight enough to be interesting locally is a band that fails
 * elsewhere.  These floors buy 5–7 points of regression detection where there
 * were none, and the ratchet policy in `AGENTS.md` is the mechanism for
 * tightening them once a *hosted-CI* figure for each module exists, which needs
 * #1016 to wire this script into `test.yml` first.
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
 * The line-coverage percentage from bun's text table.
 *
 * The table is `File | % Funcs | % Lines | Uncovered Line #s`, so line coverage
 * is the SECOND numeric column — `c35fd0c5` fixed this gate reading the first.
 * Shaped to match `.github/workflows/test.yml`'s `awk -F'|' '{print $3}'` for
 * as long as both exist (#1016).
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
 * Both or neither, because the alternative is a gate that reports PASS having
 * checked one of its two floors.
 */
export function parseArguments(argv) {
  const readFlag = (name) => {
    const prefix = `--${name}=`;
    const found = argv.filter((argument) => argument.startsWith(prefix)).at(-1);
    return found === undefined ? undefined : found.slice(prefix.length);
  };
  return { logPath: readFlag('log'), lcovPath: readFlag('lcov') };
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
  if ((logPath === undefined) !== (lcovPath === undefined)) {
    console.error('coverage-gate: --log and --lcov go together — one alone would gate half of'
      + ' what this script gates.  Pass both, or neither to run the suite here.');
    process.exit(2);
  }

  let output;
  let lcovFile;
  if (logPath !== undefined && lcovPath !== undefined) {
    for (const path of [logPath, lcovPath]) {
      if (!existsSync(path)) {
        console.error(`coverage-gate: no such file: ${path}`);
        process.exit(2);
      }
    }
    output = readFileSync(logPath, 'utf8');
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

  const aggregate = parseAggregateLineCoverage(output);
  if (aggregate === undefined) {
    console.error('coverage-gate: could not find the "All files" aggregate row in the'
      + ' `bun test --coverage` output.');
    process.exit(2);
  }

  if (!existsSync(lcovFile)) {
    console.error(`coverage-gate: no lcov report at ${lcovFile}.`
      + '  The per-module floors cannot be evaluated, and skipping them would report a'
      + ' PASS for checks that never ran.');
    process.exit(2);
  }
  const records = parseLcovRecords(readFileSync(lcovFile, 'utf8'));
  if (records.length === 0) {
    console.error(`coverage-gate: ${lcovFile} holds no SF:/LF:/LH: records.`);
    process.exit(2);
  }

  console.log(`\ncoverage-gate: aggregate line coverage = ${aggregate.toFixed(2)}%,`
    + ` floor = ${floor}%`);
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
