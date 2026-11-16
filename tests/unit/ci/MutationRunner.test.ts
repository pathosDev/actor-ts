import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  applyMutant,
  baselineDocument,
  budgetSpent,
  changedLinesFromDiff,
  classifyRun,
  codeMask,
  countStatuses,
  createFileGuard,
  filterToChangedLines,
  findMutants,
  installRestoreHandlers,
  isMutableSource,
  lineHits,
  mapTests,
  parseArguments,
  partitionMutants,
  rankTests,
  renderMarkdown,
  runWithTimeout,
  sharedDirectoryDepth,
  testsFor,
  timeoutFor,
  UsageError,
  type Mutant,
  type Operator,
} from '../../../scripts/mutation-run.mjs';

/**
 * The mutation runner is a classifier, and an unverified one is worse than the
 * hand-run mutants it replaces (#1368): an operator that lands inside a string
 * produces noise survivors, a restore that misses one exit path leaves a
 * mutant in the tree for the next commit to pick up, and a watchdog that calls
 * a hang a survivor reports the most broken mutant as the best-tested line.
 * Each of those is pinned here against fixtures and throwaway files — nothing
 * below mutates the repository or runs the suite.
 */

const transpiler = new Bun.Transpiler({ loader: 'ts' });
const transpile = (code: string): string => transpiler.transformSync(code);

function mutantsOf(source: string, operators?: readonly Operator[]): Array<Pick<Mutant, 'operator' | 'original' | 'replacement' | 'line'>> {
  return findMutants(source, operators === undefined ? {} : { operators })
    .map(({ operator, original, replacement, line }) => ({ operator, original, replacement, line }));
}

function codeOf(source: string): string {
  const mask = codeMask(source);
  return [...source].map((character, index) => (mask[index] ? character : '_')).join('');
}

describe('the lexer only calls code code', () => {
  test('comments, strings, templates and regular expressions are not code', () => {
    const source = "a // x < y\n/* p && q */ b 'c === d' \"e || f\" `g ${h > i}`; const r = /j < k/g;";
    const code = codeOf(source);
    for (const fragment of ['x < y', 'p && q', 'c === d', 'e || f', 'h > i', 'j < k']) {
      expect(code).not.toContain(fragment);
    }
    expect(code).toContain('a ');
    expect(code).toContain(' b ');
  });

  test('a division is code and a regular expression after `return` is not', () => {
    expect(codeOf('const r = a / b / c;')).toBe('const r = a / b / c;');
    expect(codeOf('return /a < b/.test(s);')).not.toContain('a < b');
  });

  test('a template nested in an interpolation does not end the outer template early', () => {
    const code = codeOf('const s = `x ${f(`y ${a === b}`)} z`; c === d;');
    expect(code).not.toContain('a === b');
    expect(code).toContain('c === d');
  });
});

describe('each operator', () => {
  test('relational boundary swaps both ways, only for a spaced comparison', () => {
    expect(mutantsOf('if (a < b && c >= d) x();', ['relational-boundary'])).toEqual([
      { operator: 'relational-boundary', original: '<', replacement: '<=', line: 1 },
      { operator: 'relational-boundary', original: '>=', replacement: '>', line: 1 },
    ]);
    expect(mutantsOf('if (a <= b || c > d) x();', ['relational-boundary']).map((m) => m.replacement)).toEqual(['<', '>=']);
  });

  test('generics, arrows and shifts are never read as comparisons', () => {
    const source = 'const m: Map<string, Array<number>> = new Map(); const f = (x: number) => x >> 1; y >>= 2; z <<= 1;';
    expect(mutantsOf(source, ['relational-boundary'])).toEqual([]);
  });

  test('equality and logical swap their partners, and compound assignments are left alone', () => {
    expect(mutantsOf('a === b; a !== b; a == b; a != b;', ['equality']).map((m) => `${m.original}>${m.replacement}`))
      .toEqual(['===>!==', '!==>===', '==>!=', '!=>==']);
    expect(mutantsOf('p && q || r; s &&= t; u ||= v; w ?? x;', ['logical']).map((m) => `${m.original}>${m.replacement}`))
      .toEqual(['&&>||', '||>&&']);
  });

  test('a boolean literal flips, a property named like one does not', () => {
    expect(mutantsOf('let a = true; let b = false; options.true;', ['boolean-literal']).map((m) => m.replacement))
      .toEqual(['false', 'true']);
  });

  test('a one-line call statement and a one-line return are removed', () => {
    const source = ['function f() {', '  this.prune(now);', '  await store.flush();', '  return value;', '}'].join('\n');
    expect(mutantsOf(source, ['removed-call', 'removed-return'])).toEqual([
      { operator: 'removed-call', original: 'this.prune(now);', replacement: ';', line: 2 },
      { operator: 'removed-call', original: 'await store.flush();', replacement: ';', line: 3 },
      { operator: 'removed-return', original: 'return value;', replacement: ';', line: 4 },
    ]);
  });

  test('a statement that continues on the next line is not removed', () => {
    // The first line balances its brackets; only the missing `;` says it goes on.
    const source = ['function f(o) {', "  return typeof o.id === 'string'", '    && o.ok;', '}'].join('\n');
    expect(mutantsOf(source, ['removed-return'])).toEqual([]);
    const call = ['function g() {', '  run(', '    a,', '  );', '  other(x,', '    y);', '}'].join('\n');
    expect(mutantsOf(call, ['removed-call'])).toEqual([]);
  });

  test('an argument on its own line is not a call statement', () => {
    const source = ['function f() {', '  outer(', '    inner(x),', '  );', '}'].join('\n');
    expect(mutantsOf(source, ['removed-call'])).toEqual([]);
  });

  test('a trailing comment is cut off, a URL inside a string is not one', () => {
    const source = ['function f() {', "  fetch('http://x'); // later", '}'].join('\n');
    expect(mutantsOf(source, ['removed-call']).map((m) => m.original)).toEqual(["fetch('http://x');"]);
  });

  test('applying a mutant changes exactly its span', () => {
    const source = 'if (a < b) return;';
    const [mutant] = findMutants(source, { operators: ['relational-boundary'] });
    expect(applyMutant(source, mutant!)).toBe('if (a <= b) return;');
  });
});

