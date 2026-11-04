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

/** The warnings the pages carried until #1729, in both languages. */
const RETIRED_WARNINGS: readonly RegExp[] = [
  /misspelt key is not (?:one of them|refused)/i,
  /vertippter Schlüssel (?:gehört nicht dazu|wird nicht abgelehnt)/i,
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

  test('the retired-warning patterns refuse the sentences they were written against', () => {
    // Guards the guard: a pattern narrowed until it matches nothing would
    // leave the case above green over pages that still say it.
    expect('A misspelt key is not one of them.').toMatch(RETIRED_WARNINGS[0]!);
    expect('A misspelt key is not refused, because nothing reads it.').toMatch(RETIRED_WARNINGS[0]!);
    expect('Ein vertippter Schlüssel gehört nicht dazu.').toMatch(RETIRED_WARNINGS[1]!);
    expect('Ein vertippter Schlüssel wird nicht abgelehnt, weil niemand ihn liest.').toMatch(RETIRED_WARNINGS[1]!);
  });
});
