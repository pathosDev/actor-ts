import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **No module under `src/` reaches an internal seam except the one that
 * declares it (#1630).**
 *
 * An internal seam is a `set…` / `reset…` / `force…` / `_reset…` export that
 * exists for tests and that no barrel publishes — the `node:zlib` kill switch
 * `setNativeZstdDecompressCandidatesOverride` (#580) is the one with teeth.
 * `tests/unit/ExportSurface.test.ts` proves no door hands one out as a
 * *binding*, under any name and through any depth of `export * as`. It cannot
 * see one handed out as an *effect*, and both shapes were measured to pass it:
 *
 *   - a **function wrapper** —
 *     `export function forceZstdCandidates(c) { setNativeZstdDecompressCandidatesOverride(c) }`;
 *   - an **object wrapper** — `import * as compression from …Compression.js`
 *     and `export const compressionInternals = { ...compression }`, which
 *     copies the identical function objects onto a plain object the namespace
 *     walk steps over by design.
 *
 * Catching either by what a door *publishes* needs a call graph. This takes
 * the narrower rule the issue offered instead: every wrapper starts as a
 * mention outside the seam's own module, so a mention is what is refused.
 * Two kinds of mention:
 *
 *   1. **The seam's name** as code — an import specifier, a call, a property
 *      key, a string used as an index. Comments are blanked first, so prose
 *      that names a seam (several doc comments do) is not a mention. Strings
 *      are kept: `namespace['setRuntimeOverride']` is a wrapper too.
 *   2. **The whole module as a namespace** — `import * as`, `export * from`
 *      or a dynamic `import()` of a module that declares a seam. Those hand the
 *      seam over without ever spelling its name, which is the object-wrapper
 *      shape. A named import of the module's other exports stays fine:
 *      `Detect.ts` has dozens of honest importers of `detectRuntime`.
 *
 * Tests are not scanned; calling a seam is what tests are for. A legitimate
 * internal caller goes into {@link ALLOWED_MENTIONS} with its reason, the
 * way `SECURITY.md` lists an audit suppression — an empty list says
 * something, and so does an entry.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'src');

/**
 * `"<file relative to src/>#<seam or module>"` → why that mention is allowed.
 * Empty: no module outside a seam's own reaches one today.
 */
const ALLOWED_MENTIONS: Readonly<Record<string, string>> = {};

/** The seam naming convention `ExportSurface.test.ts` discovers seams by. */
const SEAM_DECLARATION =
  /\bexport\s+(?:async\s+)?(?:function|const|let|var)\s+((?:set|reset|force|_reset)[A-Za-z0-9_]*)/g;

/** `import * as x from '…'`, `export * from '…'`, `export * as x from '…'`. */
const NAMESPACE_IMPORT =
  /\b(?:import\s*\*\s*as\s+[A-Za-z_$][\w$]*\s+from|export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s+)?from)\s*(['"])([^'"\n]+)\1/g;

/** A dynamic `import('…')` with a literal specifier. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g;

/**
 * `source` with every comment replaced by spaces, strings left alone.
 *
 * Strings have to be walked anyway, so a `//` inside `'https://…'` is not
 * read as a comment. A `'` or `"` literal ends at a newline, as in
 * `NoSyncWorkInHandlers.test.ts`: a quote inside a regex literal is never a
 * string opener, and bounding it at the line keeps the damage to that line.
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
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index] === '\n' && quote !== '`') break;
        index++;
      }
      index++;
      continue;
    }
    index++;
  }
  return out.join('');
}

type SourceFile = { readonly relative: string; readonly code: string };

/** A seam: the module declaring it (relative to `src/`) and its name. */
type Seam = { readonly module: string; readonly name: string };

const sourceFilesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFilesUnder(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });

const toPosix = (path: string): string => path.split('\\').join('/');

function seamsDeclaredIn(file: SourceFile): Seam[] {
  return [...file.code.matchAll(SEAM_DECLARATION)].map((match) => ({ module: file.relative, name: match[1]! }));
}

/** A relative specifier resolved against the importing file, `.js` read as `.ts`. */
function resolveSpecifier(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return posix.normalize(posix.join(posix.dirname(importer), specifier)).replace(/\.js$/, '.ts');
}

/**
 * Every mention of a seam in `file` outside the seam's own module, as
 * `"<file>#<seam name>"` or `"<file>#<module> (as a namespace)"`.
 */
function seamMentionsIn(file: SourceFile, seams: readonly Seam[]): string[] {
  const found = new Set<string>();
  for (const seam of seams) {
    if (seam.module === file.relative) continue;
    if (new RegExp(`(?<![\\w$])${seam.name}(?![\\w$])`).test(file.code)) {
      found.add(`${file.relative}#${seam.name}`);
    }
  }
  const seamModules = new Set(seams.map((seam) => seam.module));
  for (const pattern of [NAMESPACE_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of file.code.matchAll(pattern)) {
      const target = resolveSpecifier(file.relative, match[2]!);
      if (target !== undefined && target !== file.relative && seamModules.has(target)) {
        found.add(`${file.relative}#${target} (as a namespace)`);
      }
    }
  }
  return [...found];
}

const files: SourceFile[] = sourceFilesUnder(SOURCE_ROOT).map((full) => ({
  relative: toPosix(relative(SOURCE_ROOT, full)),
  code: blankComments(readFileSync(full, 'utf8')),
}));
const seams = files.flatMap(seamsDeclaredIn);

describe('internal seams are mentioned only by their own module (#1630)', () => {
  test('the scan finds the seams it is about', () => {
    // A scan that found nothing would pass the test below in silence. Pinned
    // from below and by the one seam whose blast radius is the reason for
    // this file.
    expect(seams.length).toBeGreaterThanOrEqual(18);
    expect(seams).toContainEqual({
      module: 'persistence/object-storage/Compression.ts',
      name: 'setNativeZstdDecompressCandidatesOverride',
    });
  });

  test('no module outside a seam\'s own mentions it, except the allowed ones', () => {
    const mentions = files.flatMap((file) => seamMentionsIn(file, seams)).sort();
    expect(
      mentions.filter((mention) => !(mention in ALLOWED_MENTIONS)),
      'A module mentions an internal seam, or imports a seam\'s module as a namespace. That is '
      + 'how a wrapper that publishes the seam starts, and ExportSurface.test.ts cannot see a '
      + 'wrapper. Keep the call in the seam\'s own module, or add the mention to ALLOWED_MENTIONS '
      + 'with the reason it publishes nothing.',
    ).toEqual([]);
    // And the other direction: an allowance nothing uses any more goes.
    expect(Object.keys(ALLOWED_MENTIONS).filter((mention) => !mentions.includes(mention))).toEqual([]);
  });

  describe('the two wrapper shapes the issue measured are refused', () => {
    const killSwitch: Seam = {
      module: 'persistence/object-storage/Compression.ts',
      name: 'setNativeZstdDecompressCandidatesOverride',
    };
    const fixture = (relativePath: string, text: string): SourceFile => ({
      relative: relativePath,
      code: blankComments(text),
    });

    test('a function wrapper', () => {
      const wrapper = fixture('index.ts', [
        "import { setNativeZstdDecompressCandidatesOverride } from './persistence/object-storage/Compression.js';",
        'export function forceZstdCandidates(candidates: readonly string[]): void {',
        '  setNativeZstdDecompressCandidatesOverride(candidates);',
        '}',
      ].join('\n'));
      expect(seamMentionsIn(wrapper, [killSwitch])).toEqual(['index.ts#setNativeZstdDecompressCandidatesOverride']);
    });

    test('an object wrapper, which never spells the seam\'s name', () => {
      const wrapper = fixture('index.ts', [
        "import * as compression from './persistence/object-storage/Compression.js';",
        'export const compressionInternals = { ...compression };',
      ].join('\n'));
      expect(seamMentionsIn(wrapper, [killSwitch])).toEqual([
        'index.ts#persistence/object-storage/Compression.ts (as a namespace)',
      ]);
    });

    test('a namespace re-export and a dynamic import are namespaces too', () => {
      const reExport = fixture('persistence/index.ts', "export * from './object-storage/Compression.js';");
      expect(seamMentionsIn(reExport, [killSwitch])).toEqual([
        'persistence/index.ts#persistence/object-storage/Compression.ts (as a namespace)',
      ]);
      const dynamic = fixture('persistence/Lazy.ts', "const m = await import('./object-storage/Compression.js');");
      expect(seamMentionsIn(dynamic, [killSwitch])).toEqual([
        'persistence/Lazy.ts#persistence/object-storage/Compression.ts (as a namespace)',
      ]);
    });

    test('a string index is a mention, a comment is not, a named import of another export is not', () => {
      const indexed = fixture('index.ts', "const seam = internals['setNativeZstdDecompressCandidatesOverride'];");
      expect(seamMentionsIn(indexed, [killSwitch])).toHaveLength(1);

      const prose = fixture('index.ts', [
        '// setNativeZstdDecompressCandidatesOverride is internal',
        '/** See `setNativeZstdDecompressCandidatesOverride`. */',
        "const url = 'https://example.com'; // setNativeZstdDecompressCandidatesOverride",
        "import { compressorFor } from './persistence/object-storage/Compression.js';",
      ].join('\n'));
      expect(seamMentionsIn(prose, [killSwitch])).toEqual([]);

      const own = fixture(killSwitch.module, 'export function setNativeZstdDecompressCandidatesOverride() {}');
      expect(seamMentionsIn(own, [killSwitch])).toEqual([]);
    });
  });
});
