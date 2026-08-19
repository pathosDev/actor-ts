import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_LINE_FLOOR,
  MODULE_LINE_FLOORS,
  describeModuleVerdict,
  evaluateModuleFloors,
  normaliseCoveragePath,
  parseAggregateLineCoverage,
  parseArguments,
  parseLcovRecords,
  rollUpModule,
  type LcovRecord,
  type ModuleVerdict,
} from '../../../scripts/coverage-gate.mjs';

/**
 * The coverage gate's per-module floors (#541), and the one property that makes
 * them worth having: they can fail.
 *
 * A per-module floor is a guard nobody watches.  It runs, it prints PASS, and
 * the only evidence it is measuring anything is that it once went red — which,
 * for a floor set comfortably below the current figure, may be never.  Two ways
 * this particular guard passes while measuring nothing, both of which the
 * assertions below reject:
 *
 *  1. **Windows separators.**  bun writes lcov `SF:` paths with the platform's
 *     separator, so on Windows the report says `SF:src\cluster\Sharding.ts`.  A
 *     prefix test against `src/cluster/` matches zero records there, every
 *     module rolls up empty, and a gate that read "empty" as "nothing below the
 *     floor" would report PASS on every machine the author develops on.  The
 *     end-to-end case below runs the real script over a backslash-only report
 *     and requires exit 0 *with* the module named — and the `no-records` cases
 *     require the empty rollup to be a failure, because normalisation and the
 *     empty-match verdict only work as a pair.
 *
 *  2. **An unweighted mean.**  bun's text table prints one percentage per file,
 *     and rolling those up by directory averages a 10-line barrel against a
 *     1000-line coordinator.  `rollUpModule` sums lcov's `LF:`/`LH:` counts
 *     instead, and the fixture below is chosen so the two disagree across the
 *     floor: mean 92.5 %, weighted 85.15 %, floor 90.  An implementation that
 *     averaged would pass it.
 *
 * The floor *values* are pinned too, in both directions.  Until this file there
 * was nothing under `tests/` naming `COVERAGE_LINE_FLOOR` at all, so lowering
 * the aggregate floor was a one-token edit in one file — which is how it went
 * from 89 to 80 (`83b0a4af`) with the reasoning living only in a commit message.
 * The ratchet policy in `AGENTS.md` is a policy only if breaking it is loud.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const SCRIPT = join(REPOSITORY_ROOT, 'scripts', 'coverage-gate.mjs');

/** One lcov record, written the way bun writes them. */
function lcovRecord(path: string, linesFound: number, linesHit: number): string {
  const lines = Array.from(
    { length: linesFound },
    (_unused, index) => `DA:${index + 1},${index < linesHit ? 1 : 0}`,
  );
  return ['TN:', `SF:${path}`, ...lines, `LF:${linesFound}`, `LH:${linesHit}`, 'end_of_record'].join('\n');
}

/**
 * A `bun test --coverage` table with the given aggregate.
 *
 * Two numeric columns because the row is `File | % Funcs | % Lines`, and the
 * first one is the trap `c35fd0c5` fixed: the values here are deliberately far
 * apart so a parser reading the wrong column cannot accidentally agree.
 */
function coverageTable(functionsPercentage: number, linesPercentage: number): string {
  return [
    'bun test v1.3.1 (89fa0f34)',
    '-------------|---------|---------|-------------------',
    'File         | % Funcs | % Lines | Uncovered Line #s',
    '-------------|---------|---------|-------------------',
    `All files    |   ${functionsPercentage.toFixed(2)} |   ${linesPercentage.toFixed(2)} |`,
    '-------------|---------|---------|-------------------',
    '',
    ' 7657 pass',
    ' 0 fail',
    '',
  ].join('\n');
}

/** Records for every floored module except the one a case is about. */
function healthyRecordsExcept(subject: string): readonly string[] {
  return Object.keys(MODULE_LINE_FLOORS)
    .filter((prefix) => prefix !== subject)
    .map((prefix) => lcovRecord(`${prefix}Healthy.ts`, 100, 99));
}

type GateRun = {
  readonly status: number | null;
  readonly output: string;
};

/**
 * Drive the real script over captured artifacts.
 *
 * `--log` / `--lcov` is the only way to test the gate's *decision* without
 * running the whole suite inside a test — and it is the interface #1016 needs
 * anyway, since `test.yml` has already run the suite by the time a gate step
 * could call this file.
 */
