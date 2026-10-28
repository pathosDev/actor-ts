/**
 * #1426 — the pages that say what the failure detector does with a peer it
 * declares `down`, held to the shipped default.
 *
 * `actor-ts.cluster.failure-detector.auto-down` ships `on`: with no downing
 * strategy configured, the detector removes a peer silent past `down-after`,
 * so an n-node cluster keeps running down to its last available node.  `off`
 * is the opt-out that parks the peer at `unreachable`.  For a few weeks the
 * default was the other way round, and the prose written for it said so in
 * some forty places across both languages — tables, samples, asides, the
 * testkit pages and the examples' comments.  None of it was checked:
 * `DocumentedDefaults` pins `reference/reference-conf.mdx` alone, so the
 * configuration reference's table and sample kept whatever they said with
 * every docs test green (#1426).
 *
 * Two kinds of assertion, both deliberately on text a reader acts on:
 *
 * - **Where a page states the default in structure** — the decision table on
 *   the failure-detector page, the removal table on the downing page — the
 *   removal is the default and parking the opt-out.
 * - **The phrasings the parking default was written in** must not come back on
 *   a page or in an example that discusses downing.  A merge that resolves a
 *   conflict by taking the old side is the likeliest way they would, and it
 *   brings the old sentence back verbatim.  This half is a list of phrasings,
 *   not an understanding of them: a paraphrase gets past it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const DOCUMENTATION = 'docs/src/content/docs';

const read = (path: string): string => readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

type Language = {
  readonly name: string;
  /** Path prefix under the documentation root: `''` or `'de/'`. */
  readonly prefix: string;
  /** How a table cell marks the shipped behaviour. */
  readonly defaultMarker: RegExp;
  /** How a table cell marks the opt-out. */
  readonly optOutMarker: RegExp;
};

const LANGUAGES: readonly Language[] = [
  { name: 'English', prefix: '', defaultMarker: /\bthe default\b/i, optOutMarker: /\bopt-out\b/i },
  { name: 'German', prefix: 'de/', defaultMarker: /\bder Default\b/, optOutMarker: /\bOpt-out\b/ },
];

const page = (language: Language, path: string): string => `${DOCUMENTATION}/${language.prefix}${path}`;

/** The cells of a Markdown table row, outer pipes dropped. */
function cellsOf(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** The table rows of a page whose first cell matches `firstCell`. */
function rowsWhere(text: string, firstCell: RegExp): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .map(cellsOf)
    .filter((cells) => firstCell.test(cells[0] ?? ''));
}

describe('#1426 — the pages state the shipped auto-down default', () => {
  for (const language of LANGUAGES) {
    test(`${language.name}: the failure-detector decision table marks the removal row as the default`, () => {
      const path = page(language, 'cluster/failure-detector.mdx');
      const rows = rowsWhere(read(path), /^`down`/);
      const defaults = rows.filter((cells) => language.defaultMarker.test(cells[0]!));
      expect(
        defaults.map((cells) => cells[0]),
        `${path}: the decision table has to mark exactly one \`down\` row as the default, and it is the `
        + 'row where the detector removes the peer (`auto-down = on`).',
      ).toEqual([expect.stringMatching(/`auto-down = on`/)]);
      for (const cells of rows.filter((row) => /`auto-down = off`/.test(row[0]!))) {
        expect(cells[0], `${path}: the parking row is the opt-out, not the default.`).toMatch(language.optOutMarker);
      }
    });

    test(`${language.name}: the downing page's removal table marks the detector's route as the default`, () => {
      const path = page(language, 'cluster/downing-strategies.mdx');
      const rows = rowsWhere(read(path), /auto-down/);
      const removal = rows.filter((cells) => /auto-down = on/.test(cells[0]!));
      const parking = rows.filter((cells) => /auto-down = off/.test(cells[0]!));
      expect(removal.length, `${path}: no removal-table row for the detector's own route.`).toBe(1);
      expect(parking.length, `${path}: no removal-table row for the opt-out.`).toBe(1);
      expect(removal[0]![0], `${path}: the detector's own route is the default.`).toMatch(language.defaultMarker);
      expect(parking[0]![0], `${path}: parking is the opt-out.`).toMatch(language.optOutMarker);
      expect(parking[0]![0], `${path}: parking is not the default.`).not.toMatch(language.defaultMarker);
    });
  }
});

/**
 * A phrasing the parking default was written in.  `alongside`, when present,
 * has to match the same sentence too — "opt-in" is only the old claim in a
 * sentence about `auto-down`.
 */
type OldPhrasing = {
  readonly pattern: RegExp;
  readonly alongside?: RegExp;
};

const ABOUT_AUTO_DOWN = /auto-?down/i;

