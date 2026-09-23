/**
 * A drift guard over the *claim* behind the offset-key budget (#1507).
 *
 * Both mirrors of `persistence/projections` opened the composite-key section
 * by saying that **every** relational dialect declares
 * `durable_state.persistence_id` as `VARCHAR(255)` / `NVARCHAR(255)`, and the
 * same section refuted it three paragraphs further down: two of the four
 * declare `TEXT`.  Nothing caught that, because nothing read the dialects and
 * the page together — which is the whole failure mode, since a reader who
 * trusts the opening sentence concludes either that their Postgres deployment
 * was already truncating cursors or that the refusal is the database's rule
 * rather than the framework's.
 *
 * Correcting the sentence alone would leave the hole open for the next
 * dialect.  So this file reads the four `*Dialect.ts` files, resolves each
 * one's `durableStateDdl` down to the declared type of `persistence_id`, and
 * holds both pages to what it finds.  Every assertion is keyed on a semantic
 * marker rather than a sentence, so a rewrite that keeps the meaning keeps
 * passing; the one edit it exists to prevent is restoring the claim that all
 * four columns are narrow.
 *
 * It also pins the operator-visible half, because that is the other thing the
 * page now promises on the framework's behalf: a refused cursor load moves
 * `persistence_projection_failures_total` with `reason="poll"` and raises
 * `persistence_projection_stalled`.  `ProjectionCursorLoadVisibility.test.ts`
 * proves that by execution; this holds the prose to it.
 *
 * Same shape as `tests/unit/cluster/GossipReplayBoundDocumented.test.ts`.
 *
 * Refs #1507, #1070.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');

const ENGLISH_PAGE = 'docs/src/content/docs/persistence/projections.mdx';
const GERMAN_PAGE = 'docs/src/content/docs/de/persistence/projections.mdx';

/** The English heading of the section under assertion, and its German mirror. */
const ENGLISH_HEADING = '### The composite key has a length budget';
const GERMAN_HEADING = '### Der zusammengesetzte Schlüssel hat ein Längenbudget';

/**
 * What each dialect declares for `durable_state.persistence_id`, measured
 * from the files rather than restated — the expectation here is only the
 * *shape* of the answer, and the test below fails if a file stops matching
 * its entry in either direction.
 */
const EXPECTED_COLUMN_TYPES: Readonly<Record<string, string>> = {
  'src/persistence/relational/MariaDbDialect.ts': 'VARCHAR(255)',
  'src/persistence/relational/MsSqlDialect.ts': 'NVARCHAR(255)',
  'src/persistence/relational/PostgresDialect.ts': 'TEXT',
  'src/persistence/relational/SqliteDialect.ts': 'TEXT',
};

const read = (path: string): string => readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

/**
 * The declared type of `persistence_id` inside a dialect's `durableStateDdl`.
 *
 * Scoped to that one DDL on purpose: every dialect declares the column in
 * four or five tables, and the journal's copy is not the one the offset store
 * writes to.  `${KEY_TEXT}` is resolved from the file's own constant, since
 * that indirection is exactly where the two narrow dialects keep the width.
 */
function durableStatePersistenceIdType(source: string): string {
  const start = source.indexOf('durableStateDdl:');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n  ],', start);
  expect(end).toBeGreaterThan(start);

  const keyText = /const KEY_TEXT = '([^']+)'/.exec(source);
  const block = source
    .slice(start, end)
    .replaceAll('${KEY_TEXT}', keyText === null ? '<no KEY_TEXT>' : keyText[1]);

  const declaration = /\[?persistence_id\]?\s+([A-Z]+(?:\(\d+\))?)/.exec(block);
  expect(declaration).not.toBeNull();
  return declaration![1];
}

/** The `### ` section that starts at `heading`, up to the next heading. */
function sectionOf(page: string, heading: string): string {
  const start = page.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const rest = page.slice(start + heading.length);
  const next = rest.search(/\n##+ /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the offset-key budget — the dialects behind the documented claim', () => {
  test('two of the four relational dialects declare the column narrow, two declare it TEXT', () => {
    const measured = Object.fromEntries(
      Object.keys(EXPECTED_COLUMN_TYPES).map(
        (path) => [path, durableStatePersistenceIdType(read(path))] as const,
      ),
    );

    expect(measured).toEqual(EXPECTED_COLUMN_TYPES);
    // The count is the claim the prose makes, so it is asserted as a count
    // rather than left implicit in the table above.
    const text = Object.values(measured).filter((type) => type === 'TEXT');
    expect(text).toHaveLength(2);
    expect(Object.keys(measured)).toHaveLength(4);
  });
});

describe('the offset-key budget — both pages agree with the dialects', () => {
  const pages: ReadonlyArray<readonly [string, string, string]> = [
    ['English', ENGLISH_PAGE, ENGLISH_HEADING],
    ['German', GERMAN_PAGE, GERMAN_HEADING],
  ];

  for (const [language, path, heading] of pages) {
    describe(language, () => {
      const section = sectionOf(read(path), heading);

      test('does not claim that every relational dialect declares the narrow width', () => {
        // The exact wrong claim, in each language.  Keyed on the quantifier
        // because that is the word that made the sentence false: the widths
        // themselves are correct for the two dialects that carry them, and
        // the section has to keep naming them.
        expect(section).not.toMatch(/every relational dialect/i);
        expect(section).not.toMatch(/jeder relationale Dialekt/i);
      });

      test('names all four dialects and the type each of them declares', () => {
        expect(section).toContain('MariaDbDialect');
        expect(section).toContain('MsSqlDialect');
        expect(section).toContain('PostgresDialect');
        expect(section).toContain('SqliteDialect');
        expect(section).toContain('VARCHAR(255)');
        expect(section).toContain('NVARCHAR(255)');
        expect(section).toContain('`TEXT`');
      });

      test('attaches `TEXT` to the two dialects that declare it, not merely mentions it', () => {
        // Presence alone would be satisfied by the bullet further down, which
        // said `TEXT` all along while the opening sentence contradicted it —
        // so this asserts proximity: the first `TEXT` in the section has to
        // follow both dialect names closely enough to be about them.
        const postgres = section.indexOf('PostgresDialect');
        const sqlite = section.indexOf('SqliteDialect');
        const text = section.indexOf('`TEXT`');
        expect(text).toBeGreaterThan(sqlite);
        expect(sqlite).toBeGreaterThan(postgres);
        expect(text - postgres).toBeLessThan(120);
      });

      test('says the bound is a portability floor rather than a column constraint', () => {
        // Without this the corrected sentence reads as an argument *against*
        // the bound on Postgres and SQLite, which is the opposite of why it
        // is applied uniformly.
        expect(section).toMatch(/portability floor|Portabilitätsuntergrenze/);
      });

      test('names what an operator sees when a cursor load is refused', () => {
        expect(section).toContain('persistence_projection_failures_total');
        expect(section).toContain('persistence_projection_stalled');
        expect(section).toContain('reason="poll"');
      });
    });
  }
});
