import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * **No documentation line outside a fenced code block starts with `{`.**
 *
 * This exists because one did, and the site could not build for a day
 * (#1595).  A sentence on `fundamentals/blocking-and-cpu-bound-work.mdx`
 * wrapped an inline code span across a line break so that the continuation
 * line began with `{ transfer: [bytes.buffer] })`, and `astro build` died
 * with `Could not parse expression with acorn`.  The backticks never got a
 * say: MDX parses flow constructs before inline ones, and a line that begins
 * with `{` — after the indentation of whatever container it sits in, so a
 * list item's continuation line counts — is tried as a **flow expression**
 * even in the middle of a paragraph, even when the previous line opened a
 * code span that has not closed yet.
 *
 * ## What the compiler actually does, and why a heuristic is exact here
 *
 * Probed against `@mdx-js/mdx` itself rather than assumed.  The tokenizer
 * collects the text between the braces and hands it to acorn **as
 * JavaScript, without the braces**, so `{ transfer: [bytes.buffer] }` means
 * the expression `transfer: [bytes.buffer]`, which is not one.  That parse
 * happens eagerly and its failure is fatal — the build stops, whatever
 * follows on the line.  When the content *is* an expression, the construct
 * then requires the line to end after the closing brace; text after it
 * (`>\`.`) makes the construct fail gracefully and the line goes back to
 * being paragraph text, which is how `cluster/pubsub.mdx` carried
 * `{ local, remoteNodes }>\`.` for months and rendered its code span
 * intact.  A sequence expression is one keystroke away from a labelled
 * statement, so that page was one edit from the same red build — and a
 * valid expression alone on its line would have been worse: a build that
 * passes and a page that renders `local, remoteNodes` evaluated.
 *
 * Telling those three outcomes apart needs acorn, and the root install has
 * no MDX toolchain (the docs are their own package, deliberately).  So this
 * is a policy rather than a parser: the documentation writes no MDX
 * expressions, none of its ~500 pages needs one, and a prose line that
 * starts with `{` is always a wrapped code span that wants rewrapping.  The
 * day a page wants a real flow expression, it goes in the allow-list below
 * with its reason, and the guard keeps holding for the other pages.
 *
 * Fenced code is exempt by construction — a fence's content is never
 * parsed as MDX — and so is the frontmatter, which is YAML.  Inline `{…}`
 * mid-line is a different construct (an inline expression, also parsed as
 * JavaScript when it is not inside a code span) and out of scope here.
 *
 * ## Why a test rather than the build
 *
 * The same reason `FrontmatterParses.test.ts` gives: `astro build` is a
 * four-minute Playwright-backed run nobody does before committing, and
 * `docs-checks.yml` only runs it once the commit is on `develop`.  The
 * offending page sat there for two pushes with `docs-checks` red on both.
 * Reading 500 files for a leading brace costs milliseconds.
 */

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/** TypeDoc's generated tree — present after a local build, absent in a clone. */
const GENERATED_DIRECTORY = 'api';

/**
 * Pages allowed to start a line with `{` outside a fence, each with the
 * reason it needs a real MDX flow expression there.  Empty on purpose.
 */
const ALLOWED_PAGES: ReadonlyMap<string, string> = new Map<string, string>([]);

type Offence = {
  readonly page: string;
  readonly line: number;
  readonly text: string;
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

/** A fence opener: up to three spaces, then three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Lines of `source` that begin with `{` outside fenced code and outside the
 * frontmatter.  A fence closes only on a run of the same character at least
 * as long as the one that opened it, which is CommonMark's rule and what lets
 * a ```` ```` ```` fence contain a ``` ``` ``` one — the docs do that.
 */
function braceLedLines(source: string): ReadonlyArray<{ line: number; text: string }> {
  const lines = source.split(/\r?\n/);
  const offences: Array<{ line: number; text: string }> = [];
  let fence: string | null = null;
  let inFrontmatter = lines[0] === '---';
  for (let index = inFrontmatter ? 1 : 0; index < lines.length; index += 1) {
    const text = lines[index]!;
    if (inFrontmatter) {
      if (text === '---') inFrontmatter = false;
      continue;
    }
    const opener = FENCE.exec(text)?.[1];
    if (fence === null) {
      if (opener !== undefined) fence = opener;
      else if (/^\s*\{/.test(text)) offences.push({ line: index + 1, text });
    } else if (opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(text)) {
      fence = null;
    }
  }
  return offences;
}

const pages = documentationPages(DOCS_ROOT);
const sources: ReadonlyMap<string, string> = new Map(
  pages.map((page) => [page, readFileSync(join(DOCS_ROOT, page), 'utf8')]),
);

describe('documentation lines never start with `{` outside a code fence', () => {
  test('the scanner saw the documentation, both languages, and fences it had to skip', () => {
    // Guards the guard: an empty tree or a wrong root would pass the
    // assertion below by seeing nothing, and a fence tracker that never
    // opened a fence would fail it on every JSON and HOCON sample — so
    // "many pages have raw brace-led lines" together with a green tree is
    // the proof that those lines were seen and correctly skipped.
    expect(pages.length).toBeGreaterThan(400);
    expect(pages.filter((page) => page.startsWith('de/')).length).toBeGreaterThan(200);
    const pagesWithRawBraceLines = [...sources.values()].filter((source) => /^\s*\{/m.test(source));
    expect(pagesWithRawBraceLines.length).toBeGreaterThan(50);
  });

  test('the shapes that broke, or nearly broke, the build are what the scanner flags', () => {
    expect(braceLedLines('text: `pool.run(task, [bytes.buffer],\n{ transfer: [bytes.buffer] })`.  More.\n'))
      .toEqual([{ line: 2, text: '{ transfer: [bytes.buffer] })`.  More.' }]);
    expect(braceLedLines('1. The mediator looks up `Map<topic,\n   { local, remoteNodes }>`.\n'))
      .toEqual([{ line: 2, text: '   { local, remoteNodes }>`.' }]);
    expect(braceLedLines('---\ntitle: "{ not: mdx }"\n---\n\nprose\n\n```ts\n{ a: 1 }\n```\n\n````md\n```\n{ nested: fence }\n```\n````\n')).toEqual([]);
  });

  test('no page has one, outside the allow-list', () => {
    const offences: Offence[] = [];
    for (const [page, source] of sources) {
      if (ALLOWED_PAGES.has(page)) continue;
      for (const hit of braceLedLines(source)) {
        offences.push({ page, line: hit.line, text: hit.text });
      }
    }
    const report = offences
      .map((o) => `  ${o.page}:${o.line}: ${o.text.trim()}`)
      .join('\n');
    expect(
      offences,
      `${offences.length} documentation line(s) start with '{' outside a code fence — MDX parses such a line `
      + 'as a flow expression before it looks at inline code, so a wrapped code span there breaks or '
      + `mis-renders the page. Rewrap so the '{' is not first on its line:\n${report}`,
    ).toEqual([]);
  });

  test('every allow-listed page still exists and still needs the exemption', () => {
    for (const [page, reason] of ALLOWED_PAGES) {
      expect(reason.length, `${page}: an allow-list entry carries its reason`).toBeGreaterThan(10);
      expect(pages, `${page} is allow-listed but no longer exists`).toContain(page);
      expect(braceLedLines(sources.get(page) ?? '').length, `${page}: allow-listed without needing it`).toBeGreaterThan(0);
    }
  });
});
