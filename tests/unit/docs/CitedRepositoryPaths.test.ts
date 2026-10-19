import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **Every repository file a documentation page names in a code span exists,
 * spelled exactly as the page spells it** (found while #1425).
 *
 * The reference.conf page said it reproduces `src/config/reference.ts`, in
 * both languages, long after the file had become `Reference.ts`; the
 * flake-diagnosis page went on describing a quarantine test that the commit
 * ending the quarantine deleted.  Nothing read either path.  `existsSync`
 * would not have caught the first on Windows or macOS, whose default
 * filesystems fold case, so each segment is looked up in its directory's
 * listing instead — the spelling a Linux checkout, and a reader's editor,
 * would have to find.
 *
 * A cited path is a code span holding a path under one of the repository's
 * top-level directories, ending in a file extension.  Fences are skipped —
 * a sample's paths belong to the reader's project, not to this repository —
 * and so are MDX comments, which render nothing.  An illustrative path that
 * is not in the tree therefore goes in a fence.
 *
 * What this cannot see: a path written outside a code span, a link URL, a
 * directory, and a path that exists but names the wrong file.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const DOCUMENTATION_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');

const CITED_PATH =
  /`((?:src|tests|scripts|benchmarks|examples|docs|\.github)\/[A-Za-z0-9_./-]+\.(?:ts|mts|mjs|js|json|conf|mdx|md|yml|yaml))`/g;

type CitedPath = { readonly page: string; readonly line: number; readonly path: string };

function pagesUnder(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...pagesUnder(full));
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Each path a page cites outside fences and MDX comments, with its line. */
function citedPaths(page: string): CitedPath[] {
  const out: CitedPath[] = [];
  const name = relative(DOCUMENTATION_ROOT, page).split('\\').join('/');
  let inFence = false;
  let inComment = false;
  for (const [index, raw] of readFileSync(page, 'utf8').split(/\r?\n/).entries()) {
    if (!inComment && /^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // An MDX comment may span lines; what it holds is never rendered.
    let line = raw;
    if (inComment) {
      const close = line.indexOf('*/}');
      if (close === -1) continue;
      line = line.slice(close + 3);
      inComment = false;
    }
    line = line.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
    const open = line.indexOf('{/*');
    if (open !== -1) {
      line = line.slice(0, open);
      inComment = true;
    }
    for (const match of line.matchAll(CITED_PATH)) out.push({ page: name, line: index + 1, path: match[1]! });
  }
  return out;
}

const listings = new Map<string, readonly string[]>();

/** The names in `directory`, or none when it is not one. */
function namesIn(directory: string): readonly string[] {
  let names = listings.get(directory);
  if (names === undefined) {
    try {
      names = readdirSync(directory);
    } catch {
      names = [];
    }
    listings.set(directory, names);
  }
  return names;
}

/** True when every segment of `path` is in its parent's listing, spelled exactly so. */
function existsAsSpelled(path: string): boolean {
  let directory = REPOSITORY_ROOT;
  for (const segment of path.split('/')) {
    if (!namesIn(directory).includes(segment)) return false;
    directory = join(directory, segment);
  }
  return true;
}

const cited = pagesUnder(DOCUMENTATION_ROOT).flatMap(citedPaths);

describe('every repository path a documentation page cites exists as spelled (found while #1425)', () => {
  test('the scan still finds the paths the pages cite', () => {
    // Guards the guard: a pattern that matched nothing would pass below.
    expect(cited.length).toBeGreaterThan(50);
    expect(cited.map(({ path }) => path)).toContain('src/config/Reference.ts');
  });

  test('no cited path is missing from the tree, or spelled in another case', () => {
    const missing = cited
      .filter(({ path }) => !existsAsSpelled(path))
      .map(({ page, line, path }) => `${page}:${line} cites ${path}`);
    expect(
      missing,
      'cite the file under its current name, drop a sentence about a file that is gone, or move an illustrative '
      + 'path into a fence',
    ).toEqual([]);
  });

  test('a case-only difference is a missing path', () => {
    // The trap the lookup exists for: on a case-folding filesystem the
    // lowercase spelling opens the same file.
    expect(existsAsSpelled('src/config/Reference.ts')).toBe(true);
    expect(existsAsSpelled('src/config/reference.ts')).toBe(false);
  });
});
