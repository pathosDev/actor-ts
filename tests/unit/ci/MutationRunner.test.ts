import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  applyMutant,
  baselineDocument,
  classifyRun,
  codeMask,
  countStatuses,
  createFileGuard,
  findMutants,
  installRestoreHandlers,
  isMutableSource,
  lineHits,
  parseArguments,
  partitionMutants,
  renderMarkdown,
  runWithTimeout,
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
