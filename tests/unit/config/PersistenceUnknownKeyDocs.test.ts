/**
 * #1729 — what the persistence pages say about a key under
 * `actor-ts.persistence` that nothing reads, held to the check.
 *
 * Both pages used to warn that such a key is not refused: `plugn = "…"` or a
 * `jornal` block left the axis in memory without a word.  That warning was
 * right when it was written and turned false with the refusal, and nothing
 * would have failed had it stayed, because the suites that pin the behaviour
 * never open a page.  So each page, English and German, has to name the keys
 * it says are refused, the `ConfigError` and the remedy — and each key it
 * names is handed to the check, which has to refuse it, naming it.
 *
 * Prose is compared with its line breaks folded away, so rewrapping a
 * paragraph moves no pin, and with MDX comments cut first: a comment renders
 * nothing, so a sentence that lives only in one does not count as said.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Config, ConfigError } from '../../../src/config/Config.js';
import { refuseUnknownPersistenceKeys } from '../../../src/persistence/PersistenceUnknownKeys.js';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');

function prose(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\s+/g, ' ');
}

type PageClaim = {
  readonly page: string;
  /** The full keys the page says the startup refuses, each with the HOCON that writes it. */
  readonly refused: ReadonlyArray<{ readonly key: string; readonly hocon: string }>;
  /** The remedy, in the page's language. */
  readonly remedy: string;
};

const JOURNAL_KEYS = [
  { key: 'actor-ts.persistence.journal.plugn', hocon: 'actor-ts.persistence.journal.plugn = "x"' },
  { key: 'actor-ts.persistence.jornal', hocon: 'actor-ts.persistence.jornal { plugin = "x" }' },
];
const DURABLE_STATE_KEYS = [
  { key: 'actor-ts.persistence.durable-state.plugn', hocon: 'actor-ts.persistence.durable-state.plugn = "x"' },
];

const PAGES: readonly PageClaim[] = [
  { page: 'docs/src/content/docs/persistence/overview.mdx', refused: JOURNAL_KEYS, remedy: 'Correct the spelling' },
  { page: 'docs/src/content/docs/de/persistence/overview.mdx', refused: JOURNAL_KEYS, remedy: 'Korrigiere die Schreibweise' },
  { page: 'docs/src/content/docs/persistence/durable-state.mdx', refused: DURABLE_STATE_KEYS, remedy: 'Correct the spelling' },
  { page: 'docs/src/content/docs/de/persistence/durable-state.mdx', refused: DURABLE_STATE_KEYS, remedy: 'Korrigiere die Schreibweise' },
];

/**
 * The warnings the pages carried until #1729, in both languages; the
 * overview's sentence that with the boot-time open off every mistake above it
 * fails the first operation instead — which a key nothing reads no longer does;
 * and the exception it then named for the open turned off in code with nothing
 * else of persistence there, which has none now either.
 */
const RETIRED_WARNINGS: readonly RegExp[] = [
  /misspelt key is not (?:one of them|refused)/i,
  /vertippter Schlüssel (?:gehört nicht dazu|wird nicht abgelehnt)/i,
  /— the mistakes above then fail that operation/,
  /— die Fehler oben lassen dann diese Operation/,
  /\bone exception is a system that turns the switch off in code\b/i,
  /\bDie eine Ausnahme ist ein System, das den Schalter im Code abschaltet\b/,
];

/** The overview's claim that the opt-out in code with nothing else of persistence is no exception, in each language. */
const NO_EXCEPTION_CLAIMS: ReadonlyArray<{ readonly page: string; readonly claim: string }> = [
  {
    page: 'docs/src/content/docs/persistence/overview.mdx',
    claim: 'over a valid file it builds nothing of persistence inside `create`, and over a file with such a key its startup fails',
  },
  {
    page: 'docs/src/content/docs/de/persistence/overview.mdx',
    claim: 'Über einer gültigen Datei baut es innerhalb von `create` nichts von der Persistence auf, und über einer Datei mit einem solchen Schlüssel scheitert sein Start',
  },
];

