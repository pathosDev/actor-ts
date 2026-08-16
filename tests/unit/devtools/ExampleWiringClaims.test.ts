import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * The DevTools chapter's claims about `examples/` have to survive the tree
 * changing under them.
 *
 * #552 removed the harness from the examples that called `holdOpen()`, and
 * the pages described the result as "the long-running examples are wired /
 * the ones that finish on their own carry none".  That is not the line that
 * was applied: seven of the examples that kept the wiring finish on their
 * own in a second or two.  The consequence was concrete rather than
 * pedantic — the actor-visualizer walkthrough's only code fence told the
 * reader to run `examples/cluster/singleton-hello.ts --devtools` and watch
 * the tree, and that process is gone before a browser can open.
 *
 * Prose cannot be typechecked, so the two assertions below anchor it to
 * things that can be:
 *
 *   - `examples/**` — an example is wired exactly when it references
 *     `attachDevTools`, which is the whole of the harness's public surface.
 *   - `tests/examples/examples.manifest.json` — the project's existing
 *     classification of which snippets exit on their own (`mode` absent or
 *     `"exit"`) and which run until stopped (`"serve"`).  It is maintained
 *     by hand and enforced by `tests/examples/run-examples.mjs`, which runs
 *     every case as a real program, so it is a checked fact rather than a
 *     second unverified claim.
 *
 * Static on purpose: spawning twenty-five examples belongs in the example
 * gate, not in `bun test`.  What this guards is the *documentation*, which
 * no other gate reads at all.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const EXAMPLES_ROOT = join(REPOSITORY_ROOT, 'examples');
const MANIFEST = join(REPOSITORY_ROOT, 'tests', 'examples', 'examples.manifest.json');

/** The harness itself — it references `attachDevTools` by defining it. */
const HARNESS = 'examples/devtools.ts';

/** The DevTools chapter, English and its 1:1 German mirror. */
const DOCUMENTATION_PAGES: readonly string[] = [
  'docs/src/content/docs/observability/devtools',
  'docs/src/content/docs/de/observability/devtools',
];

/** The two pages that describe which examples carry the wiring. */
const WIRING_PAGES: readonly string[] = [
  'docs/src/content/docs/observability/devtools/overview.mdx',
  'docs/src/content/docs/de/observability/devtools/overview.mdx',
];

type ManifestCase = {
  readonly file: string;
  readonly mode?: string;
  readonly skip?: string;
};

function readUtf8(relativePath: string): string {
  return readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');
}

/** Every `.ts` snippet under `examples/`, as repository-relative POSIX paths. */
function exampleFiles(directory: string = EXAMPLES_ROOT, prefix = 'examples'): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      found.push(...exampleFiles(join(directory, entry.name), relativePath));
    } else if (entry.name.endsWith('.ts')) {
      found.push(relativePath);
    }
  }
  return found;
}

const manifestCases: readonly ManifestCase[] =
  (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { cases: ManifestCase[] }).cases;

/**
 * Examples the manifest has watched finish on their own.  A skipped case is
 * not in here: CI never ran it, so the manifest is not asserting anything
 * about how it ends.
 */
const selfTerminating: ReadonlySet<string> = new Set(
  manifestCases
    .filter((entry) => entry.skip === undefined && (entry.mode ?? 'exit') === 'exit')
    .map((entry) => entry.file),
);

/** Examples that import the shared harness. */
const wired: readonly string[] = exampleFiles()
  .filter((file) => file !== HARNESS)
  .filter((file) => readUtf8(file).includes('attachDevTools'));

/** The seven the documentation used to deny the existence of. */
const wiredButSelfTerminating: readonly string[] = wired.filter((file) => selfTerminating.has(file));

/**
 * Every `bun run examples/…` in the DevTools chapter.  Every one of them is
 * a DevTools invocation — the chapter names an example for no other reason —
 * and two of them straddle a line break (``…main.ts`` / ``--devtools``), so
 * the match deliberately does not require the flag to be adjacent.
 */
function documentedInvocations(): { page: string; file: string }[] {
  const found: { page: string; file: string }[] = [];
  for (const directory of DOCUMENTATION_PAGES) {
    for (const name of readdirSync(join(REPOSITORY_ROOT, directory))) {
      const page = `${directory}/${name}`;
      const pattern = /bun (?:run )?(examples\/[\w./-]+\.ts)/g;
      for (const match of readUtf8(page).matchAll(pattern)) {
        found.push({ page, file: match[1]! });
      }
    }
  }
  return found;
}

const invocations = documentedInvocations();

describe('the DevTools chapter describes the examples that exist', () => {
  test('the inputs are non-empty', () => {
    // Guards the guard: a broken path or glob would make every assertion
    // below pass by having nothing to say.
    expect(wired.length, 'no example references attachDevTools').toBeGreaterThan(0);
    expect(selfTerminating.size, 'the manifest classified nothing as exiting').toBeGreaterThan(0);
    expect(invocations.length, 'the chapter runs no example').toBeGreaterThan(0);
  });

  test('no page tells the reader to watch an example that exits first', () => {
    const unwatchable = invocations.filter(({ file }) => selfTerminating.has(file));
    expect(
      unwatchable.map(({ page, file }) => `${page} -> ${file}`),
      'These pages open a browser at an example the example gate has watched '
      + 'run to completion on its own.  DevTools attaches and the process is '
      + 'gone seconds later, so the reader finds nothing (#552).  Name a '
      + 'manifest "serve" example instead.',
    ).toEqual([]);
  });

  test('the overview names every wired example that finishes on its own', () => {
    for (const page of WIRING_PAGES) {
      const text = readUtf8(page);
      const unmentioned = wiredButSelfTerminating.filter(
        (file) => !text.includes(file.slice('examples/'.length)),
      );
      expect(
        unmentioned,
        `${page} describes which examples carry the DevTools wiring without `
        + 'mentioning these, which carry it and still finish on their own.  '
        + 'That is the false dividing line #552 documented: a reader who runs '
        + 'one of these with --devtools gets nothing to look at.',
      ).toEqual([]);
    }
  });
});
