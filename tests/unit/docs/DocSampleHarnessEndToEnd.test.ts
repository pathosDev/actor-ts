import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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

type Run = { readonly status: number; readonly stdout: string; readonly stderr: string };

let fixture = '';
let outName = '';
let plain: Run;
let report: Run;

function run(...extra: string[]): Run {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, `--docs=${relative(ROOT, fixture).split('\\').join('/')}`, `--out=${outName}`, ...extra],
    { cwd: ROOT, encoding: 'utf8' },
  );
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
});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
  rmSync(join(ROOT, outName), { recursive: true, force: true });
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
  });

  test('the generated tree is cleaned up', () => {
    expect(plain.stdout).not.toContain('ENOENT');
    expect(report.stderr).toBe('');
  });
});
