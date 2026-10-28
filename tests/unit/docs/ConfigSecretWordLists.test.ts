import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CONFIG_SECRET_PATTERN } from '../../../src/util/Constants.js';

/**
 * Every page that lists the words a config key is withheld by lists the
 * words `CONFIG_SECRET_PATTERN` accepts (found while #1546).
 *
 * Three pages tell an operator what the config dump and the DevTools config
 * panel withhold, in two languages each.  The troubleshooting page was held
 * to the pattern by `TroubleshootingConfigDump.test.ts`; the configuration
 * reference and the DevTools configuration page were held to nothing, and
 * both kept listing seven of the eight words after the pattern learned
 * `passwd` — so a reader checking whether `db.passwd` would leak was told it
 * would.  This file holds those two pages the same way, and fails when a
 * page nobody pins starts listing the words.
 *
 * What this cannot see is the prose around the list: a sentence asserting
 * the opposite of the rule keeps every check here green.
 */

const DOCUMENTATION_ROOT = join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs');

/** Each pinned list, by page and the heading of the section it sits in. */
const PINNED = [
  { page: join('reference', 'configuration.mdx'), heading: '### `actor-ts.diagnostics`' },
  { page: join('de', 'reference', 'configuration.mdx'), heading: '### `actor-ts.diagnostics`' },
  { page: join('observability', 'devtools', 'configuration.mdx'), heading: '## Secrets' },
  { page: join('de', 'observability', 'devtools', 'configuration.mdx'), heading: '## Geheimnisse' },
] as const;

/** The pages `TroubleshootingConfigDump.test.ts` pins, which this file leaves to it. */
const PINNED_ELSEWHERE = [
  join('operations', 'troubleshooting.mdx'),
  join('de', 'operations', 'troubleshooting.mdx'),
] as const;

/**
 * The lines under `heading`, up to the next heading of the same level or a
 * higher one — a `###` section ends at the next `###` or `##`.
 */
function sectionOf(text: string, heading: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(heading);
  expect(start, `${heading} is missing`).toBeGreaterThan(-1);
  const level = heading.indexOf(' ');
  const end = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${level}} `).test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/**
 * The prose of some lines as one line: fences dropped, and MDX comments too,
 * because a list inside either renders as nothing a reader sees.
 */
function proseOf(lines: readonly string[]): string {
  const prose: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) prose.push(line);
  }
  return prose.join(' ').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Every run of two or more code spans that reads as a list, as its spans —
 * joined by commas, by a conjunction, by both, or by slashes.
 *
 * Any conjunction, not one: a census that knew only "`a`, `b` or `c`" let a
 * stale list written "`a`, `b` and `c`" stand beside the corrected one, and on
 * a page nobody pins, without a word.  So `and`, `nor`, `plus` and the German
 * `und`, `sowie` join a list as `or` and `oder` do, and so does a comma alone.
 */
function codeSpanLists(prose: string): string[][] {
  return [...prose.matchAll(CODE_SPAN_LIST)]
    .map((match) => [...match[0].matchAll(/`([^`]+)`/g)].map((span) => span[1]!));
}

/** A run of code spans joined the ways {@link codeSpanLists} reads as a list. */
const CODE_SPAN_LIST =
  /`[^`]+`(?:(?:\s*,\s*(?:(?:or|and|nor|plus|oder|und|sowie)\s+)?|\s+(?:or|and|nor|plus|oder|und|sowie)\s+|\s*\/\s*)`[^`]+`)+/g;

/** A list naming both of these is a list of the words, not a list that mentions one. */
const isSecretWordList = (spans: readonly string[]): boolean =>
  spans.includes('password') && spans.includes('secret');

/**
 * Every word `CONFIG_SECRET_PATTERN` accepts, in the singular — the reading
 * `TroubleshootingConfigDump.test.ts` uses: each accepted word is a
 * concatenation of up to three letter runs of the pattern's source, and a
 * plural is dropped when its singular is accepted as well.
 */
function wordsThePatternAccepts(): string[] {
  const runs = [...new Set(CONFIG_SECRET_PATTERN.source.match(/[a-z]+/gi) ?? [])];
  const candidates = new Set<string>();
  for (const first of runs) {
    for (const second of ['', ...runs]) {
      for (const third of ['', ...runs]) candidates.add((first + second + third).toLowerCase());
    }
  }
  const accepted = [...candidates].filter((word) => CONFIG_SECRET_PATTERN.test(word));
  return accepted.filter((word) => !(word.endsWith('s') && accepted.includes(word.slice(0, -1)))).sort();
}

/** Every `.mdx` / `.md` page under the docs root, relative to it. */
function pagesUnder(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...pagesUnder(full));
    else if (/\.mdx?$/.test(entry.name)) out.push(relative(DOCUMENTATION_ROOT, full));
  }
  return out;
}

const listingPages = pagesUnder(DOCUMENTATION_ROOT)
  .filter((page) => codeSpanLists(proseOf(readFileSync(join(DOCUMENTATION_ROOT, page), 'utf8').split(/\r?\n/)))
    .some(isSecretWordList))
  .sort();

describe('every page listing the secret words lists the ones the pattern accepts (found while #1546)', () => {
  test('the pattern still reads as the eight words the pages name', () => {
    // Guards the guard: a reading of the pattern that found nothing would
    // make every list below compare equal to an empty one.
    expect(wordsThePatternAccepts()).toEqual(
      ['auth', 'credential', 'key', 'passphrase', 'passwd', 'password', 'secret', 'token'],
    );
  });

  for (const { page, heading } of PINNED) {
    test(`${page.split(sep).join('/')} lists them under ${heading}`, () => {
      const lists = codeSpanLists(proseOf(sectionOf(readFileSync(join(DOCUMENTATION_ROOT, page), 'utf8'), heading)))
        .filter(isSecretWordList);
      // Exactly one, so a stale list left beside a corrected one fails
      // rather than letting either pass.
      expect(lists, 'one list of the secret words in the section').toHaveLength(1);
      expect([...lists[0]!].sort()).toEqual(wordsThePatternAccepts());
    });
  }

  test('no page lists them without being pinned', () => {
    expect(listingPages).toEqual([...PINNED.map(({ page }) => page), ...PINNED_ELSEWHERE].sort());
  });
});
