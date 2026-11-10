import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

/**
 * The doc-sample harness driven end to end over a fixture documentation tree,
 * because its two load-bearing properties cannot be proved any other way.
 *
 * `DocSampleHarness.test.ts` covers the classifiers directly. What it cannot
 * cover is what TypeScript actually *does* with the tree that comes out:
 *
 *  - **A grammar error suppresses the semantic pass for the whole program.**
 *    That is a fact about `tsc`, not about this script, and it is the fact the
 *    script shipped ignoring — four mislabelled fences reduced it to a
 *    four-line syntax report that read as a pass. The fixture puts an
 *    unparseable fence and a wrong-argument fence in the same run and requires
 *    both to be reported. A stubbed compiler would let a broken second pass
 *    pass its own test.
 *  - **The continuity prologue has to be invisible to the line arithmetic and
 *    to every other file.** Only a real compile shows whether `declare var`
 *    inside a module stays inside it, and whether the reported page line is the
 *    line the author wrote.
 *
 * The fixture compiles against the real `package.json#exports` map, so the
 * types in it are the shipped ones — `ActorSystem.create` really does take a
 * string, which is what makes the wrong-argument fence a genuine TS2345.
 */

const ROOT = join(import.meta.dir, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-doc-samples.mjs');

/** Fence 1 declares `cache`; fence 2 imports and goes on using it. */
const CONTINUED_PAGE = [
  '# Continued',
  '',
  '```ts',
  "import { InMemoryCache } from 'actor-ts/cache';",
  '',
  'const cache = new InMemoryCache({ maxEntries: 10 });',
  '```',
  '',
  'And later on the same page:',
  '',
  '```ts',
  "import { InMemoryCacheOptions } from 'actor-ts/cache';",
  '',
  "const tuned = InMemoryCacheOptions.create().withMaxEntries(20);",
  "await cache.set('key', 'value');",
  '```',
].join('\n');

/**
 * A `package.json` snippet mislabelled `ts` — the real shape of two of the four
 * fences that were blinding the semantic pass.
 */
const UNPARSEABLE_PAGE = [
  '# Unparseable',
  '',
  '```ts',
  "import { ActorSystem } from 'actor-ts';",
  '{ "type": "module" }',
  '```',
].join('\n');

/** A real published-API mismatch: `create` takes a name, not a number. */
const WRONG_ARGUMENT_PAGE = [
  '# Wrong argument',
  '',
  'Some prose first, so the fence does not start at line 1.',
  '',
  '```ts',
  "import { ActorSystem } from 'actor-ts';",
  '',
  'const broken = await ActorSystem.create(42);',
  '```',
].join('\n');

/** Only names nothing in the corpus imports from actor-ts — a prose fragment. */
const PROSE_PAGE = [
  '# Prose',
  '',
  '```ts',
  "import { InMemoryCache } from 'actor-ts/cache';",
  '',
  'const shared = system.extension(someExtensionId);',
  '```',
].join('\n');

/** Uses a name other fixture pages import from actor-ts, without importing it. */
const MISSING_IMPORT_PAGE = [
  '# Missing import',
  '',
  '```ts',
  "import { InMemoryCache } from 'actor-ts/cache';",
  '',
  'const options = InMemoryCacheOptions.create();',
  '```',
].join('\n');

/**
 * Fence 1 imports a builder; fence 2 misuses it. The misuse is only visible if
 * the carried name keeps its real type instead of being stubbed as `any`.
 */
const TYPED_CONTINUATION_PAGE = [
  '# Typed continuation',
  '',
  '```ts',
  "import { InMemoryCacheOptions } from 'actor-ts/cache';",
  '',
  'const first = InMemoryCacheOptions.create();',
  '```',
  '',
  'Later:',
  '',
  '```ts',
  "import { InMemoryCache } from 'actor-ts/cache';",
  '',
  "const misused = InMemoryCacheOptions.create().withMaxEntries('not a number');",
  '```',
].join('\n');

/** Deliberately not a program, and says why. */
const EXEMPT_PAGE = [
  '# Exempt',
  '',
  '```ts no-compile — two modules in one fence',
  "import { ActorSystem } from 'actor-ts';",
  'const nonsense: number = "not a number";',
  '```',
].join('\n');

/**
 * What one harness run may take before it is stuck rather than merely slow.
 *
 * A run is **two** `bunx tsc` compiles, not one: the fixture deliberately
 * carries an unparseable fence, and dropping it to re-check the rest is the
 * first of the two properties above.  `beforeAll` makes two runs, so the hook
 * spawns four compilers in series — which is why its cost tracks the machine's
 * load rather than the size of the fixture.
 *
 * Measured on this tree at `299c0b5c` (Windows, 32 CPUs, bun 1.4.0), per run
 * and per hook, worst of each set: **idle** 1.66 s / 3.06 s; inside a **full
 * `bun test`** 2.72 s / 4.32 s; with **4 copies of this file in flight** 3.33 s
 * / 5.30 s; with **8 copies** 5.33 s / 8.97 s.  Bun caps a hook at 5 000 ms
 * unless it is told otherwise, and nothing raises that globally — so the hook
 * crossed its cap from the third case on, and the file failed roughly three
 * whole-suite runs in four as `(unnamed)` (#1282).
 *
 * 30 s is ~6x the slowest run ever measured here, so a loaded machine does not
 * reach it, while a genuinely wedged compiler is still named in seconds rather
 * than at the hook's backstop below.
 */
const RUN_BUDGET_MS = 30_000;

/**
 * The hook's cap is a backstop, not the budget — it sits clear of both runs'
 * budgets on purpose, so a stall is reported by {@link run}, which names the
 * script, its flags and the elapsed time.  Bun's own hook timeout names none of
 * that: it reports `(unnamed)` and calls a `beforeAll` a
 * `beforeEach/afterEach` hook, which is what made #1282 read as a mystery.
 * Reaching this cap therefore means the hook stalled somewhere that is *not* a
 * spawn — writing the fixture pages, say.
 */
const HOOK_BUDGET_MS = 3 * RUN_BUDGET_MS;

/**
 * `--measure` classifies fences and exits before anything is emitted, so it
 * never compiles — but it is still a {@link run}, and its call site is a
 * `test()` rather than the hook.  The cap has to clear `RUN_BUDGET_MS` or the
 * budget could never be the thing that reports, which is its own flake shape
 * (`docs/…/testing/diagnosing-flakes.mdx`).
 */
const MEASURE_BUDGET_MS = RUN_BUDGET_MS + 15_000;

type Run = { readonly status: number; readonly stdout: string; readonly stderr: string };

let fixture = '';
let outName = '';
let plain: Run;
let report: Run;

function run(...extra: string[]): Run {
  const startedAt = performance.now();
  const result = spawnSync(
    process.execPath,
    [SCRIPT, `--docs=${relative(ROOT, fixture).split('\\').join('/')}`, `--out=${outName}`, ...extra],
    { cwd: ROOT, encoding: 'utf8', timeout: RUN_BUDGET_MS },
  );
  // A run the budget killed — or one that never started — carries no exit
  // status, so without this it reads as `status: -1` with empty output and fails
  // whichever assertion inspects that output first, burying the cause under a
  // diff of two empty strings.
  if (result.error !== undefined || result.signal !== null) {
    const elapsed = Math.round(performance.now() - startedAt);
    throw new Error(
      `check-doc-samples.mjs ${extra.join(' ') || '(no flags)'} did not complete: `
      + `${result.error?.message ?? `killed by ${result.signal}`} after ${elapsed} ms, `
      + `against a ${RUN_BUDGET_MS} ms budget. Each run spawns two \`bunx tsc\` compiles; `
      + 'if a real machine reaches this, the budget is wrong — report the figure on #1282.',
    );
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

beforeAll(() => {
  // Both trees go under the gitignored `tmp/`, not the OS temp directory: the
  // generated tsconfig extends `../tsconfig.json` and resolves `actor-ts…` into
  // `../src`, so the output has to sit exactly one directory below the
  // repository root — which `tmp/` is, and `os.tmpdir()` is not. A crashed run
  // then leaves nothing untracked behind either.
  mkdirSync(join(ROOT, 'tmp'), { recursive: true });
  fixture = mkdtempSync(join(ROOT, 'tmp', 'doc-sample-fixture-'));
  outName = `tmp/doc-samples-out-${String(process.pid)}`;
  mkdirSync(join(fixture, 'nested'), { recursive: true });
  writeFileSync(join(fixture, 'continued.mdx'), CONTINUED_PAGE, 'utf8');
  writeFileSync(join(fixture, 'unparseable.mdx'), UNPARSEABLE_PAGE, 'utf8');
  writeFileSync(join(fixture, 'wrong-argument.mdx'), WRONG_ARGUMENT_PAGE, 'utf8');
  writeFileSync(join(fixture, 'typed-continuation.mdx'), TYPED_CONTINUATION_PAGE, 'utf8');
  writeFileSync(join(fixture, 'nested', 'prose.mdx'), PROSE_PAGE, 'utf8');
  writeFileSync(join(fixture, 'nested', 'missing-import.mdx'), MISSING_IMPORT_PAGE, 'utf8');
  writeFileSync(join(fixture, 'exempt.mdx'), EXEMPT_PAGE, 'utf8');
  plain = run();
  report = run('--report');
}, HOOK_BUDGET_MS);

afterAll(() => {
  // Each removal only once its path was assigned. bun test runs this hook even
  // when `beforeAll` threw before assigning, and both variables start as '':
  // `join(ROOT, '')` is the repository root, and on Bun `rmSync('', { recursive:
  // true, force: true })` empties the working directory.
  if (fixture !== '') rmSync(fixture, { recursive: true, force: true });
  if (outName !== '') rmSync(join(ROOT, outName), { recursive: true, force: true });
});

describe('the doc-sample harness over a fixture tree', () => {
  test('it scans the tree it was pointed at, recursively', () => {
    expect(plain.stdout).toContain('pages scanned          7');
    expect(plain.stdout).toContain('no-compile (exempt)  1');
  });

  test('a carried import keeps its real type, so misusing it is a real error', () => {
    // The whole point of re-importing rather than stubbing: with the carried
    // `InMemoryCacheOptions` typed `any`, `withMaxEntries('not a number')` is
    // accepted and the fence reads as clean.
    expect(plain.stderr).toMatch(/typed-continuation\.mdx:14:\d+\s+TS2345/);
  });

  test('an unparseable fence does not hide a type error in another fence', () => {
    // The regression this whole rework exists for. Before the second pass,
    // `tsc` reported the TS1005 and nothing else, for the entire program.
    expect(plain.stderr).toContain('TS1005');
    expect(plain.stderr).toContain('TS2345');
    expect(plain.status).toBe(1);
  });

  test('the syntax error is attributed to the mislabelled page', () => {
    expect(plain.stderr).toMatch(/unparseable\.mdx:\d+:\d+\s+TS1005/);
  });

  test('the type error points at the line the author wrote', () => {
    // `ActorSystem.create(42)` is on page line 8; a prologue counted wrong
    // would report 7 or 9, which is prose either side of the call.
    expect(plain.stderr).toMatch(/wrong-argument\.mdx:8:\d+\s+TS2345/);
  });

  test('a fence continuing an earlier fence on the same page compiles clean', () => {
    // `cache` comes from fence 1; only the continuity prologue makes fence 2 a
    // program at all.
    expect(plain.stderr).not.toContain("Cannot find name 'cache'");
    expect(report.stdout).toMatch(/clean\s+3/);
  });

  test('the continuity declarations do not leak into other files', () => {
    // `cache` is declared for the second fence of continued.mdx only. If the
    // prologue leaked, prose.mdx would inherit names it never wrote — and the
    // per-file `declare var` is the only thing stopping that.
    expect(report.stdout).toMatch(/prose \(reclassified fragment\) 1/);
  });

  test('a fence built on prose placeholders is a fragment, not a failure', () => {
    expect(plain.stderr).not.toContain('prose.mdx');
    expect(report.stdout).toContain('  system');
  });

  test('a name other pages import from actor-ts is a reported missing import', () => {
    expect(report.stdout).toMatch(/missing import\s+1/);
    expect(plain.stderr).toMatch(/missing-import\.mdx:\d+:\d+\s+TS2304/);
  });

  test('a no-compile fence is never compiled, however broken it is', () => {
    // `const nonsense: number = "not a number"` is a certain TS2322.
    expect(plain.stderr).not.toContain('exempt.mdx');
    expect(plain.stderr).not.toContain('TS2322');
  });

  test('--report never fails, whatever it finds', () => {
    expect(report.status).toBe(0);
    expect(report.stdout).toContain('reported fences by page');
  });

  test('--report names the exemption reason so it can be reviewed', () => {
    const measured = run('--measure');
    expect(measured.stdout).toContain('two modules in one fence');
  }, MEASURE_BUDGET_MS);

  test('the generated tree is cleaned up', () => {
    expect(plain.stdout).not.toContain('ENOENT');
    expect(report.stderr).toBe('');
  });
});

/**
 * What a compiler that died looks like to the harness.
 *
 * The phase-34 gate ran this script while the machine was out of memory, and
 * `bunx tsc` stopped with `fatal error: runtime: cannot allocate memory`: exit
 * status 2, a goroutine dump on stderr, and not one diagnostic.  The script
 * read that as a program without diagnostics, so every fence counted as clean
 * and the run printed `OK`.  These stand-ins replace `bunx` on the PATH the
 * harness inherits — it resolves the command through the PATH like any other
 * — so each one is the real script facing one way a compile can end.
 *
 * A stand-in ignores its arguments, prints `output` to stderr and exits with
 * `status`; `signal` has it killed instead, the end a POSIX out-of-memory kill
 * gives.  Windows has no signals: a process the system kills there exits with
 * an NTSTATUS code, which is what the `win32` branch of that case uses.
 */
type FakeCompiler = {
  readonly name: string;
  readonly output: string;
  readonly status: number;
  readonly signal?: 'SIGKILL';
};

/** The fence a working compiler reports, so a run that says `OK` has trusted a compiler that checked nothing. */
const COMPILED_PAGE = WRONG_ARGUMENT_PAGE;

/** How the Go runtime of TypeScript 7 ends when an allocation fails — the measured case. */
const OUT_OF_MEMORY = [
  'fatal error: runtime: cannot allocate memory',
  '',
  'goroutine 1 [running]:',
  'runtime.throw({0x7ff6b2c1a3f0?, 0x0?})',
  '',
].join('\n');

/** A diagnostic in the shape `tsc` prints it, for the cases where some output came before the end. */
const ONE_DIAGNOSTIC = "tmp/elsewhere.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n";

/** STATUS_STACK_BUFFER_OVERRUN, the exit a process killed for want of commit memory reports on Windows. */
const KILLED_ON_WINDOWS = -1073740791;

/**
 * A configuration TypeScript refuses, in the shape TypeScript 7 prints it —
 * measured with a `baseUrl` left in a tsconfig.  It reports this and nothing
 * else: no fence is checked at all.
 */
const REJECTED_CONFIGURATION = [
  "tmp/doc-samples-out/tsconfig.json(1,40): error TS5102: Option 'baseUrl' has been removed. Please remove it from your configuration.",
  '  Use \'"paths": {"*": ["./*"]}\' instead.',
  '',
].join('\n');

/** The project file itself missing — reported without a location. */
const MISSING_PROJECT = "error TS5058: The specified path does not exist: 'tmp/doc-samples-out/tsconfig.json'.\n";

function fakeCompilerIn(directory: string, fake: FakeCompiler): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'output.txt'), fake.output, 'utf8');
  if (process.platform === 'win32') {
    const status = fake.signal === undefined ? fake.status : KILLED_ON_WINDOWS;
    writeFileSync(join(directory, 'bunx.cmd'), `@echo off\r\ntype "%~dp0output.txt" 1>&2\r\nexit /b ${String(status)}\r\n`, 'utf8');
    return;
  }
  const end = fake.signal === undefined ? `exit ${String(fake.status)}` : `kill -${fake.signal.slice(3)} $$`;
  writeFileSync(join(directory, 'bunx'), `#!/bin/sh\ncat "$(dirname "$0")/output.txt" >&2\n${end}\n`, 'utf8');
  chmodSync(join(directory, 'bunx'), 0o755);
}

