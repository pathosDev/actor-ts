import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { platformDependent } from '../../util/Platform.js';
import {
  REGISTRY_PATH,
  REPOSITORY_ROOT,
  registryEntries,
  toPosixPath,
  type RegistryEntry,
} from '../../util/Registry.js';

/**
 * The guard over `tests/quarantine.json` — the one list of divergences this
 * suite takes on purpose (#1410, #1411).
 *
 * A divergence is a suite CI does not run, or an assertion whose expected
 * value differs per platform.  Before this file the first kind lived in six
 * places that could not disagree loudly — three copy-pasted `describe.skip`
 * ternaries, a literal argv list in `nightly-flakes.yml`, a
 * `coveragePathIgnorePatterns` block in `bunfig.toml`, and a `--exclude=worker`
 * in `benchmarks.yml` that no grep for the env var could find — and the second
 * kind did not exist at all, so a platform divergence had to be asserted (red
 * on the other platform) or skipped (asserted nowhere).
 *
 * **The expiry is the point, and its failure is a feature.**  An entry past
 * its `expires` fails `bun test`, on somebody's unrelated push.  That is
 * deliberate: the arrangement this replaces wrote its exit criterion into a
 * YAML comment and asked a human to count nights against it, and the
 * quarantine it guarded became permanent by default rather than by decision —
 * `.github/workflows/nightly-flakes.yml` said so about itself.  A date that
 * fails is the cheapest forcing function that cannot be forgotten; the
 * nightly's report job warns on the issue a week ahead, so the failure is
 * never the first anyone hears of it.
 *
 * Sibling repo-file guards, same shape: `tests/unit/ci/WorkflowHygiene.test.ts`,
 * `tests/unit/ci/SleepRatchet.test.ts`, `tests/unit/ci/ExampleBindAddresses.test.ts`.
 */

/** At most this long between `since` and `expires` — six weeks and a day. */
const MAXIMUM_HORIZON_DAYS = 45;

/** After this many renewals the choice is to fix the subject or delete the test. */
const MAXIMUM_RENEWALS = 3;

/**
 * Files that read `process.platform` for something other than an assertion,
 * with the reason each is entitled to.
 *
 * The ban exists because a hand-rolled platform branch around an `expect` is
 * exactly the skip {@link platformDependent} replaces.  Choosing a symlink
 * type or a signal name is not that: the test asserts the same thing either
 * way, and only the mechanics of getting there differ.
 */
const PLATFORM_READ_ALLOW_LIST: ReadonlyMap<string, string> = new Map([
  ['tests/util/Platform.ts', 'the helper itself'],
  [
    'tests/examples/run-examples.mjs',
    'picks the spawn shape for a runnable example, not an expectation',
  ],
  [
    'tests/integration/in-process/persistence/object-storage/FilesystemObjectStorageBackend.test.ts',
    'symlink() needs "junction" on Windows and "dir" elsewhere to create the same link',
  ],
  [
    'tests/smoke/cases/28-graceful-shutdown-signals.mjs',
    'chooses the signal a platform can actually deliver; the assertion is identical',
  ],
]);

const TESTS_DIRECTORY = join(REPOSITORY_ROOT, 'tests');

/** Every source this repository wrote under `tests/`. */
function testSources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      testSources(full, found);
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) found.push(full);
  }
  return found;
}

/**
 * `source` with every comment replaced by spaces, character for character so
 * line numbers still line up.  String literals are tracked but **kept**: a
 * label is itself a string, and the only reason to know where strings are is
 * so the `//` in a URL is not mistaken for the start of a comment.
 */
function blankComments(source: string): string {
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
      index++;
      while (index < source.length) {
        if (source[index] === BACKSLASH) { index += 2; continue; }
        if (source[index] === quote) break;
        index++;
      }
      index++;
      continue;
    }
    index++;
  }
  return out.join('');
}

/**
 * {@link blankComments}, and then the strings too — for a scan that is about
 * code alone.
 *
 * **Quote state is reset at every newline, and that is not a shortcut.**  A
 * scanner this simple cannot tell a quote inside a *regular-expression
 * literal* from the start of a string, and this file is full of both.  Left
 * unbounded, one such quote swallows the rest of the file and the scan silently
 * stops covering it — which is exactly how the first version of this guard
 * reported its own fixture as an offender.  A JavaScript string cannot span a
 * newline unescaped, so resetting per line costs nothing on real strings and
 * bounds the damage from a regex literal to the line it sits on.  A multi-line
 * template literal is the one case that loses: its later lines are read as
 * code.  For this scan that is the safe direction — it can only ever produce a
 * false *offender*, never a missed one.
 */