/** The overview's claim that the boot-time open off does not exempt the key, in each language. */
const SWITCH_OFF_CLAIMS: ReadonlyArray<{ readonly page: string; readonly claim: string }> = [
  {
    page: 'docs/src/content/docs/persistence/overview.mdx',
    claim: 'A key under `actor-ts.persistence` that nothing reads still fails the startup, with the switch off in the file or in code and with every store set in code',
  },
  {
    page: 'docs/src/content/docs/de/persistence/overview.mdx',
    claim: 'Ein Schlüssel unter `actor-ts.persistence`, den nichts liest, lässt den Start trotzdem scheitern, mit dem Schalter in der Datei oder im Code abgeschaltet und mit jedem Store im Code gesetzt',
  },
];

describe('the persistence pages say a key nothing reads fails the startup (#1729)', () => {
  test.each([...PAGES])('$page names the keys it says are refused, the ConfigError and the remedy', ({ page, refused, remedy }) => {
    const text = prose(readFileSync(join(REPOSITORY_ROOT, page), 'utf8'));

    for (const { key } of refused) expect(text, `${page} names ${key}`).toContain(`\`${key}\``);
    expect(text).toContain('`ConfigError`');
    expect(text).toContain(remedy);
  });

  test.each([...PAGES])('$page no longer says such a key is left alone', ({ page }) => {
    const text = prose(readFileSync(join(REPOSITORY_ROOT, page), 'utf8'));

    for (const warning of RETIRED_WARNINGS) expect(text).not.toMatch(warning);
  });

  test.each(PAGES.flatMap(({ page, refused }) => refused.map((claim) => ({ page, ...claim }))))(
    '$key, which $page names, is refused by the check, named',
    ({ key, hocon }) => {
      let refusal: unknown = null;
      try {
        refuseUnknownPersistenceKeys(Config.parseString(hocon));
      } catch (error) {
        refusal = error;
      }

      expect(refusal).toBeInstanceOf(ConfigError);
      expect((refusal as ConfigError).message).toStartWith(`Config at "${key}" is not a key `);
    },
  );

  test.each([...SWITCH_OFF_CLAIMS])('$page says the boot-time open off does not exempt the key', ({ page, claim }) => {
    expect(prose(readFileSync(join(REPOSITORY_ROOT, page), 'utf8'))).toContain(claim);
  });

  test.each([...NO_EXCEPTION_CLAIMS])('$page says the opt-out in code with nothing else is no exception', ({ page, claim }) => {
    expect(prose(readFileSync(join(REPOSITORY_ROOT, page), 'utf8'))).toContain(claim);
  });

  test('the retired-warning patterns refuse the sentences they were written against', () => {
    // Guards the guard: a pattern narrowed until it matches nothing would
    // leave the case above green over pages that still say it.
    expect('A misspelt key is not one of them.').toMatch(RETIRED_WARNINGS[0]!);
    expect('A misspelt key is not refused, because nothing reads it.').toMatch(RETIRED_WARNINGS[0]!);
    expect('Ein vertippter Schlüssel gehört nicht dazu.').toMatch(RETIRED_WARNINGS[1]!);
    expect('Ein vertippter Schlüssel wird nicht abgelehnt, weil niemand ihn liest.').toMatch(RETIRED_WARNINGS[1]!);
    expect('Off, nothing is resolved or opened until the first operation asks — the mistakes above then fail that operation rather than the startup')
      .toMatch(RETIRED_WARNINGS[2]!);
    expect('bis die erste Operation danach fragt — die Fehler oben lassen dann diese Operation scheitern statt des Starts')
      .toMatch(RETIRED_WARNINGS[3]!);
    expect('refusing the key opens none.  The one exception is a system that turns the switch off in code and sets no store')
      .toMatch(RETIRED_WARNINGS[4]!);
    expect('öffnet keinen.  Die eine Ausnahme ist ein System, das den Schalter im Code abschaltet und dort weder einen Store')
      .toMatch(RETIRED_WARNINGS[5]!);
    // And none of them refuses the sentences that replaced them.
    expect('— the other mistakes above then fail that operation').not.toMatch(RETIRED_WARNINGS[2]!);
    expect('— die übrigen Fehler oben lassen dann diese Operation').not.toMatch(RETIRED_WARNINGS[3]!);
    expect('That includes a system that turns the switch off in code and sets no store').not.toMatch(RETIRED_WARNINGS[4]!);
    expect('Das gilt auch für ein System, das den Schalter im Code abschaltet').not.toMatch(RETIRED_WARNINGS[5]!);
  });
});