/** The test process's environment with `directory` first on the PATH, whatever case the variable's name has here. */
function environmentWithFirstOnPath(directory: string): Record<string, string> {
  const environment: Record<string, string> = {};
  let searchPath = '';
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.toLowerCase() === 'path') searchPath = value;
    else environment[key] = value;
  }
  environment['PATH'] = searchPath === '' ? directory : `${directory}${delimiter}${searchPath}`;
  return environment;
}

/** One run's spawn budget, plus room for the test around it — the reasoning of {@link MEASURE_BUDGET_MS}. */
const ONE_RUN_TEST_BUDGET_MS = RUN_BUDGET_MS + 15_000;

describe('a compiler that did not run to completion fails the harness', () => {
  let crashFixture = '';
  let crashOutName = '';

  beforeAll(() => {
    mkdirSync(join(ROOT, 'tmp'), { recursive: true });
    crashFixture = mkdtempSync(join(ROOT, 'tmp', 'doc-sample-crash-fixture-'));
    crashOutName = `tmp/doc-samples-crash-out-${String(process.pid)}`;
    mkdirSync(join(crashFixture, 'docs'), { recursive: true });
    writeFileSync(join(crashFixture, 'docs', 'compiled.mdx'), COMPILED_PAGE, 'utf8');
  });

  afterAll(() => {
    if (crashFixture !== '') rmSync(crashFixture, { recursive: true, force: true });
    if (crashOutName !== '') rmSync(join(ROOT, crashOutName), { recursive: true, force: true });
  });

  /** The real script over the one-page fixture, with `fake` standing in for `bunx`. */
  function runAgainst(fake: FakeCompiler): Run {
    const directory = join(crashFixture, `fake-${fake.name}`);
    fakeCompilerIn(directory, fake);
    const result = spawnSync(
      process.execPath,
      [SCRIPT, `--docs=${relative(ROOT, join(crashFixture, 'docs')).split('\\').join('/')}`, `--out=${crashOutName}`],
      { cwd: ROOT, encoding: 'utf8', timeout: RUN_BUDGET_MS, env: environmentWithFirstOnPath(directory) },
    );
    if (result.error !== undefined || result.signal !== null) {
      throw new Error(`check-doc-samples.mjs against the ${fake.name} stand-in did not complete: ${result.error?.message ?? `killed by ${result.signal}`}`);
    }
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  test.each<FakeCompiler>([
    { name: 'out-of-memory', output: OUT_OF_MEMORY, status: 2 },
    { name: 'exit-status-outside-tsc', output: ONE_DIAGNOSTIC, status: 134 },
    { name: 'crash-after-a-diagnostic', output: `${ONE_DIAGNOSTIC}${OUT_OF_MEMORY}`, status: 2 },
    { name: 'silent-failure', output: '', status: 1 },
    { name: 'killed', output: '', status: 0, signal: 'SIGKILL' },
    { name: 'configuration-rejected', output: REJECTED_CONFIGURATION, status: 1 },
    { name: 'project-not-found', output: MISSING_PROJECT, status: 1 },
  ])('$name: exit 2, and the run says the compiler did not finish instead of passing the fence', (fake) => {
    const ended = runAgainst(fake);
    expect(ended.stdout, 'a run that trusted the dead compiler prints OK').not.toContain('OK —');
    expect(ended.stderr).toContain('the compiler did not run to completion');
    expect(ended.status).toBe(2);
  }, ONE_RUN_TEST_BUDGET_MS);

  test('a compiler that exits 0 with nothing to say is still believed', () => {
    // The control: the stand-in is the compiler this run used — the fixture's
    // fence is a real TS2345, which a real compile reports — and a clean exit
    // is still the clean program it always was.
    const clean = runAgainst({ name: 'clean', output: '', status: 0 });
    expect(clean.stderr).toBe('');
    expect(clean.stdout).toContain('OK — 1 self-contained doc samples compile');
    expect(clean.status).toBe(0);
  }, ONE_RUN_TEST_BUDGET_MS);

  test('a tree with nothing to compile is not a crash, although the real compiler exits 2 on it', () => {
    // `tsc` over a program with no inputs reports `error TS18003: No inputs were
    // found` — no file, no line — and exits 2, the status of a crash.  It is a
    // finished compile with nothing in it, so the diagnostic counts as one.
    const empty = join(crashFixture, 'nothing-to-compile');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'exempt.mdx'), EXEMPT_PAGE, 'utf8');
    const result = spawnSync(
      process.execPath,
      [SCRIPT, `--docs=${relative(ROOT, empty).split('\\').join('/')}`, `--out=${crashOutName}`],
      { cwd: ROOT, encoding: 'utf8', timeout: RUN_BUDGET_MS },
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('compiled             0');
    expect(result.stdout).toContain('OK — 0 self-contained doc samples compile');
    expect(result.status).toBe(0);
  }, ONE_RUN_TEST_BUDGET_MS);
});