function runGate(files: { log?: string; lcov?: string }, environment: Record<string, string> = {}): GateRun {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-coverage-gate-'));
  try {
    const argv: string[] = [];
    if (files.log !== undefined) {
      const logPath = join(directory, 'bun-test.log');
      writeFileSync(logPath, files.log);
      argv.push(`--log=${logPath}`);
    }
    if (files.lcov !== undefined) {
      const lcovPath = join(directory, 'lcov.info');
      writeFileSync(lcovPath, files.lcov);
      argv.push(`--lcov=${lcovPath}`);
    }
    const child = spawnSync('bun', [SCRIPT, ...argv], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', ...environment },
      timeout: 60_000,
    });
    return { status: child.status, output: (child.stdout ?? '') + (child.stderr ?? '') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A table comfortably above the aggregate floor, so a case is about its modules. */
const HEALTHY_TABLE = coverageTable(89.85, 95.88);

const CLUSTER_PREFIX = 'src/cluster/';

describe('lcov path normalisation', () => {
  test('a Windows SF: path becomes a repository-relative POSIX path', () => {
    expect(normaliseCoveragePath('src\\cluster\\sharding\\ShardRegion.ts'))
      .toBe('src/cluster/sharding/ShardRegion.ts');
  });

  test('a leading ./ is not part of the prefix a floor matches on', () => {
    expect(normaliseCoveragePath('./src/persistence/Journal.ts')).toBe('src/persistence/Journal.ts');
  });

  test('an absolute path under the repository is made relative, drive-letter case included', () => {
    const absolute = join(REPOSITORY_ROOT, 'src', 'cluster', 'Cluster.ts');
    expect(normaliseCoveragePath(absolute)).toBe('src/cluster/Cluster.ts');
    // Windows hands the same file back with either drive-letter case depending
    // on which tool produced the path; a case-sensitive strip would leave the
    // whole absolute path in place and match no floor.
    expect(normaliseCoveragePath(absolute.replace(/^([A-Za-z]):/, (_all, drive: string) =>
      `${drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()}:`)))
      .toBe('src/cluster/Cluster.ts');
  });

  test('parsing a report keeps the normalised path, so a floor can match it', () => {
    const records = parseLcovRecords(lcovRecord('src\\cluster\\Cluster.ts', 10, 9));
    expect(records).toHaveLength(1);
    expect(records[0]!.path).toBe('src/cluster/Cluster.ts');
    expect(records[0]!.linesFound).toBe(10);
    expect(records[0]!.linesHit).toBe(9);
  });

  test('a record without LF:/LH: is dropped rather than counted as 0/0', () => {
    const truncated = ['TN:', 'SF:src/cluster/Half.ts', 'DA:1,1', 'end_of_record'].join('\n');
    expect(parseLcovRecords(truncated)).toHaveLength(0);
    expect(parseLcovRecords(`${truncated}\n${lcovRecord('src/cluster/Whole.ts', 4, 4)}`))
      .toHaveLength(1);
  });

  test('CRLF line endings parse the same as LF', () => {
    const record = lcovRecord('src/cluster/Cluster.ts', 8, 6);
    expect(parseLcovRecords(record.replaceAll('\n', '\r\n'))).toEqual(parseLcovRecords(record));
  });
});

describe('the module rollup is weighted by lines, not averaged over files', () => {
  /**
   * 85 % of a thousand lines and 100 % of ten.  Averaging the two file
   * percentages gives 92.5 %, which clears the 90 % floor; summing the counts
   * gives 860/1010 = 85.15 %, which does not.  Everything about the two
   * implementations is identical except the verdict.
   */
  const LOPSIDED: readonly LcovRecord[] = parseLcovRecords(
    [lcovRecord('src/cluster/Coordinator.ts', 1000, 850), lcovRecord('src/cluster/Barrel.ts', 10, 10)]
      .join('\n'),
  );

  test('the rollup sums LF:/LH: across the module', () => {
    const rolled = rollUpModule(LOPSIDED, CLUSTER_PREFIX);
    expect(rolled.files).toBe(2);
    expect(rolled.linesFound).toBe(1010);
    expect(rolled.linesHit).toBe(860);
    expect(rolled.percentage!).toBeCloseTo(85.15, 2);
    // The unweighted mean of the same two files, which must NOT be the answer.
    expect(rolled.percentage!).not.toBeCloseTo(92.5, 1);
  });

  test('a module exactly on its floor passes — the arithmetic is exact there', () => {
    const exact = parseLcovRecords(lcovRecord('src/cluster/Exact.ts', 200, 170));
    const [verdict] = evaluateModuleFloors(exact, { [CLUSTER_PREFIX]: 85 });
    expect(verdict!.percentage).toBe(85);
    expect(verdict!.kind).toBe('pass');
  });

  test('an empty module has no percentage rather than a zero or a NaN', () => {
    const rolled = rollUpModule([], CLUSTER_PREFIX);
    expect(rolled.files).toBe(0);
    expect(rolled.percentage).toBeUndefined();
  });
});

describe('a prefix that matched nothing is a failure, never a pass', () => {
  test('an unmatched prefix is no-records', () => {
    const elsewhere = parseLcovRecords(lcovRecord('src/http/Server.ts', 100, 100));
    const [verdict] = evaluateModuleFloors(elsewhere, { [CLUSTER_PREFIX]: 90 });
    expect(verdict!.kind).toBe('no-records');
    expect(verdict!.percentage).toBeUndefined();
  });

  test('the no-records message says the floor measured nothing', () => {
    const verdict = evaluateModuleFloors([], { [CLUSTER_PREFIX]: 90 })[0] as ModuleVerdict;
    const described = describeModuleVerdict(verdict);
    expect(described).toContain(CLUSTER_PREFIX);
    expect(described).toContain('NO RECORDS');
    expect(described).not.toContain('PASS');
  });

  test('records with no instrumented lines are no-records too', () => {
    const typeOnly = parseLcovRecords(lcovRecord('src/cluster/ShardInfo.ts', 0, 0));
    expect(typeOnly).toHaveLength(1);
    const [verdict] = evaluateModuleFloors(typeOnly, { [CLUSTER_PREFIX]: 90 });
    expect(verdict!.kind).toBe('no-records');
  });
});

describe('the aggregate row is parsed out of the % Lines column', () => {
  test('the second numeric column wins, not the first', () => {
    expect(parseAggregateLineCoverage(coverageTable(89.85, 95.88))).toBe(95.88);
  });

  test('a table without an All files row parses to nothing', () => {
    expect(parseAggregateLineCoverage('7657 pass\n0 fail\n')).toBeUndefined();
  });
});

describe('--log / --lcov gate captured artifacts', () => {
  test('both floors met exits 0', () => {
    const lcov = Object.keys(MODULE_LINE_FLOORS)
      .map((prefix) => lcovRecord(`${prefix}Healthy.ts`, 100, 99))
      .join('\n');
    const run = runGate({ log: HEALTHY_TABLE, lcov });
    expect(run.output).toContain('PASS');
    expect(run.status).toBe(0);
  });

  /**
   * The Windows trap, end to end and through the exit code.  Every `SF:` here
   * uses backslashes, exactly as bun writes them on Windows.  Drop the
   * normalisation and this report matches no floor at all, every module becomes
   * `no-records`, and the script exits non-zero — so this case is red for the
   * unnormalised implementation rather than silently green.
   */
  test('a report written with Windows separators still matches every floor', () => {
    const lcov = Object.keys(MODULE_LINE_FLOORS)
      .map((prefix) => lcovRecord(`${prefix.replaceAll('/', '\\')}Healthy.ts`, 100, 99))
      .join('\n');
    const run = runGate({ log: HEALTHY_TABLE, lcov });
    expect(run.output).toContain('99.00%');
    expect(run.output).toContain('PASS');
    expect(run.status).toBe(0);
  });

  test('a module below its floor fails the gate and is named', () => {
    const lcov = [
      lcovRecord(`${CLUSTER_PREFIX}Coordinator.ts`, 1000, 850),
      lcovRecord(`${CLUSTER_PREFIX}Barrel.ts`, 10, 10),
      ...healthyRecordsExcept(CLUSTER_PREFIX),
    ].join('\n');
    const run = runGate({ log: HEALTHY_TABLE, lcov });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain(CLUSTER_PREFIX);
    expect(run.output).toContain('85.15%');
    expect(run.output).toContain('module floor(s) not met');
  });

  test('a module the report says nothing about fails the gate', () => {
    const run = runGate({ log: HEALTHY_TABLE, lcov: healthyRecordsExcept(CLUSTER_PREFIX).join('\n') });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('NO RECORDS');
    expect(run.output).toContain('matched no lcov records');
  });

  test('the aggregate floor still fails on its own', () => {
    const lcov = Object.keys(MODULE_LINE_FLOORS)
      .map((prefix) => lcovRecord(`${prefix}Healthy.ts`, 100, 99))
      .join('\n');
    const run = runGate({ log: coverageTable(60, 61.5), lcov });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('61.50%');
    expect(run.output).toContain(`floor ${DEFAULT_LINE_FLOOR}%`);
  });

  test('COVERAGE_LINE_FLOOR still overrides the aggregate floor', () => {
    const lcov = Object.keys(MODULE_LINE_FLOORS)
      .map((prefix) => lcovRecord(`${prefix}Healthy.ts`, 100, 99))
      .join('\n');
    const run = runGate({ log: coverageTable(60, 61.5), lcov }, { COVERAGE_LINE_FLOOR: '60' });
    expect(run.status).toBe(0);
  });

  /**
   * Half the artifacts would gate half the floors.  Refusing is the difference
   * between "the module floors passed" and "the module floors did not run",
   * which a PASS line cannot distinguish after the fact.
   */
  test('--log without --lcov is refused rather than half-run', () => {
    const run = runGate({ log: HEALTHY_TABLE });
    expect(run.status).toBe(2);
    expect(run.output).toContain('go together');
  });

  test('--lcov without --log is refused too', () => {
    const run = runGate({ lcov: lcovRecord(`${CLUSTER_PREFIX}Healthy.ts`, 100, 99) });
    expect(run.status).toBe(2);
    expect(run.output).toContain('go together');
  });

  test('parseArguments reads both flags and defaults them to unset', () => {
    expect(parseArguments(['--log=a.log', '--lcov=b.info']))
      .toEqual({ logPath: 'a.log', lcovPath: 'b.info' });
    expect(parseArguments([])).toEqual({ logPath: undefined, lcovPath: undefined });
  });
});

describe('the floors are a ratchet, not a variable', () => {
  const agentsGuide = readFileSync(join(REPOSITORY_ROOT, 'AGENTS.md'), 'utf8');
  const testWorkflow = readFileSync(
    join(REPOSITORY_ROOT, '.github', 'workflows', 'test.yml'),
    'utf8',
  );

  test('the aggregate floor is the same number in the script, the workflow and AGENTS.md', () => {
    const workflowMatch = /COVERAGE_LINE_FLOOR:\s*'(\d+)'/.exec(testWorkflow);
    const guideMatch = /Line coverage floor is \*\*≥ (\d+) %\*\*/.exec(agentsGuide);
    // Guard the guard: a regex that stopped matching would agree with anything.
    expect(workflowMatch).not.toBeNull();
    expect(guideMatch).not.toBeNull();
    expect(Number(workflowMatch![1])).toBe(DEFAULT_LINE_FLOOR);
    expect(Number(guideMatch![1])).toBe(DEFAULT_LINE_FLOOR);
  });

  /**
   * The bounds below are the ratchet.  They are not a second copy of the floors
   * — they are the lowest value each floor has ever been allowed to hold, so
   * raising a floor means raising its bound in the same commit and lowering one
   * means deleting a bound, which is a diff a reviewer sees.  80 is the
   * aggregate's recorded low-water mark (`83b0a4af`); 90 is where the module
   * floors entered the tree (#541), measured at 97.39 % and 95.35 %.
   */
  test('no floor may be lowered without this test changing with it', () => {
    expect(DEFAULT_LINE_FLOOR).toBeGreaterThanOrEqual(80);
    expect(MODULE_LINE_FLOORS[CLUSTER_PREFIX]).toBeGreaterThanOrEqual(90);
    expect(MODULE_LINE_FLOORS['src/persistence/']).toBeGreaterThanOrEqual(90);
  });

  test('the floored modules are exactly the two #541 names, and AGENTS.md says so', () => {
    expect(Object.keys(MODULE_LINE_FLOORS).sort()).toEqual([CLUSTER_PREFIX, 'src/persistence/']);
    for (const prefix of Object.keys(MODULE_LINE_FLOORS)) {
      expect(agentsGuide).toContain(prefix);
    }
  });

  test('every floor is a percentage', () => {
    for (const [prefix, floor] of Object.entries(MODULE_LINE_FLOORS)) {
      expect(Number.isInteger(floor), `${prefix} floor is not an integer`).toBe(true);
      expect(floor).toBeGreaterThan(0);
      expect(floor).toBeLessThanOrEqual(100);
    }
  });
});