function blankCommentsAndStrings(source: string): string {
  return blankComments(source)
    .split('\n')
    .map((line) => {
      const out = line.split('');
      let index = 0;
      while (index < line.length) {
        const character = line[index];
        if (character === "'" || character === '"' || character === '`') {
          const quote = character;
          out[index] = ' ';
          index++;
          while (index < line.length) {
            if (line[index] === BACKSLASH) {
              out[index] = ' ';
              out[index + 1] = ' ';
              index += 2;
              continue;
            }
            const closing = line[index] === quote;
            out[index] = ' ';
            index++;
            if (closing) break;
          }
          continue;
        }
        index++;
      }
      return out.join('');
    })
    .join('\n');
}

/** A single backslash, spelled so no shell heredoc or editor can eat it. */
const BACKSLASH = String.fromCharCode(92);

/**
 * `platformDependent(import.meta, '<label>'` — the call this guard pairs with
 * an entry.
 *
 * The quote characters are written `\x27` / `\x22` rather than literally, and
 * that is load-bearing: {@link blankCommentsAndStrings} scans this very file,
 * and a bare `'` inside a regex literal reads to it as the start of a string.
 * Spelling them as escapes keeps the guard's own source free of quotes that
 * are not string delimiters.  Do not "tidy" them back.
 */
