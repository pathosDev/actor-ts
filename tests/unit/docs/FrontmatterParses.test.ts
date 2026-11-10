import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **Every documentation page's frontmatter is parseable YAML.**
 *
 * This exists because four pages were not, and the documentation site could
 * not build at all (#1525).  Two `description` values contained a colon
 * followed by a space — `` `{ qps: Infinity }` `` on the throttling pages, and
 * `actor-ts/util subpath: mergeOptions, …` on the utilities pages — inside an
 * unquoted plain scalar, which is how YAML starts a nested mapping.  The
 * parser stopped there and `astro build` died during content sync, before
 * rendering a single page.
 *
 * ## Why a test rather than a build
 *
 * The build would catch it, and the build is the one thing that never runs
 * here.  `docs.yml` is the only workflow that invokes `astro build` and it
 * fires **on pushes to `main`**, which happen only at release time;
 * `docs-checks.yml` runs on every branch but does an API-drift scan and a
 * frozen install, never a build.  So both offending commits sat on `develop`
 * for days — one for over a week — and the first thing that would have noticed
 * is the release deploy, next to the npm publish.
 *
 * Parsing 500 frontmatter blocks costs milliseconds and needs no install, so
 * it belongs in `bun test` where every branch runs it, rather than in a
 * docs-only workflow that would still only catch it after the fact.
 *
 * ## Why `Bun.YAML` rather than a hand-rolled check
 *
 * The tempting shortcut is a regex for "unquoted value containing a colon and
 * a space", and it would have caught these four.  It would also be a second,
 * worse YAML implementation: block scalars, flow mappings, anchors and
 * multi-line values all have to be excluded by hand, and every exclusion is a
 * place the guard silently stops covering something.  `Bun.YAML.parse` is the
 * same question the build asks, so the guard cannot disagree with it about
 * what is valid.
 *
 * The suite runs on Bun by definition (`bun:test`), so reaching for a Bun
 * global here costs no portability — unlike `src/`, where the runtime
 * abstractions in `src/runtime/` exist precisely to avoid that.
 */

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/**
 * TypeDoc writes `api/` into the docs tree during the build and it is not
 * committed, so it is present locally after a build and absent in a fresh
 * clone.  Scanning it would make the page count depend on whether someone has
 * built the site, which is exactly the kind of wobble that turns a
 * guard-the-guard assertion into noise.
 */
const GENERATED_DIRECTORY = 'api';

type ParseFailure = {
  readonly page: string;
  readonly reason: string;
};

function documentationPages(directory: string, prefix = ''): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (prefix === '' && entry.name === GENERATED_DIRECTORY) continue;
      found.push(...documentationPages(join(directory, entry.name), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) {
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

/** The block between the first two `---` lines, or `null` when a page has none. */
function frontmatterOf(source: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  return match === null ? null : (match[1] ?? '');
}

function parseFailure(block: string): ParseFailure | null {
  try {
    (Bun as unknown as { YAML: { parse(input: string): unknown } }).YAML.parse(block);
    return null;
  } catch (error) {
    return { page: '', reason: (error as Error).message.split('\n')[0] ?? String(error) };
  }
}

const pages = existsSync(DOCS_ROOT) ? documentationPages(DOCS_ROOT) : [];

describe('documentation frontmatter', () => {
  /**
   * Guards the guard.  The assertion below filters a list, and a filter over an
   * empty list reports no violations — so a moved docs root or a broken walk
   * would turn this suite green while checking nothing.
   */
  test('the docs tree was actually walked', () => {
    expect(
      pages.length,
      `Found ${pages.length} documentation pages under the docs content root. The tree moved `
      + 'or the walk broke, and the assertion below is filtering an empty list.',
    ).toBeGreaterThan(400);
  });

  /**
   * And that the parser rejects what broke the build.  A guard that accepts
   * everything passes for the same reason a correct tree does; this pins the
   * discrimination on the exact shape of #1525 — an unquoted plain scalar with
   * a colon and a space inside — and on its fix.
   */
  test('the parser rejects the shape that broke the build, and accepts its fix', () => {
    const value = 'a token bucket — `{ qps: Infinity }` / `cancelThrottle()`';
    expect(
      parseFailure(`description: ${value}`),
      'Bun.YAML.parse accepted an unquoted description containing a colon and a space. That '
      + 'is the exact input that stopped `astro build` in #1525, so if the parser now takes '
      + 'it this guard no longer covers the defect it was written for.',
    ).not.toBeNull();
    expect(
      parseFailure(`description: ${JSON.stringify(value)}`),
      'Quoting the value did not make it parse, so the remedy this guard points at is wrong.',
    ).toBeNull();
  });

  test('every page has frontmatter that parses', () => {
    const failures: string[] = [];
    let withFrontmatter = 0;
    for (const page of pages) {
      const block = frontmatterOf(readFileSync(join(DOCS_ROOT, page), 'utf8'));
      if (block === null) continue;
      withFrontmatter += 1;
      const failure = parseFailure(block);
      if (failure !== null) failures.push(`${page} — ${failure.reason}`);
    }

    // Starlight requires a `title`, so essentially every page carries a block.
    // A collapse here would mean the delimiter scan stopped matching.
    expect(
      withFrontmatter,
      'Almost no page appears to have frontmatter. The `---` scan stopped matching, so the '
      + 'parse assertion below runs over nothing.',
    ).toBeGreaterThan(400);

    expect(
      failures,
      'These pages have frontmatter YAML cannot parse, which fails `astro build` during '
      + 'content sync before a single page renders — and the only workflow that builds the '
      + 'site runs on `main`, at release time. The usual cause is a colon followed by a '
      + 'space inside an unquoted value, which YAML reads as a nested mapping: wrap the '
      + 'value in double quotes (#1525).',
    ).toEqual([]);
  });
});
