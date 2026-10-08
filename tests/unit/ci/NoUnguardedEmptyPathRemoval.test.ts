import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **A test may not remove a path that can still be the empty string.**
 *
 * The shape this guards against is the ordinary scratch-directory test:
 *
 *     let directory = '';
 *     beforeEach(() => { directory = mkdtempSync(...); });
 *     afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
 *
 * It is harmless until the setup hook throws before it assigns. bun test runs
 * the teardown hook anyway, and on Bun 1.4.2 `rmSync('', { recursive: true,
 * force: true })` empties the current working directory — which, under
 * `bun test`, is the repository. Node refuses the empty path and deletes
 * nothing, so the difference only shows on the runtime the suite runs on.
 * `rmSync(join(ROOT, ''))` is the repository root on every runtime. The fix
 * is one comparison: remove the path only once it was assigned
 * (`if (directory !== '') rmSync(...)`), the shape
 * `tests/unit/http/HttpConfigDefaults.test.ts` already used.
 *
 * Found in October 2026, when a test written in exactly this shape emptied a
 * scratch directory in which it ran — test file included (#1546).
 *
 * The check is textual, like the other guards in this directory: a variable
 * declared as `let name = ''` that some `rmSync(` call removes — directly or as
 * the last argument of `join(...)` — must have that call guarded by a
 * comparison with `''` (or a truthiness check) on the same variable.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const TESTS_DIRECTORY = join(REPOSITORY_ROOT, 'tests');

function testSources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) testSources(full, found);
    else if (/\.(ts|mts|mjs|js)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const EMPTY_STRING_DECLARATION = /\blet\s+([A-Za-z_$][\w$]*)\s*(?::\s*string)?\s*=\s*(?:''|"")\s*;/g;

/** Every `rmSync(` line that removes `name` with no guard on the same line. */
export function unguardedRemovals(source: string, name: string): number[] {
  const removes = new RegExp(`rmSync\\(\\s*(?:join\\([^()]*?,\\s*)?${name}\\b`);
  const guarded = new RegExp(`(?:\\b${name}\\s*!==?\\s*(?:''|""))|(?:\\bif\\s*\\(\\s*${name}\\s*\\))|(?:\\b${name}\\s*&&)`);
  const offending: number[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    if (removes.test(line) && !guarded.test(line)) offending.push(index + 1);
  });
  return offending;
}

export function findUnguardedEmptyPathRemovals(source: string): Array<{ name: string; lines: number[] }> {
  const out: Array<{ name: string; lines: number[] }> = [];
  for (const match of source.matchAll(EMPTY_STRING_DECLARATION)) {
    const lines = unguardedRemovals(source, match[1]);
    if (lines.length > 0) out.push({ name: match[1], lines });
  }
  return out;
}

describe('a test never removes a path that can still be the empty string', () => {
  test('no test file removes an unassigned scratch path', () => {
    const offenders: string[] = [];
    for (const file of testSources(TESTS_DIRECTORY)) {
      // This file quotes the forbidden shape on purpose — in its JSDoc and as
      // the fixtures of the case below — and runs no rmSync itself.
      if (file === import.meta.path) continue;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('rmSync(')) continue;
      for (const { name, lines } of findUnguardedEmptyPathRemovals(source)) {
        offenders.push(`${relative(REPOSITORY_ROOT, file)}: rmSync on \`${name}\` (which starts as '') at line ${lines.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the check flags the unguarded shape and accepts the guarded ones', () => {
    const unguarded = "let directory = '';\nafterEach(() => {\n  rmSync(directory, { recursive: true, force: true });\n});";
    const joined = "let outName = '';\nafterAll(() => {\n  rmSync(join(ROOT, outName), { recursive: true, force: true });\n});";
    const guardedCompare = "let directory = '';\nafterEach(() => {\n  if (directory !== '') rmSync(directory, { recursive: true, force: true });\n});";
    const guardedTruthy = "let directory = '';\nafterEach(() => {\n  if (directory) rmSync(directory, { recursive: true, force: true });\n});";
    const neverEmpty = "const directory = mkdtempSync('x');\nafterEach(() => {\n  rmSync(directory, { recursive: true, force: true });\n});";

    expect(findUnguardedEmptyPathRemovals(unguarded)).toEqual([{ name: 'directory', lines: [3] }]);
    expect(findUnguardedEmptyPathRemovals(joined)).toEqual([{ name: 'outName', lines: [3] }]);
    expect(findUnguardedEmptyPathRemovals(guardedCompare)).toEqual([]);
    expect(findUnguardedEmptyPathRemovals(guardedTruthy)).toEqual([]);
    expect(findUnguardedEmptyPathRemovals(neverEmpty)).toEqual([]);
  });
});
