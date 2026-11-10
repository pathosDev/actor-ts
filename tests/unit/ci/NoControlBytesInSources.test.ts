import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **No literal C0 control byte in a source file (#1508).**
 *
 * `tests/integration/in-process/persistence/TagJoinQuery.ts` carried a raw
 * U+0000 inside a template literal — written as a byte rather than as an
 * escape — and git therefore reported it as `Binary files … differ`. The
 * commit that last touched it advertised a comment change there that nobody
 * could see: not in `git show`, not on GitHub, not in review. The change
 * turned out to be accurate, which is the point. Nothing about the review
 * *established* that, and nothing would have established the opposite either.
 *
 * Two source files already document exactly this hazard as a reason to write
 * a codepoint scan rather than a character class — `PersistenceIdValidator`
 * ("making this source file read as binary to git") and `ActorPath` — so the
 * reasoning was in the tree and applied only to `src/`. This guard is that
 * reasoning made repository-wide, because a test fake whose diff is invisible
 * is a worse place for it than a validator, not a better one.
 *
 * **What is forbidden, and what is not.** A byte below 0x20 that is not TAB,
 * LF or CR, and DEL (0x7F). CR is allowed because Windows checkouts have it
 * on every line (`core.autocrlf=true`) and it is a line ending, not smuggled
 * data. Everything else in that range is either invisible in a diff or
 * changes how a terminal renders one.
 *
 * **Escapes are the fix, not the offence.** This reads *bytes*, so the six
 * ASCII characters of a backslash-u escape are exactly what it wants to see,
 * and a file spelled that way passes. That distinction is not academic: the
 * first run of this guard failed on *this file*, because the editor writing
 * it decoded the escapes in these very paragraphs back into bytes. Hence
 * `U+0000` notation in the prose here — and hence the guard, which caught it.
 *
 * **It is a scanner, not a proof.** A control byte reaching a file through a
 * generated artefact, a `String.fromCharCode` call or a `.json` payload is
 * not caught here and is not meant to be: the class this closes is a byte
 * typed into a source file by hand, which is how the one in the tree got
 * there.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

/**
 * The trees this repository writes by hand.
 *
 * Named rather than walked from the root, for two reasons that are both real
 * here: `.claude/worktrees/` holds entire checkouts of this repository, and
 * `dist/` holds `.d.ts` files a compiler wrote. Neither is a source file
 * anyone types a byte into.
 */
const SCANNED_ROOTS: readonly string[] = [
  'src', 'tests', 'scripts', 'benchmarks', 'examples',
  join('docs', 'src'), join('devtools-ui', 'src'), join('devtools-ui', 'tests'),
];

/** Extensions whose diffs a reviewer is expected to read. */
const SCANNED_EXTENSIONS: readonly string[] = ['.ts', '.mjs', '.mdx'];

/**
 * Directories skipped inside a scanned root.
 *
 * `node_modules` is the one that matters and is the same lesson
 * `SleepRatchet` learned: `tests/integration/brokers/README.md` tells a
 * developer to install a vendor tree *inside* the scan root, and a guard that
 * then reports a minified dependency is a gate that goes red for following
 * the instructions.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', 'dist', '.astro']);

/**
 * `src/devtools/generated/UiAssets.ts` is deliberately **not** skipped.
 *
 * It is a committed bundle, so the usual argument for exempting generated
 * output applies — and the opposite argument is stronger here. `AGENTS.md`
 * records that review is the only thing that ever looks at that payload, and
 * `.gitattributes` gives the file a textual `diff` for exactly that reason. A
 * NUL in the bundle would take the last check on it away, silently. It has
 * none today; if a future bundler emits one, this going red is the correct
 * outcome rather than an inconvenience.
 */

/**
 * Files that already carry a control byte, with the count measured on
 * 2026-09-22 at develop `8c609853`.
 *
 * A ratchet, in the shape `WallClockRatchet` and `SleepRatchet` use: a listed
 * file may carry **fewer** than its recorded count, never more, and an
 * unlisted file may carry none at all. Lowering an entry to zero and deleting
 * it is the end state.
 *
 * The one entry is a raw U+0007 (BEL) inside a tag string, in a case
 * asserting that the write-side validator rejects control characters —
 * written with the character instead of the escape. It is the same class as
 * the NUL this guard was written for and a strictly milder case: BEL does not
 * trip git's binary heuristic, so that file's diffs are readable today. It is
 * grandfathered rather than fixed here because it belongs to another lane's
 * file, and escaping it is a one-token change that alters no runtime string.
 */
const KNOWN_CONTROL_BYTES: Readonly<Record<string, number>> = {
  'tests/integration/in-process/persistence/TagValidator.test.ts': 1,
};

/** A control byte found in a file, located well enough to go fix it. */
type ControlByteHit = {
  readonly file: string;
  readonly byte: number;
  readonly offset: number;
  readonly line: number;
};

function sourceFiles(directory: string, found: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // A root that is not checked out (the docs or UI trees in a partial
    // clone) is absent, not empty — but the floor assertion below is what
    // turns "absent" into a failure, rather than a throw from here.
    return found;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

/** True for a byte that must not appear literally in a source file. */
function isForbiddenByte(byte: number): boolean {
  if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return false;
  return byte <= 0x1f || byte === 0x7f;
}

function controlByteHits(file: string, bytes: Uint8Array): ControlByteHit[] {
  const hits: ControlByteHit[] = [];
  let line = 1;
  for (let offset = 0; offset < bytes.length; offset++) {
    const byte = bytes[offset]!;
    if (byte === 0x0a) { line++; continue; }
    if (isForbiddenByte(byte)) hits.push({ file, byte, offset, line });
  }
  return hits;
}

const scannedFiles = SCANNED_ROOTS
  .flatMap((root) => sourceFiles(join(REPOSITORY_ROOT, root)))
  .map((path) => relative(REPOSITORY_ROOT, path).replaceAll('\\', '/'))
  .sort();

const hits = scannedFiles.flatMap((file) =>
  controlByteHits(file, readFileSync(join(REPOSITORY_ROOT, file))));

const hitsByFile = new Map<string, ControlByteHit[]>();
for (const hit of hits) {
  const forFile = hitsByFile.get(hit.file) ?? [];
  forFile.push(hit);
  hitsByFile.set(hit.file, forFile);
}

const describeHit = (hit: ControlByteHit): string =>
  `${hit.file}:${hit.line} carries 0x${hit.byte.toString(16).padStart(2, '0')} `
  + `at byte offset ${hit.offset}`;

describe('no source file carries a literal control byte (#1508)', () => {
  test('the scanner reads the tree it claims to', () => {
    // Every assertion below is satisfied by finding nothing, so the first
    // thing to establish is that something was read at all. The floor is far
    // under the ~2 400 files present, because the number that matters is
    // "not a handful".
    expect(scannedFiles.length).toBeGreaterThan(1_000);
    for (const extension of SCANNED_EXTENSIONS) {
      expect(scannedFiles.some((file) => file.endsWith(extension))).toBe(true);
    }
    // And that it reaches the trees that are easiest to lose: the test tree
    // is where the NUL was, and the docs tree is the one rooted two levels
    // down.
    expect(scannedFiles.some((file) => file.startsWith('tests/'))).toBe(true);
    expect(scannedFiles.some((file) => file.startsWith('docs/src/'))).toBe(true);
    expect(scannedFiles.some((file) => file.startsWith('src/'))).toBe(true);
  });

  test('no unlisted file carries one', () => {
    const unlisted = hits.filter((hit) => KNOWN_CONTROL_BYTES[hit.file] === undefined);
    expect(
      unlisted.map(describeHit),
      'A literal C0 control byte in a source file makes its diff unreadable — '
      + 'git reports the whole file as binary once it finds a NUL. Write it as '
      + 'a backslash-u escape instead: the runtime string is identical and the '
      + 'file stays reviewable.',
    ).toEqual([]);
  });

  test('a listed file carries no more than its recorded count', () => {
    for (const [file, allowed] of Object.entries(KNOWN_CONTROL_BYTES)) {
      const found = hitsByFile.get(file) ?? [];
      expect(
        found.length,
        `${file} is allowed ${allowed} literal control byte(s) and has `
        + `${found.length}: ${found.map(describeHit).join(', ')}`,
      ).toBeLessThanOrEqual(allowed);
    }
  });

  test('the allow-list names only files that exist', () => {
    // A stale entry is how an allow-list turns into a list of files nobody
    // has checked. Renaming a listed file must move its entry, not orphan it.
    for (const file of Object.keys(KNOWN_CONTROL_BYTES)) {
      expect(scannedFiles, `${file} is allow-listed but the scanner never saw it`)
        .toContain(file);
    }
  });

  test('the file the guard was written for is clean', () => {
    // Named rather than left to the sweep above: the sweep passes by finding
    // nothing anywhere, which is also what it does when the roots are wrong.
    expect(hitsByFile.get('tests/integration/in-process/persistence/TagJoinQuery.ts'))
      .toBeUndefined();
  });
});