const PLATFORM_DEPENDENT_CALL =
  /platformDependent\(\s*import\.meta\s*,\s*([\x27\x22])([^\x27\x22]*)\1/g;

/** A read of the running platform, in either of the two spellings the tree uses. */
const PLATFORM_READ = /\bprocess\.platform\b|\bglobalThis\.process\.platform\b/g;

type PlatformUse = { readonly file: string; readonly label: string };

const sources = testSources(TESTS_DIRECTORY);

const sourceText: ReadonlyMap<string, string> = new Map(
  sources.map((file) => [toPosixPath(file).slice(toPosixPath(REPOSITORY_ROOT).length + 1),
    readFileSync(file, 'utf8')]),
);

function platformDependentUses(): PlatformUse[] {
  const uses: PlatformUse[] = [];
  for (const [file, source] of sourceText) {
    // The guard's own fixtures below call the helper with a literal label; a
    // scan that counted them would demand registry entries for strings that
    // exist to prove the helper refuses them.
    if (file === 'tests/unit/ci/QuarantineRegistry.test.ts') continue;
    PLATFORM_DEPENDENT_CALL.lastIndex = 0;
    for (const match of blankComments(source).matchAll(PLATFORM_DEPENDENT_CALL)) {
      uses.push({ file, label: match[2] ?? '' });
    }
  }
  return uses;
}

function platformReadsOutsideTheAllowList(): string[] {
  const offenders: string[] = [];
  for (const [file, source] of sourceText) {
    if (PLATFORM_READ_ALLOW_LIST.has(file)) continue;
    PLATFORM_READ.lastIndex = 0;
    const code = blankCommentsAndStrings(source);
    for (const match of code.matchAll(PLATFORM_READ)) {
      offenders.push(`${file}:${code.slice(0, match.index).split('\n').length}`);
    }
  }
  return offenders;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/** Today, as the registry spells a date.  Compared as text: ISO dates sort. */
const today = new Date().toISOString().slice(0, 10);

const entries = registryEntries();
const platformEntries = entries.filter((entry) => entry.kind === 'platform-expectation');

function describeEntry(entry: RegistryEntry): string {
  return `${entry.kind} ${entry.file}${entry.label === undefined ? '' : ` / "${entry.label}"`}`;
}

describe('the quarantine registry', () => {
  test('the registry parsed and the scanner reads the tree it claims to', () => {
    // A guard that quietly stopped reading would satisfy every assertion below
    // by finding nothing at all.
    expect(sources.length).toBeGreaterThan(400);
    expect(entries.length).toBeGreaterThan(0);
    expect(platformDependentUses().length).toBeGreaterThan(0);
  });

  test.each(entries.map((entry) => [describeEntry(entry), entry] as const))(
    '%s names an owner, a reason and a bounded expiry',
    (_label, entry) => {
      expect(entry.issue).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(/^\d{4}-\d{2}-\d{2}$/.test(entry.since)).toBe(true);
      expect(/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)).toBe(true);
      const start = entry.history.at(-1)?.date ?? entry.since;
      expect(daysBetween(start, entry.expires)).toBeGreaterThan(0);
      expect(daysBetween(start, entry.expires)).toBeLessThanOrEqual(MAXIMUM_HORIZON_DAYS);
      expect(entry.history.length).toBeLessThanOrEqual(MAXIMUM_RENEWALS);
    },
  );

  test.each(entries.map((entry) => [describeEntry(entry), entry] as const))(
    '%s has not expired',
    (_label, entry) => {
      expect(
        entry.expires >= today,
        `${describeEntry(entry)} expired on ${entry.expires}.\n` +
        `Fix #${entry.issue} and delete the entry, or renew it in ${REGISTRY_PATH} by pushing\n` +
        `  { "date": "${today}", "reason": "<why it still stands, with what was measured>" }\n` +
        `onto "history" and moving "expires" — at most ${MAXIMUM_RENEWALS} times, and this entry has ` +
        `used ${entry.history.length}.\n` +
        'Raising the limit is not one of the ways out.',
      ).toBe(true);
    },
  );

  test('every platform expectation is used, and every use has an entry', () => {
    const uses = platformDependentUses();
    const usedKeys = new Set(uses.map((use) => `${use.file} / ${use.label}`));
    const entryKeys = new Set(platformEntries.map((entry) => `${entry.file} / ${entry.label}`));

    expect(
      [...usedKeys].filter((key) => !entryKeys.has(key)),
      'a platformDependent(...) call with no registry entry — it would throw at run time',
    ).toEqual([]);
    expect(
      [...entryKeys].filter((key) => !usedKeys.has(key)),
      'a registry entry nothing uses — the divergence is gone, so the entry should be too',
    ).toEqual([]);
  });

  test('no test asserts on the platform by hand', () => {
    expect(
      platformReadsOutsideTheAllowList(),
      'read the platform through platformDependent(import.meta, label, { win32, default }) so the ' +
      'divergence carries an owner and an expiry, or add the file to PLATFORM_READ_ALLOW_LIST with ' +
      'the reason it is not an expectation.',
    ).toEqual([]);
  });
});

describe('the guards on the guard', () => {
  test('platformDependent refuses a call the registry does not know', () => {
    expect(() =>
      platformDependent(import.meta, 'a label no entry carries', { win32: 1, default: 2 }),
    ).toThrow(/no registry entry for tests\/unit\/ci\/QuarantineRegistry\.test\.ts/);
  });

  test('the platform scanner discriminates a read from a mention of one', () => {
    const mention = [
      '// Deliberately NOT gated on `process.platform`: registering it is enough.',
      '/** Windows spells it process.platform === "win32". */',
      "const label = 'process.platform';",
    ].join('\n');
    expect(blankCommentsAndStrings(mention)).not.toMatch(PLATFORM_READ);

    const read = "const onWindows = process.platform === 'win32';";
    expect(blankCommentsAndStrings(read)).toMatch(PLATFORM_READ);
  });

  test('the call scanner reads the label and ignores a commented-out call', () => {
    const source = [
      "// platformDependent(import.meta, 'commented out', { win32: 1, default: 2 })",
      "const expected = platformDependent(import.meta, 'a real one', { win32: 1, default: 2 });",
    ].join('\n');
    PLATFORM_DEPENDENT_CALL.lastIndex = 0;
    expect([...blankComments(source).matchAll(PLATFORM_DEPENDENT_CALL)].map((m) => m[2]))
      .toEqual(['a real one']);
  });

  test('the horizon and renewal bounds are the ones the failure message quotes', () => {
    // Both numbers appear in prose above and in the message a failing entry
    // prints; pinning them here is what keeps the three copies one number.
    expect(MAXIMUM_HORIZON_DAYS).toBe(45);
    expect(MAXIMUM_RENEWALS).toBe(3);
  });
});
