import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **Nothing in `src/` reaches `aesGcmEncrypt` or `randomIv` except
 * `Encryption.ts` itself (#1049).**
 *
 * #110 moved IV generation into `aesGcmEncryptSafe`, which draws a fresh IV
 * for every call, so a nonce can no longer be reused by accident. The two
 * lower-level functions it is built from stay exported, because
 * `tests/integration/in-process/persistence/object-storage/Encryption.test.ts`
 * pins a known IV to test the decrypt side, and their `@internal` tag is JSDoc
 * that nothing enforces. A second caller drawing one IV and encrypting twice
 * under it — AES-GCM's catastrophic failure — leaves `bun run typecheck` and
 * every object-storage suite green. This guard is what turns it red.
 *
 * **Any reference, not only a call.** The match is the bare identifier, so an
 * import, an `import { aesGcmEncrypt as encrypt }` rename and a function value
 * handed on all count; a guard looking for `aesGcmEncrypt(` would be walked
 * past by the rename. `\b` keeps `aesGcmEncryptSafe` out: the boundary needs
 * a non-word character after the name.
 *
 * **Comments count too**, deliberately: a guard that parsed comments out would
 * need a TypeScript lexer to stay honest about strings containing `//`, and a
 * prose mention of either name outside `Encryption.ts` is rare enough that
 * rewording it is cheaper than that lexer.
 *
 * **Widening the allow-list** is how a legitimate second caller gets in. It
 * takes the path and the reason, in the same commit as the caller.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'src');

/** Repo-relative, forward-slash paths that may reference the two functions. */
const ALLOWED_FILES: ReadonlyMap<string, string> = new Map([
  ['src/persistence/object-storage/Encryption.ts', 'defines both, and aesGcmEncryptSafe is built from them'],
]);

/** The two names, as identifiers — `aesGcmEncryptSafe` does not match. */
const FORBIDDEN_REFERENCE = /\b(aesGcmEncrypt|randomIv)\b/g;

type Finding = { readonly file: string; readonly line: number; readonly name: string };

/** Every reference in `text`, by line. */
function forbiddenReferencesIn(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    for (const match of lines[index]!.matchAll(FORBIDDEN_REFERENCE)) {
      findings.push({ file, line: index + 1, name: match[1]! });
    }
  }
  return findings;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

const repositoryPath = (path: string): string => relative(REPOSITORY_ROOT, path).split('\\').join('/');

describe('no direct caller of aesGcmEncrypt / randomIv in src/ (#1049)', () => {
  test('only the allow-listed files reference either function', () => {
    const findings = sourceFiles(SOURCE_ROOT)
      .map((path) => ({ path, file: repositoryPath(path) }))
      .filter(({ file }) => !ALLOWED_FILES.has(file))
      .flatMap(({ path, file }) => forbiddenReferencesIn(file, readFileSync(path, 'utf8')));
    expect(findings.map((finding) => `${finding.file}:${finding.line} ${finding.name}`)).toEqual([]);
  });

  test('every allow-listed file exists and still references them, so a stale entry is noticed', () => {
    for (const file of ALLOWED_FILES.keys()) {
      const text = readFileSync(join(REPOSITORY_ROOT, file), 'utf8');
      expect(forbiddenReferencesIn(file, text).length).toBeGreaterThan(0);
    }
  });

  test('the scan sees the nonce-reuse shape the issue reports, and a rename', () => {
    // The issue's own repro, as a planted source text: if the matcher stopped
    // seeing it, the first case above would pass over every file vacuously.
    const planted = [
      "import { aesGcmEncrypt as encrypt, randomIv } from './Encryption.js';",
      'const iv = randomIv();',
      'await aesGcmEncrypt(subkey, iv, first);',
    ].join('\n');
    expect(forbiddenReferencesIn('planted.ts', planted).map((finding) => `${finding.line} ${finding.name}`))
      .toEqual(['1 aesGcmEncrypt', '1 randomIv', '2 randomIv', '3 aesGcmEncrypt']);
  });

  test('the safe wrapper and look-alike names are not findings', () => {
    const benign = [
      'await aesGcmEncryptSafe(subkey, plaintext);',
      'const randomIvLength = 12;',
      'myRandomIv();',
    ].join('\n');
    expect(forbiddenReferencesIn('benign.ts', benign)).toEqual([]);
  });
});
