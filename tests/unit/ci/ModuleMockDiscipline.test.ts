import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **A `mock.module` is process-wide and permanent, so a file that installs one
 * puts it back.**
 *
 * `mock.restore()` does *not* undo `mock.module()`.  That is not a subtlety —
 * it is the single most expensive misunderstanding in this test tree, and it
 * was written down as fact in a comment while nothing checked it.
 *
 * What it cost (#1422): `ZstdDecompressResolution.test.ts` replaces `node:zlib`
 * with a copy whose `zstdDecompressSync` throws, to drive the resolver down to
 * the pure-JS `fzstd` rung.  Its `afterEach` called `mock.restore()` and its
 * comment claimed that put `node:zlib` back.  It did not — so once that block
 * had run, the native decoder stayed suppressed for the rest of the process,
 * and three cases in `DecompressCap.test.ts` went on asserting the #580
 * allocation-time cap **while exercising a rung that has no such cap**.  They
 * failed loudly, which was luck: the message tail was the only observable that
 * separated the two paths, and a differently-worded assertion would have passed
 * while testing the opposite of the security property it names.
 *
 * The invariant is therefore narrow and mechanical: a file that calls
 * `mock.module` restores it inside an `afterEach` / `afterAll`, or it says why
 * it does not need to.
 *
 * Sibling repo-file guards, same shape: `tests/unit/ci/SleepRatchet.test.ts`,
 * `tests/unit/ci/NoEnvironmentGatedSkips.test.ts`,
 * `tests/unit/ci/WallClockRatchet.test.ts`.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const TESTS_DIRECTORY = join(REPOSITORY_ROOT, 'tests');

/** A single backslash, spelled so no shell heredoc or editor can eat it. */
const BACKSLASH = String.fromCharCode(92);

/**
 * Module mocks that are never put back, and why each is safe.
 *
 * The distinguishing property is **who else imports the specifier**.  Replacing
 * a runtime module (`node:zlib`, `node:fs`) changes the world for every suite
 * that runs afterwards.  Replacing an optional peer that exactly one file
 * imports changes nothing outside that file — and for those, restoring would be
 * theatre.
 *
 * **The exemption is per file, not per specifier, and that is a real hole** —
 * measured, not suspected: adding a second, unrelated `mock.module('node:zlib')`
 * to an exempt file leaves this guard green.  Keying on the specifier would
 * close it, and is not done because the reason a mock is safe is a sentence
 * about the *module*, which a per-specifier map would have to repeat per file.
 * The mitigation is that the list has one entry and gaining another is a
 * decision somebody writes down here.
 */
const UNRESTORED_MODULE_MOCKS: ReadonlyMap<string, string> = new Map([
  [
    'tests/unit/persistence/object-storage/S3ObjectStorageBackend.test.ts',
    '`@aws-sdk/client-s3` is an optional peer that no other suite imports — the '
    + 'mock IS this file\'s premise, installed before the backend is imported so '
    + 'its lazy `import()` resolves to the fake. Restoring it would restore a '
    + 'module nothing else asks for.',
  ],
]);

/** Every source this repository wrote under `tests/`. */
function testSources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      testSources(full, found);
      continue;
    }
    if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/**
 * `source` with comments and string literals blanked, character for character.
 *
 * Both have to go, and this file is the reason why: the guards in
 * `OptionalPeerDeclarations.test.ts` and `OptionalPeerModuleShapes.test.ts`
 * discuss `mock.module('@aws-sdk/client-s3', …)` in prose, and the very file
 * this rule was written for quotes the call it is warning about.
 */
