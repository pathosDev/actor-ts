import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';

/**
 * The docs publish the bundled reference configuration verbatim so a reader
 * can see everything that is settable in one place.  A hand-copied file is
 * exactly the drift surface #653 was about — a documented default that no
 * longer matches the shipped one is the same lie as a documented key nothing
 * reads — so the copy is pinned to the source here instead of to nobody.
 *
 * Both languages carry the identical block: house rule is that code samples
 * stay the same across translations and only prose is translated.
 */

const DOCS_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

const PAGES = [
  ['English', join(DOCS_ROOT, 'reference', 'reference-conf.mdx')],
  ['German', join(DOCS_ROOT, 'de', 'reference', 'reference-conf.mdx')],
] as const;

/**
 * The page's `actor-ts { … }` HOCON block.  Anchored on the opening brace
 * rather than on "the first hocon fence": both pages lead with a short
 * application.conf example, and matching that one instead would compare the
 * wrong thing while still looking like it passed.
 */
function referenceBlockOf(page: string): string | null {
  const fences = page.matchAll(/```hocon\r?\n([\s\S]*?)```/g);
  for (const fence of fences) {
    const body = fence[1]!.trimEnd();
    if (body.startsWith('actor-ts {')) return body.replace(/\r\n/g, '\n');
  }
  return null;
}

describe('the docs reproduce reference.conf verbatim', () => {
  test.each(PAGES)('%s page matches REFERENCE_CONF', (_language, path) => {
    const block = referenceBlockOf(readFileSync(path, 'utf8'));

    expect(block, `${path} has no fenced hocon block starting with "actor-ts {"`).not.toBeNull();
    expect(
      block,
      'The published reference configuration has drifted from src/config/Reference.ts. '
      + 'Copy REFERENCE_CONF into the hocon block on both language pages.',
    ).toBe(REFERENCE_CONF.replace(/\r\n/g, '\n'));
  });
});

/**
 * Below the block, one section lists what the block leaves out on purpose,
 * so every path that section names is a claim about `REFERENCE_CONF`: this
 * path has no entry above.  The comparison above stops at the fence and never
 * read the claim, so it outlived the change that made it false — #872 and
 * #876 gave the persistence and cache plug-ins their blocks, and the section
 * went on citing `actor-ts.persistence.journal.postgres` and
 * `actor-ts.cache.redis` as subtrees with none (#1457).
 *
 * A path is any `actor-ts.…` token in the section, backticked or not, and any
 * backticked dotted kebab-case token read relative to `actor-ts` — the
 * spelling the configuration reference's tables use (`io.broker.kafka`).  The
 * scan reads the raw text rather than the rendered page, so a path inside an
 * MDX comment is flagged too, although it renders nothing.
 */
const NOT_HERE_HEADINGS: Record<(typeof PAGES)[number][0], string> = {
  English: 'What is deliberately not here',
  German: 'Was hier bewusst fehlt',
};

/** The section's body: from its `## ` heading to the next `## ` heading or the end of the page. */
function sectionOf(page: string, heading: string): string | null {
  const lines = page.replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

function pathsNamedIn(section: string): string[] {
  const paths = new Set<string>();
  for (const match of section.matchAll(/actor-ts(?:\.[a-z0-9][a-z0-9-]*)+/g)) paths.add(match[0]);
  for (const match of section.matchAll(/`([a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)`/g)) {
    const token = match[1]!;
    paths.add(token.startsWith('actor-ts.') ? token : `actor-ts.${token}`);
  }
  return [...paths].sort();
}

function notHerePathsOf(language: (typeof PAGES)[number][0], path: string): string[] | null {
  const section = sectionOf(readFileSync(path, 'utf8'), NOT_HERE_HEADINGS[language]);
  return section === null ? null : pathsNamedIn(section);
}

describe('what the page says reference.conf leaves out', () => {
  const reference = Config.parseString(REFERENCE_CONF);

  test.each(PAGES)('%s page names no path that REFERENCE_CONF ships', (language, path) => {
    const heading = NOT_HERE_HEADINGS[language];
    const named = notHerePathsOf(language, path);

    expect(named, `${path} has no "## ${heading}" section`).not.toBeNull();
    // An empty list would pass the check below by reading nothing.
    expect(named!.length, `"${heading}" in ${path} names no path, so nothing here is checked`).toBeGreaterThan(0);
    expect(
      named!.filter((candidate) => reference.hasPath(candidate)),
      `"${heading}" in ${path} cites these as having no entry, but REFERENCE_CONF ships them.  `
      + 'Take them out of that section: it lists only what has no entry above.',
    ).toEqual([]);
  });

  test('both languages name the same paths', () => {
    const [english, german] = PAGES.map(([language, path]) => notHerePathsOf(language, path));
    expect(german).toEqual(english);
  });
});