describe('noise filtering', () => {
  test('an ignore entry drops only the operators it names, on the lines it matches', () => {
    const source = ['function f() {', "  if (n > 0) this.log.warn('dropped');", "  this.log.warn('x');", '}'].join('\n');
    const ignore = [{ operators: ['removed-call'] as Operator[], pattern: '\\blog\\.warn\\(' }];
    const found = findMutants(source, { ignore }).map((m) => `${m.operator}:${m.line}`);
    expect(found).toEqual(['relational-boundary:2']);
    expect(findMutants(source).map((m) => `${m.operator}:${m.line}`)).toContain('removed-call:3');
  });

  test('the shipped config parses, and its patterns match the log calls the tree makes', () => {
    const config = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'scripts', 'mutation-config.json'), 'utf8'));
    const source = ['function f() {', "  this.system.log.warn('a');", "  console.error('b');", "  this.cluster.leave('c');", '}'].join('\n');
    expect(findMutants(source, { ignore: config.ignore }).map((m) => m.original)).toEqual(["this.cluster.leave('c');"]);
    expect(Object.keys(config.sets)).toContain('nightly');
  });

  test('a mutant in a type position is equivalent and one that does not parse is invalid', () => {
    const source = 'type Flag = { ok: true };\nexport const enabled = true;\n';
    const mutants = findMutants(source, { operators: ['boolean-literal'] });
    const { valid, equivalent } = partitionMutants(source, mutants, transpile);
    expect(equivalent.map((m) => m.line)).toEqual([1]);
    expect(valid.map((m) => m.line)).toEqual([2]);

    const throwsOnMutant = (code: string): string => {
      if (code !== source) throw new SyntaxError('unexpected token');
      return code;
    };
    expect(partitionMutants(source, mutants, throwsOnMutant).invalid).toHaveLength(2);
  });
});

describe('mapping and coverage', () => {
  test('direct importers and the exact-name test map; barrels and multi-node suites do not', () => {
    // Built from parts, so the runner's own specifier scan never reads this file
    // as an importer of src/Supervision.ts.
    const from = (specifier: string): string => `import { x } from ${"'"}${specifier}';`;
    const files: Record<string, string> = {
      'tests/unit/Supervision.test.ts': from('../../src/index.js'),
      'tests/unit/actor/Restart.test.ts': from('../../../src/Supervision.js'),
      'tests/unit/actor/Other.test.ts': from('../../../src/Actor.js'),
      'tests/multi-node/Supervision.test.ts': from('../../src/Supervision.js'),
    };
    expect(testsFor('src/Supervision.ts', Object.keys(files), (path) => files[path]!)).toEqual([
      'tests/unit/Supervision.test.ts',
      'tests/unit/actor/Restart.test.ts',
    ]);
  });

  test('lcov line hits are read for the right file, whatever the separator', () => {
    const lcov = ['SF:src\\a.ts', 'DA:1,0', 'end_of_record', 'SF:src\\b\\c.ts', 'DA:3,5', 'DA:4,0', 'end_of_record'].join('\r\n');
    expect([...lineHits(lcov, 'src/b/c.ts')]).toEqual([[3, 5], [4, 0]]);
    expect(lineHits(lcov, 'src/missing.ts').size).toBe(0);
  });

  test('only TypeScript under src/ that is neither a declaration nor generated is mutable', () => {
    expect(isMutableSource('src/Supervision.ts')).toBe(true);
    expect(isMutableSource('src\\util\\OptionsMerge.ts')).toBe(true);
    expect(isMutableSource('src/types.d.ts')).toBe(false);
    expect(isMutableSource('src/devtools/generated/UiAssets.ts')).toBe(false);
    expect(isMutableSource('tests/unit/Supervision.test.ts')).toBe(false);
  });
});

