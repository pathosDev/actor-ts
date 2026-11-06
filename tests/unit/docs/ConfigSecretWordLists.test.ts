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
 * joined by commas, by a conjunction, by both, by slashes, as the cells of a
 * table row, or as the items of a bulleted or numbered list (whose lines
 * {@link proseOf} has joined).
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
const CODE_SPAN_LIST = new RegExp(
  '`[^`]+`(?:(?:'
    + String.raw`\s*,\s*(?:(?:or|and|nor|plus|oder|und|sowie)\s+)?`
    + String.raw`|\s+(?:or|and|nor|plus|oder|und|sowie)\s+`
    + String.raw`|\s*[/|]\s*`
    + String.raw`|\s+(?:[-*+]|\d+[.)])\s+`
    + ')`[^`]+`)+',
  'g',
);

/** A list naming both of these is a list of the words, not a list that mentions one. */
const isSecretWordList = (spans: readonly string[]): boolean =>
  spans.includes('password') && spans.includes('secret');

/** The lists of the secret words in some lines of a page — what the census and the exactly-one check both count. */
function secretWordLists(lines: readonly string[]): string[][] {
  return codeSpanLists(proseOf(lines)).filter(isSecretWordList);
}

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
  .filter((page) => secretWordLists(readFileSync(join(DOCUMENTATION_ROOT, page), 'utf8').split(/\r?\n/)).length > 0)
  .sort();

describe('every page listing the secret words lists the ones the pattern accepts (found while #1546)', () => {
  test('the pattern still reads as the ten words the pages name', () => {
    // Guards the guard: a reading of the pattern that found nothing would
    // make every list below compare equal to an empty one.  `pass` and
    // `authorization` joined the eight with #1759.
    expect(wordsThePatternAccepts()).toEqual([
      'auth', 'authorization', 'credential', 'key', 'pass', 'passphrase', 'passwd', 'password', 'secret', 'token',
    ]);
  });

  for (const { page, heading } of PINNED) {
    test(`${page.split(sep).join('/')} lists them under ${heading}`, () => {
      const lists = secretWordLists(sectionOf(readFileSync(join(DOCUMENTATION_ROOT, page), 'utf8'), heading));
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

/**
 * The list reading itself, against every way a page could write the words.
 * The checks above pass on today's pages however narrowly a list is read, so
 * these hold the reading to its word: put back the reading fb32723f began
 * with, "`a`, `b` or `c`" and `oder` only, and the census and the exactly-one
 * check go blind to a stale list written any other way again — while every
 * page check stays green.
 */
describe('the census and the exactly-one check read a list of the words however it is joined (#1546)', () => {
  const words = ['password', 'passphrase', 'passwd', 'secret', 'token', 'key', 'credential', 'auth'];
  const spans = words.map((word) => `\`${word}\``);
  const joined = (separator: string, last = separator): string =>
    `${spans.slice(0, -1).join(separator)}${last}${spans.at(-1)!}`;

  test.each([
    ['commas and "or"', [`withheld when a word is ${joined(', ', ' or ')}.`]],
    ['commas and "and"', [`Older releases withheld ${joined(', ', ' and ')} only.`]],
    ['a serial comma before "and"', [`withheld: ${joined(', ', ', and ')}.`]],
    ['"and" alone', [`withheld: ${joined(' and ')}.`]],
    ['"nor"', [`neither ${joined(', ', ' nor ')} is printed.`]],
    ['"plus"', [`withheld: ${joined(', ', ' plus ')}.`]],
    ['commas and "oder"', [`zurückgehalten, wenn ein Wort ${joined(', ', ' oder ')} ist.`]],
    ['commas and "und"', [`Ältere Versionen hielten ${joined(', ', ' und ')} zurück.`]],
    ['commas and "sowie"', [`zurückgehalten: ${joined(', ', ' sowie ')}.`]],
    ['commas alone', [`withheld: ${joined(', ')}.`]],
    ['slashes', [`withheld: ${joined(' / ')}.`]],
    ['the cells of a table row', [`| withheld | ${joined(' | ')} |`]],
    ['a bulleted list', ['The dump withholds:', '', ...spans.map((span) => `- ${span}`)]],
    ['a numbered list', ['The dump withholds:', '', ...spans.map((span, index) => `${String(index + 1)}. ${span}`)]],
    ['a list wrapped across lines', [`withheld when a word is ${spans.slice(0, 4).join(', ')},`, `${joined(', ', ' and ').split(', ').slice(4).join(', ')}.`]],
  ])('a list joined by %s is one list of the eight words', (_joiner, lines) => {
    const lists = secretWordLists(lines);
    expect(lists).toHaveLength(1);
    expect([...lists[0]!].sort()).toEqual([...words].sort());
  });

  test('a stale list beside the corrected one is a second list, whatever joins it', () => {
    const section = [
      `A value is withheld when a word of its key is ${joined(', ', ' or ')}.`,
      `Older releases withheld ${spans.filter((span) => span !== '`passwd`').join(', ').replace(/, (`auth`)$/, ' and $1')} only.`,
    ];
    expect(secretWordLists(section)).toHaveLength(2);
  });

  test('what does not read as a list of the words', () => {
    // A sentence between two spans is no joiner, a list without `secret` is
    // some other list, and a list a reader never sees — inside a fence or an
    // MDX comment — is not on the page.
    expect(secretWordLists(['`password` is withheld. So is `secret`.'])).toEqual([]);
    expect(secretWordLists(['It reads `password`, `username` and `host`.'])).toEqual([]);
    expect(secretWordLists(['```text', joined(', ', ' and '), '```'])).toEqual([]);
    expect(secretWordLists([`{/* ${joined(', ', ' and ')} */}`])).toEqual([]);
  });
});