function blankNonCode(source: string): string {
  const out = source.split('');
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') { out[index] = ' '; index++; }
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < source.length) { out[index] = ' '; out[index + 1] = ' '; index += 2; }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      out[index] = ' ';
      index++;
      while (index < source.length) {
        if (source[index] === BACKSLASH) {
          out[index] = ' ';
          if (source[index + 1] !== '\n') out[index + 1] = ' ';
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        if (source[index] !== '\n') out[index] = ' ';
        index++;
      }
      if (index < source.length) out[index] = ' ';
      index++;
      continue;
    }
    index++;
  }
  return out.join('');
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParenthesis(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === '(') depth++;
    else if (code[index] === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The `[start, end)` spans of every `afterEach(...)` / `afterAll(...)` call. */
export function teardownSpans(code: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  for (const match of code.matchAll(/\bafter(?:Each|All)\s*\(/g)) {
    const open = code.indexOf('(', match.index);
    const close = matchParenthesis(code, open);
    if (close > 0) spans.push([open, close] as const);
  }
  return spans;
}

/** Offsets of every real `mock.module(` call. */
export function moduleMockOffsets(code: string): number[] {
  return [...code.matchAll(/\bmock\s*\.\s*module\s*\(/g)].map((match) => match.index);
}

/**
 * Does this source install a module mock without putting one back in teardown?
 *
 * "Puts one back" is deliberately literal — a `mock.module` inside an
 * `afterEach` / `afterAll`. It cannot tell a *correct* restore from a wrong
 * one, and does not try to: it rules out the shape that actually shipped, which
 * was a teardown containing no `mock.module` at all.
 */
export function installsWithoutRestoring(source: string): boolean {
  const code = blankNonCode(source);
  const offsets = moduleMockOffsets(code);
  if (offsets.length === 0) return false;
  const spans = teardownSpans(code);
  return !offsets.some(
    (offset) => spans.some(([start, end]) => offset > start && offset < end),
  );
}

const relativeToRoot = (absolutePath: string): string =>
  absolutePath.split(BACKSLASH).join('/')
    .slice(REPOSITORY_ROOT.split(BACKSLASH).join('/').length + 1);

const scanned = testSources(TESTS_DIRECTORY).map((file) => ({
  file: relativeToRoot(file),
  source: readFileSync(file, 'utf8'),
}));

const installers = scanned.filter(
  (entry) => entry.file !== 'tests/unit/ci/ModuleMockDiscipline.test.ts'
    && moduleMockOffsets(blankNonCode(entry.source)).length > 0,
);

describe('a module mock is put back', () => {
  test('the scanner reads the tree it claims to', () => {
    expect(scanned.length).toBeGreaterThan(400);
    // Every assertion below is over `installers`; an empty list would pass them
    // all while the rule stopped applying to anything.
    expect(installers.map((entry) => entry.file)).not.toEqual([]);
  });

  test.each(installers)('$file restores what it replaced', ({ file, source }) => {
    if (UNRESTORED_MODULE_MOCKS.has(file)) return;
    expect(
      installsWithoutRestoring(source),
      `${file} calls mock.module and never calls one in an afterEach/afterAll. `
      + 'A module mock is process-wide and permanent — mock.restore() does NOT '
      + 'undo it — so it changes the world for every suite that runs after this '
      + 'file. Snapshot the real module before mocking and re-install it in '
      + 'teardown, or add an entry to UNRESTORED_MODULE_MOCKS saying why nothing '
      + 'else imports the specifier (#1422).',
    ).toBe(false);
  });

  test.each([...UNRESTORED_MODULE_MOCKS.keys()])(
    '%s still installs a module mock, so its exemption is not stale',
    (file) => {
      const entry = scanned.find((candidate) => candidate.file === file);
      expect(entry, `${file} is exempt but no longer exists`).toBeDefined();
      expect(
        moduleMockOffsets(blankNonCode(entry?.source ?? '')).length,
        `${file} no longer calls mock.module, so its exemption should go — an `
        + 'exemption nobody uses is an exemption nobody re-reads.',
      ).toBeGreaterThan(0);
    },
  );
});

describe('the guards on the guard', () => {
  const mocked = "mock.module('node:zlib', () => fake);";
  const restored = `afterEach(() => { mock.module('node:zlib', () => REAL); });`;

  test('an installed mock with no teardown is an offender', () => {
    expect(installsWithoutRestoring(mocked)).toBe(true);
  });

  test('an installed mock restored in afterEach is not', () => {
    expect(installsWithoutRestoring(`${mocked}\n${restored}`)).toBe(false);
  });

  test('a teardown that only calls mock.restore() does not count', () => {
    // The exact shape that shipped: a teardown that looks like a restore and
    // is not one, because `mock.restore()` does not undo `mock.module()`.
    expect(
      installsWithoutRestoring(`${mocked}\nafterEach(() => { mock.restore(); });`),
    ).toBe(true);
  });

  test('afterAll counts as well as afterEach', () => {
    expect(
      installsWithoutRestoring(`${mocked}\nafterAll(() => { mock.module('node:zlib', () => REAL); });`),
    ).toBe(false);
  });

  test('a file that mocks nothing is not an offender', () => {
    expect(installsWithoutRestoring('const x = 1;')).toBe(false);
  });

  test('a mock named only in prose or a string is not an installation', () => {
    // Three files in this tree discuss `mock.module(...)` without calling it,
    // including the two optional-peer guards and this one.
    expect(installsWithoutRestoring("// mock.module('node:zlib', …) is permanent")).toBe(false);
    expect(installsWithoutRestoring("const note = \"mock.module('node:zlib', f)\";")).toBe(false);
  });

  test('the paren matcher spans a teardown containing nested calls', () => {
    // A naive "next `)`" would end the span at the first inner call and read a
    // restore that follows it as being outside the teardown.
    const source = [
      mocked,
      'afterEach(() => {',
      '  resetCompressionCache();',
      '  setOverride(null);',
      "  mock.module('node:zlib', () => REAL);",
      '});',
    ].join('\n');
    expect(installsWithoutRestoring(source)).toBe(false);
  });
});