describe('changed lines', () => {
  const diff = (...lines: string[]): string => lines.join('\n');

  test('every hunk of a file adds its new-side lines; a count of 0 is a pure deletion and adds none', () => {
    const lines = changedLinesFromDiff(diff(
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3 @@ export function f() {',
      '-  return 1;',
      '+  return 2;',
      '@@ -10,2 +9,0 @@ const x = 1;',
      '-  gone();',
      '-  gone();',
      '@@ -20,0 +19,3 @@ class C {',
      '+  a();',
      '+  b();',
      '+  c();',
    ));
    expect([...lines.get('src/a.ts')!].sort((a, b) => a - b)).toEqual([3, 19, 20, 21]);
  });

  test('a renamed file is keyed by its new path, a deleted one not at all, and CRLF output parses the same', () => {
    const text = diff(
      'diff --git a/src/old/Name.ts b/src/new/Name.ts',
      'similarity index 90%',
      'rename from src/old/Name.ts',
      'rename to src/new/Name.ts',
      '--- a/src/old/Name.ts',
      '+++ b/src/new/Name.ts',
      '@@ -5,1 +5,2 @@',
      '-x',
      '+y',
      '+z',
      'diff --git a/src/Removed.ts b/src/Removed.ts',
      'deleted file mode 100644',
      '--- a/src/Removed.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
    );
    for (const variant of [text, text.replaceAll('\n', '\r\n')]) {
      const lines = changedLinesFromDiff(variant);
      expect([...lines.keys()]).toEqual(['src/new/Name.ts']);
      expect([...lines.get('src/new/Name.ts')!]).toEqual([5, 6]);
    }
  });

  test('a hunk body line that reads like a header is content, not a new file', () => {
    const lines = changedLinesFromDiff(diff(
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,0 +1,2 @@',
      '+++ counter;',
      '+@@ -1 +40 @@',
      '@@ -9 +11 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
    ));
    expect([...lines.keys()]).toEqual(['src/a.ts']);
    expect([...lines.get('src/a.ts')!]).toEqual([1, 2, 11]);
  });

  test('mutants off the changed lines are filtered, and a file with no changed lines keeps none', () => {
    const mutants = [{ line: 2 }, { line: 3 }, { line: 7 }];
    expect(filterToChangedLines(mutants, new Set([3, 7]))).toEqual({ kept: [{ line: 3 }, { line: 7 }], filtered: [{ line: 2 }] });
    expect(filterToChangedLines(mutants, undefined)).toEqual({ kept: [], filtered: mutants });
  });
});

describe('test mapping past a barrel, and its cap', () => {
  const imports: Record<string, string[]> = {
    'src/cluster/sharding/ClusterSharding.ts': ['src/cluster/sharding/ShardCoordinator.ts'],
    'src/cluster/index.ts': ['src/cluster/sharding/ClusterSharding.ts'],
    'tests/unit/cluster/sharding/Rebalance.test.ts': ['src/cluster/sharding/ClusterSharding.ts'],
    'tests/unit/cluster/Membership.test.ts': ['src/cluster/sharding/ClusterSharding.ts'],
    'tests/unit/Unrelated.test.ts': ['src/Actor.ts'],
    'tests/unit/Barrel.test.ts': ['src/cluster/index.ts'],
    'tests/multi-node/Sharding.test.ts': ['src/cluster/sharding/ClusterSharding.ts'],
    'tests/unit/cluster/Direct.test.ts': ['src/cluster/Cluster.ts'],
    'tests/unit/cluster/sharding/Deep.test.ts': ['src/cluster/Cluster.ts'],
    'tests/unit/Shallow.test.ts': ['src/cluster/Cluster.ts'],
    'tests/Cluster.test.ts': [],
  };
  const importsOf = (path: string): Set<string> => new Set(imports[path] ?? []);
  const testPaths = Object.keys(imports).filter((path) => path.endsWith('.test.ts'));
  const sourcePaths = Object.keys(imports).filter((path) => path.startsWith('src/'));

  test('a file nothing imports takes the tests of its importers, one hop and no further', () => {
    const mapped = mapTests('src/cluster/sharding/ShardCoordinator.ts', { testPaths, sourcePaths, importsOf });
    expect(mapped.via).toBe('one-hop');
    // Barrel.test.ts reaches it through two hops (index → ClusterSharding → ShardCoordinator) and is not taken.
    expect(mapped.tests).toEqual(['tests/unit/cluster/sharding/Rebalance.test.ts', 'tests/unit/cluster/Membership.test.ts']);
  });

  test('a file nothing reaches maps to none', () => {
    expect(mapTests('src/Lonely.ts', { testPaths, sourcePaths, importsOf })).toEqual({
      tests: [], via: 'none', candidates: 0, dropped: [],
    });
  });

  test('a direct importer suppresses the one-hop fallback', () => {
    const mapped = mapTests('src/cluster/sharding/ClusterSharding.ts', { testPaths, sourcePaths, importsOf });
    expect(mapped.via).toBe('direct');
    expect(mapped.tests).not.toContain('tests/unit/Barrel.test.ts');
  });

  test('so does a same-name test, even one that reaches the file only through a barrel', () => {
    const withSameName = [...testPaths, 'tests/unit/cluster/sharding/ShardCoordinator.test.ts'];
    expect(mapTests('src/cluster/sharding/ShardCoordinator.ts', { testPaths: withSameName, sourcePaths, importsOf })).toEqual({
      tests: ['tests/unit/cluster/sharding/ShardCoordinator.test.ts'], via: 'direct', candidates: 1, dropped: [],
    });
  });

  test('the cap keeps the same-name test, then the mirroring directory, then the nearest import, and reports the rest', () => {
    const mapped = mapTests('src/cluster/Cluster.ts', { testPaths, sourcePaths, importsOf, maximum: 3 });
    expect(mapped.tests).toEqual([
      'tests/Cluster.test.ts',
      'tests/unit/cluster/Direct.test.ts',
      'tests/unit/cluster/sharding/Deep.test.ts',
    ]);
    expect(mapped.dropped).toEqual(['tests/unit/Shallow.test.ts']);
    expect(mapped.candidates).toBe(4);
  });

  test('ranking: a deeper directory match outranks import distance, distance outranks the path', () => {
    expect(sharedDirectoryDepth('src/cluster/sharding/S.ts', 'tests/unit/cluster/sharding/X.test.ts')).toBe(2);
    expect(sharedDirectoryDepth('src/cluster/sharding/S.ts', 'tests/integration/in-process/cluster/Y.test.ts')).toBe(1);
    expect(sharedDirectoryDepth('src/cluster/S.ts', 'tests/unit/X.test.ts')).toBe(0);
    expect(rankTests('src/cluster/sharding/S.ts', [
      { test: 'tests/unit/a/A.test.ts', distance: 1 },
      { test: 'tests/unit/cluster/Z.test.ts', distance: 2 },
      { test: 'tests/unit/cluster/B.test.ts', distance: 2 },
      { test: 'tests/unit/cluster/sharding/Y.test.ts', distance: 2 },
      { test: 'tests/unit/cluster/C.test.ts', distance: 1 },
      { test: 'tests/unit/S.test.ts', distance: 0 },
    ])).toEqual([
      'tests/unit/S.test.ts',
      'tests/unit/cluster/sharding/Y.test.ts',
      'tests/unit/cluster/C.test.ts',
      'tests/unit/cluster/B.test.ts',
      'tests/unit/cluster/Z.test.ts',
      'tests/unit/a/A.test.ts',
    ]);
  });

  test('an override wins over the derived list and is never capped', () => {
    const overrides = { 'src/cluster/Cluster.ts': ['tests/x.test.ts', 'tests/y.test.ts', 'tests/z.test.ts'] };
    expect(mapTests('src/cluster/Cluster.ts', { testPaths, sourcePaths, importsOf, overrides, maximum: 1 })).toEqual({
      tests: ['tests/x.test.ts', 'tests/y.test.ts', 'tests/z.test.ts'], via: 'override', candidates: 3, dropped: [],
    });
  });

  test('every testMap entry in the committed config names files that exist', () => {
    const repositoryRoot = join(import.meta.dir, '..', '..', '..');
    const config = JSON.parse(readFileSync(join(repositoryRoot, 'scripts', 'mutation-config.json'), 'utf8')) as {
      testMap: Record<string, string[] | string>;
      maxTestsPerFile: number;
    };
    expect(Number.isInteger(config.maxTestsPerFile)).toBe(true);
    const entries = Object.entries(config.testMap).filter(([key]) => !key.startsWith('$'));
    expect(entries.length).toBeGreaterThan(0);
    const missing = entries.flatMap(([source, tests]) => [source, ...(tests as string[])])
      .filter((path) => !existsSync(join(repositoryRoot, path)));
    expect(missing).toEqual([]);
  });
});

describe('the budget', () => {
  test('is spent at the deadline, not a millisecond later, and never without one', () => {
    expect(budgetSpent(1_000, 999)).toBe(false);
    expect(budgetSpent(1_000, 1_000)).toBe(true);
    expect(budgetSpent(undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  test('the report says per file how its tests were chosen and how many mutants the diff filtered', () => {
    const markdown = renderMarkdown({
      startedAt: 'now', bunVersion: '1.4.2', commit: 'abc',
      files: [{
        path: 'src/x.ts', tests: ['a', 'b'], testMapping: { via: 'one-hop', candidates: 5, dropped: ['c', 'd', 'e'] },
        changedLines: { kept: 4, filtered: 17 }, invalid: 0, equivalent: 0, mutants: [], counts: countStatuses([]),
      }],
      totals: countStatuses([]),
    });
    expect(markdown).toContain('| `src/x.ts` | one-hop | 2 | 3 | 4 | 17 |');
  });
});

describe('classification and the report', () => {
  test('a hang is timed-out, a red run killed, a green run survived', () => {
    expect(classifyRun({ exitCode: null, timedOut: true })).toBe('timed-out');
    // A watchdog kill can still surface an exit code; the timeout wins.
    expect(classifyRun({ exitCode: 1, timedOut: true })).toBe('timed-out');
    expect(classifyRun({ exitCode: 1, timedOut: false })).toBe('killed');
    expect(classifyRun({ exitCode: 0, timedOut: false })).toBe('survived');
  });

  test('the score counts a timeout as detected and leaves no-coverage and not-run out', () => {
    const counts = countStatuses([
      { status: 'killed' }, { status: 'killed' }, { status: 'timed-out' }, { status: 'survived' },
      { status: 'no-coverage' }, { status: 'not-run' },
    ]);
    expect(counts.score).toBe(0.75);
    expect(counts.total).toBe(6);
    expect(countStatuses([{ status: 'no-coverage' }]).score).toBeNull();
  });

  test('the per-mutant timeout scales with the baseline and has a floor', () => {
    expect(timeoutFor(1_000)).toBe(15_000);
    expect(timeoutFor(20_000)).toBe(70_000);
    expect(timeoutFor(20_000, { fixedMs: 5_000 })).toBe(5_000);
  });

  test('the markdown report lists every survivor and every timeout with its location', () => {
    const mutant = (status: 'survived' | 'timed-out' | 'killed', line: number) => ({
      id: line, operator: 'equality' as const, original: '===', replacement: '!==', line, column: 3, lineText: 'a === b', status,
    });
    const mutants = [mutant('survived', 4), mutant('timed-out', 9), mutant('killed', 12)];
    const markdown = renderMarkdown({
      startedAt: 'now', bunVersion: '1.4.2', commit: 'abc',
      files: [{ path: 'src/x.ts', tests: ['t'], invalid: 0, equivalent: 0, mutants, counts: countStatuses(mutants) }],
      totals: countStatuses(mutants),
    });
    expect(markdown).toContain('`src/x.ts:4:3`');
    expect(markdown).toContain('**timed-out** `src/x.ts:9:3`');
    expect(markdown).not.toContain('src/x.ts:12:3');
    expect(markdown).toContain('66.7 %');
  });

  test('the baseline records finished files only, and the report prints it beside today', () => {
    const mutant = (status: 'survived' | 'killed' | 'not-run') => ({
      id: 1, operator: 'equality' as const, original: '===', replacement: '!==', line: 1, column: 1, lineText: '', status,
    });
    const file = (path: string, statuses: Array<'survived' | 'killed' | 'not-run'>, skipped?: string) => {
      const mutants = statuses.map(mutant);
      return { path, tests: ['t'], invalid: 0, equivalent: 0, mutants, counts: countStatuses(mutants), ...(skipped ? { skipped } : {}) };
    };
    const files = [
      file('src/done.ts', ['killed', 'survived', 'survived']),
      file('src/partial.ts', ['killed', 'not-run']),
      file('src/red.ts', [], 'baseline red'),
    ];
    const report = { startedAt: 'now', bunVersion: '1.4.2', commit: 'abc', files, totals: countStatuses([]) };
    expect(baselineDocument(report).files).toEqual({ 'src/done.ts': { killed: 1, timedOut: 0, survived: 2, noCoverage: 0 } });

    const withBaseline = renderMarkdown({ ...report, baseline: { 'src/done.ts': { killed: 0, timedOut: 0, survived: 5, noCoverage: 0 } } });
    expect(withBaseline).toMatch(/\| `src\/done\.ts` \| 1 \| 33\.3 % \| 1 \| 0 \| 2 \| 5 \|/);
    expect(withBaseline).toMatch(/\| `src\/partial\.ts` \| 1 \| 100\.0 % \| 1 \| 0 \| 0 \| — \|/);
  });

  test('arguments: an unknown operator and an empty report directory are refused', () => {
    expect(parseArguments(['--files=src/a/*.ts', 'src/b.ts', '--operators=equality']).operators).toEqual(['equality']);
    expect(() => parseArguments(['--operators=negate'])).toThrow(/unknown operator/);
    expect(() => parseArguments(['--report-dir='])).toThrow(/non-empty/);
  });
});

describe('the tree is never left mutated', () => {
  function scratch(): { directory: string; file: string; original: Buffer } {
    const directory = mkdtempSync(join(tmpdir(), 'mutation-guard-'));
    const file = join(directory, 'Subject.ts');
    // CRLF and a BOM: the restore must be byte-exact, not a re-encoded string.
    const original = Buffer.from('\uFEFFexport const a = 1 < 2;\r\n', 'utf8');
    writeFileSync(file, original);
    return { directory, file, original };
  }

  test('restore puts the original bytes back and drops the journal entry', () => {
    const { directory, file, original } = scratch();
    try {
      const journal = join(directory, 'journal');
      const guard = createFileGuard({ journalDirectory: journal, root: directory });
      guard.mutate('Subject.ts', original, 'export const a = 1 <= 2;\n');
      expect(readFileSync(file, 'utf8')).toBe('export const a = 1 <= 2;\n');
      expect(readdirSync(journal)).toHaveLength(1);
      guard.restore('Subject.ts');
      expect(readFileSync(file).equals(original)).toBe(true);
      expect(readdirSync(journal)).toHaveLength(0);
      expect(existsSync(`${file}.mutation-tmp`)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a run that dies without restoring is undone by the next run from the journal', () => {
    const { directory, file, original } = scratch();
    try {
      const journal = join(directory, 'journal');
      // The first guard mutates and is then abandoned, as a SIGKILL would leave it.
      createFileGuard({ journalDirectory: journal, root: directory }).mutate('Subject.ts', original, 'mutant');
      expect(readFileSync(file, 'utf8')).toBe('mutant');
      const restored = createFileGuard({ journalDirectory: journal, root: directory }).recover();
      expect(restored).toEqual(['Subject.ts']);
      expect(readFileSync(file).equals(original)).toBe(true);
      expect(readdirSync(journal)).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a signal restores the file, then exits with 128 + its number; exit restores too', () => {
    const { directory, file, original } = scratch();
    try {
      const guard = createFileGuard({ journalDirectory: join(directory, 'journal'), root: directory });
      const target = Object.assign(new EventEmitter(), { exitCodes: [] as number[], exit(code: number) { this.exitCodes.push(code); } });
      const dispose = installRestoreHandlers(guard, { target });

      guard.mutate('Subject.ts', original, 'mutant');
      target.emit('SIGINT');
      expect(readFileSync(file).equals(original)).toBe(true);
      expect(target.exitCodes).toEqual([130]);

      guard.mutate('Subject.ts', original, 'mutant');
      target.emit('exit');
      expect(readFileSync(file).equals(original)).toBe(true);

      dispose();
      expect(target.listenerCount('SIGTERM') + target.listenerCount('exit')).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a signal restores first, then writes the partial report, and exits even when that write fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mutation-interrupt-'));
    try {
      const file = join(directory, 'Subject.ts');
      const original = Buffer.from('export const a = 1 === 1;\n');
      writeFileSync(file, original);
      const guard = createFileGuard({ journalDirectory: join(directory, 'journal'), root: directory });
      const target = Object.assign(new EventEmitter(), { exitCodes: [] as number[], exit(code: number) { this.exitCodes.push(code); } });
      const seenByReport: Array<[string, boolean]> = [];
      const dispose = installRestoreHandlers(guard, {
        target,
        onInterrupted: (signal) => seenByReport.push([signal, readFileSync(file).equals(original)]),
      });
      guard.mutate('Subject.ts', original, 'mutant');
      target.emit('SIGTERM');
      // The report writer ran after the restore, so it saw the original bytes.
      expect(seenByReport).toEqual([['SIGTERM', true]]);
      expect(target.exitCodes).toEqual([143]);
      dispose();

      const logged: string[] = [];
      const failing = Object.assign(new EventEmitter(), { exitCodes: [] as number[], exit(code: number) { this.exitCodes.push(code); } });
      const disposeFailing = installRestoreHandlers(guard, {
        target: failing,
        onInterrupted: () => { throw new Error('disk full'); },
        log: (line) => logged.push(line),
      });
      guard.mutate('Subject.ts', original, 'mutant');
      failing.emit('SIGHUP');
      expect(readFileSync(file).equals(original)).toBe(true);
      expect(failing.exitCodes).toEqual([129]);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('disk full');
      disposeFailing();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /**
   * End to end, over a throwaway project: the runner's cwd is a temporary
   * directory with one source file and its same-name test, so nothing in the
   * repository is mutated.  The stop file is the path used here because it is
   * the one that works on Windows, where a signal sent to a child process ends
   * it without running its handlers; the signal path itself is pinned above.
   */
  test('a stop file ends the run between mutants with the tree restored and a partial report', async () => {
    const repositoryRoot = join(import.meta.dir, '..', '..', '..');
    const script = join(repositoryRoot, 'scripts', 'mutation-run.mjs');
    const project = mkdtempSync(join(tmpdir(), 'mutation-stop-'));
    try {
      mkdirSync(join(project, 'src'));
      mkdirSync(join(project, 'tests'));
      const source = [
        'export function clamp(value: number, low: number, high: number): number {',
        '  if (value < low) return low;',
        '  if (value > high) return high;',
        '  return value;',
        '}',
        'export function both(a: boolean, b: boolean): boolean {',
        '  return a && b;',
        '}',
        'export function same(a: number, b: number): boolean {',
        '  return a === b;',
        '}',
        '',
      ].join('\n');
      writeFileSync(join(project, 'src', 'Fixture.ts'), source);
      const testImport = `import { both, clamp, same } from ${"'"}../src/Fixture.ts';`;
      writeFileSync(join(project, 'tests', 'Fixture.test.ts'), [
        "import { expect, test } from 'bun:test';",
        testImport,
        // Slow enough that the stop file lands while mutants remain.
        'test("fixture", async () => {',
        '  await Bun.sleep(300);',
        '  expect(clamp(5, 0, 10)).toBe(5); expect(clamp(-1, 0, 10)).toBe(0); expect(clamp(11, 0, 10)).toBe(10);',
        '  expect(both(true, false)).toBe(false); expect(same(1, 2)).toBe(false);',
        '});',
        '',
      ].join('\n'));
      const stopFile = join(project, 'STOP');
      const reportDirectory = join(project, 'report');
      const run = Bun.spawn(
        [process.execPath, script, 'src/Fixture.ts', '--config', join(repositoryRoot, 'scripts', 'mutation-config.json'),
          '--report-dir', reportDirectory, '--stop-file', stopFile],
        { cwd: project, stdout: 'pipe', stderr: 'pipe' },
      );
      let output = '';
      let requested = false;
      const decoder = new TextDecoder();
      for await (const chunk of run.stdout) {
        output += decoder.decode(chunk);
        // Once a mutant has a verdict, ask the run to stop — once: the runner
        // consumes the file, and writing it again would outlive the run.
        if (!requested && /#\d+ .*: (?:killed|SURVIVED|timed-out)/.test(output)) {
          requested = true;
          writeFileSync(stopFile, '');
        }
      }
      const exitCode = await run.exited;

      expect(exitCode).toBe(143);
      expect(readFileSync(join(project, 'src', 'Fixture.ts'), 'utf8')).toBe(source);
      expect(existsSync(stopFile)).toBe(false);
      const report = JSON.parse(readFileSync(join(reportDirectory, 'report.json'), 'utf8')) as {
        interrupted?: { signal: string; at: string };
        files: Array<{ path: string; mutants: Array<{ status: string }> }>;
      };
      expect(report.interrupted?.signal).toBe('stop-file');
      const statuses = report.files[0]!.mutants.map((mutant) => mutant.status);
      expect(statuses.filter((status) => status !== 'not-run').length).toBeGreaterThanOrEqual(1);
      expect(statuses).toContain('not-run');
      expect(readFileSync(join(reportDirectory, 'report.md'), 'utf8')).toContain('**Partial report** — interrupted by stop-file');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('the watchdog', () => {
  test('a child that never exits is killed and reported as timed out', async () => {
    const result = await runWithTimeout(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 500 });
    expect(result.timedOut).toBe(true);
    expect(classifyRun(result)).toBe('timed-out');
  });

  test('a red child is killed and a green one survived', async () => {
    const red = await runWithTimeout(process.execPath, ['-e', 'process.exit(1)'], { timeoutMs: 4_000 });
    const green = await runWithTimeout(process.execPath, ['-e', 'console.log("ok")'], { timeoutMs: 4_000 });
    expect(classifyRun(red)).toBe('killed');
    expect(classifyRun(green)).toBe('survived');
    expect(green.output).toContain('ok');
  });
});

describe('the command line', () => {
  /**
   * Every value-taking flag, with a value it accepts and where that value must
   * land.  `--files src/x.ts` — the space-separated spelling most people type —
   * used to reach `new Bun.Glob(undefined)` and die with a stack trace.
   */
  type Parsed = ReturnType<typeof parseArguments>;
  const valued: ReadonlyArray<readonly [string, string, (options: Parsed) => unknown, unknown]> = [
    ['files', 'src/util/*.ts', (o) => o.globs, ['src/util/*.ts']],
    ['since', 'origin/develop', (o) => o.since, 'origin/develop'],
    ['set', 'nightly', (o) => o.set, 'nightly'],
    ['tests', 'a.test.ts,b.test.ts', (o) => o.tests, ['a.test.ts', 'b.test.ts']],
    ['operators', 'equality,logical', (o) => o.operators, ['equality', 'logical']],
    ['report-dir', '.mutation-x', (o) => o.reportDirectory, '.mutation-x'],
    ['config', 'c.json', (o) => o.configPath, 'c.json'],
    ['baseline', 'b.json', (o) => o.baselinePath, 'b.json'],
    ['timeout-factor', '4', (o) => o.timeoutFactor, 4],
    ['timeout', '9000', (o) => o.timeoutMs, 9000],
    ['budget-minutes', '30', (o) => o.budgetMinutes, 30],
    ['max-mutants', '5', (o) => o.maximumMutantsPerFile, 5],
    ['max-tests-per-file', '12', (o) => o.maximumTestsPerFile, 12],
    ['stop-file', '.mutation/STOP', (o) => o.stopFile, '.mutation/STOP'],
    ['mutants', '1,7,28', (o) => o.mutantIds, [1, 7, 28]],
  ];

  test.each(valued)('--%s takes its value with = and as the next argument', (name, value, read, expected) => {
    expect(read(parseArguments([`--${name}=${value}`]))).toEqual(expected);
    const spaced = parseArguments([`--${name}`, value, 'src/Supervision.ts']);
    expect(read(spaced)).toEqual(expected);
    // The value is consumed, not mistaken for a path; the path after it is not.
    expect(spaced.files).toEqual(['src/Supervision.ts']);
  });

  test.each(valued)('--%s without a value is a usage error, at the end and before another flag', (name) => {
    expect(() => parseArguments([`--${name}`])).toThrow(UsageError);
    expect(() => parseArguments([`--${name}`])).toThrow(`--${name} needs a value`);
    expect(() => parseArguments([`--${name}`, '--dry-run'])).toThrow(`--${name} needs a value`);
    expect(() => parseArguments([`--${name}=`])).toThrow(UsageError);
  });

  test('a switch takes no value, and a number flag refuses a word', () => {
    const parsed = parseArguments(['--dry-run', 'src/a.ts']);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.files).toEqual(['src/a.ts']);
    expect(() => parseArguments(['--dry-run=yes'])).toThrow(UsageError);
    expect(() => parseArguments(['--budget-minutes', 'soon'])).toThrow('--budget-minutes needs a number');
    expect(() => parseArguments(['--mutants', '1,x'])).toThrow(UsageError);
    expect(() => parseArguments(['--nonsense'])).toThrow(UsageError);
  });

  test('--changed-lines needs --since, and the test cap a whole number of at least one', () => {
    expect(parseArguments(['--since=v0.18.0', '--changed-lines']).changedLines).toBe(true);
    expect(parseArguments(['--since=v0.18.0']).changedLines).toBe(false);
    expect(() => parseArguments(['--changed-lines', 'src/a.ts'])).toThrow('--changed-lines needs --since');
    expect(() => parseArguments(['--max-tests-per-file=0'])).toThrow(UsageError);
    expect(() => parseArguments(['--max-tests-per-file=2.5'])).toThrow(UsageError);
    expect(parseArguments(['--max-tests-per-file=1']).maximumTestsPerFile).toBe(1);
  });

  test('a spent budget stops before the baseline run and still writes the report', () => {
    const repositoryRoot = join(import.meta.dir, '..', '..', '..');
    const script = join(repositoryRoot, 'scripts', 'mutation-run.mjs');
    const reportDirectory = mkdtempSync(join(tmpdir(), 'mutation-budget-'));
    try {
      // Not a dry run: with any budget left this would run OptionsMerge's tests under coverage.
      const run = Bun.spawnSync(
        [process.execPath, script, 'src/util/OptionsMerge.ts', '--budget-minutes=0', '--report-dir', reportDirectory],
        { cwd: repositoryRoot },
      );
      expect(run.stderr.toString()).toBe('');
      expect(run.exitCode).toBe(0);
      const report = JSON.parse(readFileSync(join(reportDirectory, 'report.json'), 'utf8')) as {
        files: Array<{ path: string; skipped?: string; tests: string[]; testMapping: { via: string }; counts: Record<string, number> }>;
      };
      const [file] = report.files;
      expect(file!.path).toBe('src/util/OptionsMerge.ts');
      expect(file!.skipped).toBe('budget exhausted');
      expect(file!.counts['not-run']).toBe(2);
      expect(file!.tests.length).toBeGreaterThan(0);
      expect(file!.testMapping.via).toBe('direct');
      // The baseline never ran, so it left no coverage and no baseline log behind.
      expect(readdirSync(reportDirectory).sort()).toEqual(['report.json', 'report.md']);
    } finally {
      rmSync(reportDirectory, { recursive: true, force: true });
    }
  });

  test('the script exits 2 with one line for a missing value, and runs with the spaced form', () => {
    const repositoryRoot = join(import.meta.dir, '..', '..', '..');
    const script = join(repositoryRoot, 'scripts', 'mutation-run.mjs');
    const missing = Bun.spawnSync([process.execPath, script, '--files'], { cwd: repositoryRoot });
    expect(missing.exitCode).toBe(2);
    const stderr = missing.stderr.toString();
    expect(stderr).toContain('--files needs a value');
    expect(stderr).not.toContain(' at ');

    const reportDirectory = mkdtempSync(join(tmpdir(), 'mutation-cli-'));
    try {
      // A dry run reads the file and lists its mutants; it never writes to src/.
      const spaced = Bun.spawnSync(
        [process.execPath, script, '--files', 'src/util/OptionsMerge.ts', '--report-dir', reportDirectory, '--dry-run'],
        { cwd: repositoryRoot },
      );
      expect(spaced.stderr.toString()).toBe('');
      expect(spaced.exitCode).toBe(0);
      expect(spaced.stdout.toString()).toContain('src/util/OptionsMerge.ts: 2 mutant(s)');
    } finally {
      rmSync(reportDirectory, { recursive: true, force: true });
    }
  });
});