const OLD_PHRASINGS: readonly OldPhrasing[] = [
  // English.
  { pattern: /auto-down`?(?:\s*=\s*`?off`?)?`?\s*\(the default\)/i },
  { pattern: /auto-down`?\s*(?:=\s*)?`?off`?,\s*the default\b/i },
  { pattern: /\boff by default\b/i, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bships off\b/i, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bat its default off\b/i },
  { pattern: /\bthe shipped `?false\b/i, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bby default,? (?:it|the detector) (?:only )?parks\b/i },
  { pattern: /\bthe default parks\b/i },
  { pattern: /\bby the default with no strategy\b/i },
  { pattern: /\b(?:the default|by default)\b.*\b(?:removes|evicts) (?:nothing|nobody|no one)\b/i },
  { pattern: /\bunder the default\b.*\b(?:removes|evicts) (?:nothing|nobody|no one)\b/i },
  { pattern: /\bremoves nobody\b/i },
  { pattern: /\bthe default is manual\b/i },
  { pattern: /\bopt(?:s|ed)?[- ]in(?:to)?\b/i, alongside: ABOUT_AUTO_DOWN },
  { pattern: /auto-down = on`? (?:opts|restores)\b/i },
  { pattern: /\bwith(?:out)? (?:no |a )?strategy\b.*\b(?:would )?only parks?\b/i },
  { pattern: /\bnothing removes (?:an unreachable|a member the failure detector)/i },
  { pattern: /\bthe way out of the default\b/i },
  // German.
  { pattern: /auto-down`?(?:\s*=\s*`?off`?)?`?\s*\(der Default\)/ },
  { pattern: /auto-down`?\s*(?:=\s*)?`?(?:off|aus)`?,\s*der (?:Standard|Default)\b/ },
  { pattern: /\bper Default aus\b/i, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bauf dem Default `?off\b/ },
  { pattern: /\baus ausgeliefert\b/, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bausgelieferte[nm]? `?false\b/, alongside: ABOUT_AUTO_DOWN },
  { pattern: /\bPer Default parkt\b/i },
  { pattern: /\bparkt auch der Default\b/ },
  { pattern: /\bvom Default ohne Strategie\b/ },
  { pattern: /\b(?:im|der) Default\b.*\b(?:entfernt|evakuiert)\b.*\b(?:nichts|niemanden)\b/ },
  { pattern: /\bStandard\b.*\bentfernt niemanden\b/ },
  { pattern: /\bStandard ist also manuell\b/ },
  { pattern: /\bOpt-in\b/, alongside: ABOUT_AUTO_DOWN },
  { pattern: /auto-down = on`? (?:wählt|stellt)\b/ },
  { pattern: /\bentfernt nichts (?:einen unerreichbaren|ein Mitglied)/ },
  { pattern: /\bWeg aus dem Default\b/ },
];

/**
 * Every page and example comment that discusses what becomes of a crashed
 * peer.  Listed rather than globbed: a page that states the default joins by
 * being listed, and one whose wording another change owns is not held here
 * before that change lands.
 */
const GUARDED_FILES: readonly string[] = [
  ...LANGUAGES.flatMap((language) => [
    page(language, 'cluster/failure-detector.mdx'),
    page(language, 'cluster/downing-strategies.mdx'),
  ]),
];

/** Prose cut into sentences after a terminal mark followed by whitespace. */
function proseSentences(lines: readonly string[]): string[] {
  return lines
    .join(' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence !== '');
}

/**
 * The units a phrasing is looked for in, as a reader meets them.  On a page,
 * prose is cut into sentences — after a terminal mark followed by whitespace,
 * so the dots in `failure-detector.auto-down` stay inside their sentence — and
 * each line of a code fence is a unit of its own, because a sample's lines do
 * not run on into each other.  In an example, comment markers are dropped so a
 * comment reads as the prose it is.
 */
function unitsOf(path: string, text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (!path.endsWith('.mdx')) {
    return proseSentences(lines.map((line) => line.replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/|#)\s?/, '')));
  }
  const units: string[] = [];
  let prose: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!inFence) units.push(...proseSentences(prose));
      prose = [];
      inFence = !inFence;
    } else if (inFence) {
      units.push(line.trim());
    } else {
      prose.push(line);
    }
  }
  units.push(...proseSentences(prose));
  return units.filter((unit) => unit !== '');
}

describe('#1426 — no page or example says the detector parks by default', () => {
  test('none of the phrasings the parking default was written in is back', () => {
    const found: string[] = [];
    for (const path of GUARDED_FILES) {
      for (const sentence of unitsOf(path, read(path))) {
        const phrasing = OLD_PHRASINGS.find(
          (old) => old.pattern.test(sentence) && (old.alongside === undefined || old.alongside.test(sentence)),
        );
        if (phrasing !== undefined) found.push(`  ${path}:\n      ${sentence}\n      matched ${phrasing.pattern}`);
      }
    }
    expect(
      found,
      `${found.length} sentence(s) describe parking as the default or the detector's removal as an opt-in:\n`
      + `${found.join('\n')}\n`
      + 'With no strategy configured the detector removes a peer silent past down-after — '
      + '`failure-detector.auto-down = on` is the default, and `off` is the opt-out that parks it.',
    ).toEqual([]);
  });
});
