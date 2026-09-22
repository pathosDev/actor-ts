import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { mariaDbDialect } from '../../../src/persistence/relational/MariaDbDialect.js';
import { msSqlDialect } from '../../../src/persistence/relational/MsSqlDialect.js';
import { postgresDialect } from '../../../src/persistence/relational/PostgresDialect.js';
import { sqliteDialect } from '../../../src/persistence/relational/SqliteDialect.js';
import { RelationalDurableStateStore } from '../../../src/persistence/relational/RelationalDurableStateStore.js';
import { RelationalJournal } from '../../../src/persistence/relational/RelationalJournal.js';
import {
  COLLATION_SENSITIVE_COLUMNS,
  isBinaryCollation,
  type SqlDialect,
} from '../../../src/persistence/relational/SqlDialect.js';
import type { SqlExecutor, SqlPool, SqlResult } from '../../../src/persistence/relational/SqlPool.js';

/**
 * The startup collation advisory (#1412).
 *
 * A database created before #707 pinned a binary collation keeps the server's
 * case-folding default, and `CREATE TABLE IF NOT EXISTS` never revisits it —
 * so two persistence ids differing only in case are one event stream on
 * MariaDB and SQL Server and two everywhere else, and nothing said so.  The
 * store now reads its own tables back out of the catalogue on open and warns.
 *
 * What is provable here is the whole classification: the exact statement per
 * dialect, which collation names count as folding, which columns are read,
 * the `autoCreateTables` question, the per-column report, and that an
 * unreadable catalogue stays silent.  What is **not** provable here is that a
 * live server accepts the statement and returns those column names — that is
 * Docker-gated and lives in the two broker runners' collation scenarios.
 */

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/** One catalogue row, in the shape the dialects alias their output to. */
type CatalogueRow = {
  readonly column_name: string;
  readonly collation_name: string | null;
};

/**
 * Pool that records every statement and answers the catalogue read from a
 * per-table script.
 *
 * The byte-identity pattern `StorageIdentity.test.ts` uses: the point is not
 * to emulate a server but to see the exact SQL the store issued and to feed
 * back exactly the rows a server would, including the rows for columns the
 * advisory must ignore.
 */
class CollationPool implements SqlPool {
  readonly statements: Array<{ readonly sql: string; readonly params?: ReadonlyArray<unknown> }> = [];
  /** Table → catalogue rows.  A table with no entry answers empty, as an absent table does. */
  readonly catalogue = new Map<string, ReadonlyArray<CatalogueRow>>();
  /** When set, the catalogue read throws it — a role without `information_schema` rights. */
  catalogueFailure: Error | null = null;

  constructor(private readonly dialect: SqlDialect) {}

  async query(sql: string, params?: ReadonlyArray<unknown>): Promise<SqlResult> {
    this.statements.push(params === undefined ? { sql } : { sql, params });
    if (sql === this.dialect.columnCollationsSql?.()) {
      if (this.catalogueFailure !== null) throw this.catalogueFailure;
      const rows = this.catalogue.get(String(params?.[0])) ?? [];
      return { rows: rows as ReadonlyArray<Record<string, unknown>>, affectedRows: 0 };
    }
    return { rows: [], affectedRows: 0 };
  }

  /** Statements that are the catalogue read, in order. */
  catalogueReads(): ReadonlyArray<{ readonly sql: string; readonly params?: ReadonlyArray<unknown> }> {
    return this.statements.filter((statement) => statement.sql === this.dialect.columnCollationsSql?.());
  }

  async withTransaction<T>(body: (transaction: SqlExecutor) => Promise<T>): Promise<T> { return body(this); }
  async end(): Promise<void> {}
}

/**
 * Swap `console.warn` for the duration of one call and hand back what it saw
 * — the same shape `CachedSnapshotStore.test.ts` uses, and for the same
 * reason: an operator-built store has no `ActorSystem`, so the console *is*
 * the observable.
 */
const captureWarnings = async (body: () => Promise<void>): Promise<string[]> => {
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => { captured.push(String(args[0])); };
  try { await body(); } finally { console.warn = original; }
  return captured;
};

const journalOver = (pool: CollationPool, dialect: SqlDialect, autoCreateTables = true): RelationalJournal =>
  new RelationalJournal({
    storeName: 'CollationProbeJournal',
    dialect,
    ownsPool: false,
    autoCreateTables,
    openPool: async () => pool,
  });

const durableStateStoreOver = (pool: CollationPool, dialect: SqlDialect): RelationalDurableStateStore =>
  new RelationalDurableStateStore({
    storeName: 'CollationProbeStateStore',
    dialect,
    ownsPool: false,
    openPool: async () => pool,
  });

/** Rows for a table whose two collation-sensitive columns carry `collation`. */
const identityColumnsOn = (collation: string | null): ReadonlyArray<CatalogueRow> => [
  { column_name: 'persistence_id', collation_name: collation },
  { column_name: 'sequence_nr', collation_name: null },
  { column_name: 'tag', collation_name: collation },
];

const FOLDING = 'utf8mb4_general_ci';

describe('the catalogue statement is dialect-owned and exact', () => {
  test('MariaDB reads information_schema scoped to the connected schema', () => {
    // `TABLE_SCHEMA = DATABASE()` is the load-bearing half: without it the
    // same table name in another schema on the same server answers instead.
    // The aliases are the second half — information_schema shouts its column
    // names and the connector labels the rows exactly as asked.
    expect(norm(mariaDbDialect.columnCollationsSql!())).toBe(
      'SELECT COLUMN_NAME AS column_name, COLLATION_NAME AS collation_name '
      + 'FROM information_schema.COLUMNS '
      + 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    );
  });

  test('SQL Server reads sys.columns through OBJECT_ID', () => {
    expect(norm(msSqlDialect.columnCollationsSql!())).toBe(
      'SELECT c.name AS column_name, c.collation_name AS collation_name '
      + 'FROM sys.columns c '
      + 'WHERE c.object_id = OBJECT_ID(@p1)',
    );
  });

  test('the table name is a bound parameter, never interpolated', async () => {
    // An interpolated identifier would be the one place in this family where
    // a table name reaches the server as text rather than as a value, and the
    // statement would stop being one constant string per dialect.
    for (const dialect of [mariaDbDialect, msSqlDialect]) {
      const pool = new CollationPool(dialect);
      await journalOver(pool, dialect).highestSeq('probe');
      const reads = pool.catalogueReads();
      expect(reads.map((read) => read.params?.[0])).toEqual(['events', 'events_tags', 'events_meta']);
      for (const read of reads) {
        expect(read.sql).toBe(dialect.columnCollationsSql!());
        expect(read.sql).not.toContain('events');
      }
    }
  });

  test('Postgres and SQLite declare none — TEXT has no collation to get wrong', () => {
    expect(postgresDialect.columnCollationsSql).toBeUndefined();
    expect(sqliteDialect.columnCollationsSql).toBeUndefined();
  });
});

describe('classification is binary-ness, not the collation this project pins (#1412 F1)', () => {
  test('every binary spelling any of these servers offers is silent', () => {
    // The rule that would be wrong is "not the collation our DDL writes".
    // `utf8mb4_nopad_bin` is what this project's own MariaDB page points
    // operators at — stricter than the pin — `utf8mb4_0900_bin` is MySQL 8's,
    // and SQL Server has a whole BIN2 family; nagging any of them on every
    // start is how an advisory gets ignored.
    for (const collation of [
      'utf8mb4_bin', 'utf8mb4_nopad_bin', 'utf8mb4_0900_bin', 'utf8_bin', 'binary',
      'Latin1_General_100_BIN2', 'Latin1_General_BIN', 'Latin1_General_BIN2',
      'Japanese_XJIS_140_BIN2', 'utf8mb4_0900_bin'.toUpperCase(),
    ]) {
      expect(isBinaryCollation(collation)).toBe(true);
    }
  });

  test('every folding default these servers ship is flagged', () => {
    for (const collation of [
      'utf8mb4_general_ci', 'utf8mb4_0900_ai_ci', 'utf8mb4_unicode_520_ci', 'latin1_swedish_ci',
      'SQL_Latin1_General_CP1_CI_AS', 'Latin1_General_100_CI_AI_SC', 'Latin1_General_CS_AS',
    ]) {
      expect(isBinaryCollation(collation)).toBe(false);
    }
  });

  test('a case-sensitive-but-accent-folding collation is not binary', () => {
    // `_CS_AS` compares case exactly and still folds nothing else the way a
    // code-point comparison does — width, kana and the supplementary-character
    // rules all still differ from every other backend.
    expect(isBinaryCollation('Latin1_General_100_CS_AS')).toBe(false);
  });
});

describe('only the columns whose comparison is load-bearing are read', () => {
  test('persistence_id and tag, and nothing else', () => {
    expect([...COLLATION_SENSITIVE_COLUMNS].sort()).toEqual(['persistence_id', 'tag']);
  });

  test('a folding payload, tag list or minted identity stays silent', async () => {
    // The DDL leaves these on the server default deliberately — they are
    // values, never compared as strings — so flagging them would report the
    // intended state as a defect.
    const pool = new CollationPool(mariaDbDialect);
    for (const table of ['events', 'events_tags', 'events_meta']) {
      pool.catalogue.set(table, [
        { column_name: 'persistence_id', collation_name: 'utf8mb4_bin' },
        { column_name: 'tag', collation_name: 'utf8mb4_bin' },
        { column_name: 'payload', collation_name: FOLDING },
        { column_name: 'tags', collation_name: FOLDING },
        { column_name: 'identity', collation_name: FOLDING },
      ]);
    }

    const warnings = await captureWarnings(async () => {
      await journalOver(pool, mariaDbDialect).highestSeq('probe');
    });

    expect(warnings).toEqual([]);
  });
});

describe('the warning names table, column and collation found', () => {
  test('a stock MariaDB schema is reported per column across all three tables', async () => {
    const pool = new CollationPool(mariaDbDialect);
    for (const table of ['events', 'events_tags', 'events_meta']) {
      pool.catalogue.set(table, identityColumnsOn(FOLDING));
    }

    const warnings = await captureWarnings(async () => {
      await journalOver(pool, mariaDbDialect).highestSeq('probe');
    });

    expect(warnings).toHaveLength(1);
    const warning = warnings[0]!;
    // The needle the broker scenarios filter on.
    expect(warning).toContain('on a case-folding collation');
    expect(warning).toContain('CollationProbeJournal');
    for (const offender of [
      'events.persistence_id (utf8mb4_general_ci)',
      'events.tag (utf8mb4_general_ci)',
      'events_tags.persistence_id (utf8mb4_general_ci)',
      'events_tags.tag (utf8mb4_general_ci)',
      'events_meta.persistence_id (utf8mb4_general_ci)',
    ]) {
      expect(warning).toContain(offender);
    }
    expect(warning).toContain('https://actor-ts.dev/persistence/journals/mariadb/#migrating-an-existing-schema');
  });

  test('SQL Server points at its own page, with its own found collation', async () => {
    const pool = new CollationPool(msSqlDialect);
    pool.catalogue.set('events', identityColumnsOn('SQL_Latin1_General_CP1_CI_AS'));

    const warnings = await captureWarnings(async () => {
      await journalOver(pool, msSqlDialect).highestSeq('probe');
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('events.persistence_id (SQL_Latin1_General_CP1_CI_AS)');
    expect(warnings[0]).toContain('https://actor-ts.dev/persistence/journals/mssql/#migrating-an-existing-schema');
  });

  test('the page and anchor the message points at exist in the tree', () => {
    // The URL is built from `dialect.name`, which happens to be the journal
    // page's slug.  That coincidence is what this pins: a dialect renamed, or
    // a heading reworded, sends operators to a 404 at exactly the moment they
    // need the recipe, and nothing else in the suite would notice.
    for (const dialect of [mariaDbDialect, msSqlDialect]) {
      const page = readFileSync(
        join(import.meta.dir, '..', '..', '..', 'docs', 'src', 'content', 'docs',
          'persistence', 'journals', `${dialect.name}.mdx`),
        'utf8',
      );
      expect(page).toContain('### Migrating an existing schema');
    }
  });

  test('a binary schema says nothing at all', async () => {
    const pool = new CollationPool(mariaDbDialect);
    for (const table of ['events', 'events_tags', 'events_meta']) {
      // The NO PAD spelling, not the one the DDL writes — a deliberate,
      // stricter operator choice must not produce a line.
      pool.catalogue.set(table, identityColumnsOn('utf8mb4_nopad_bin'));
    }

    const warnings = await captureWarnings(async () => {
      await journalOver(pool, mariaDbDialect).highestSeq('probe');
    });

    expect(warnings).toEqual([]);
  });
});

describe('a half-migrated schema is detectable per column (#1507)', () => {
  test('only the un-migrated column is named, and the mixed state is called out', async () => {
    // The state both migration recipes pass through: `events` converted,
    // `events_tags` not.  On SQL Server the tag-query join across those two
    // columns is error 468 outright; on MariaDB it loses the index.  A probe
    // that reported one verdict per store rather than per column could not
    // tell this from "nothing was ever migrated".
    const pool = new CollationPool(msSqlDialect);
    pool.catalogue.set('events', identityColumnsOn('Latin1_General_100_BIN2'));
    pool.catalogue.set('events_tags', identityColumnsOn('SQL_Latin1_General_CP1_CI_AS'));
    pool.catalogue.set('events_meta', identityColumnsOn('Latin1_General_100_BIN2'));

    const warnings = await captureWarnings(async () => {
      await journalOver(pool, msSqlDialect).highestSeq('probe');
    });

    expect(warnings).toHaveLength(1);
    const warning = warnings[0]!;
    expect(warning).toContain('events_tags.persistence_id (SQL_Latin1_General_CP1_CI_AS)');
    expect(warning).toContain('events_tags.tag (SQL_Latin1_General_CP1_CI_AS)');
    expect(warning).not.toContain('events.persistence_id');
    expect(warning).toContain('half migrated');
    expect(warning).toContain('error 468');
  });

  test('a uniformly folding schema is not reported as half migrated', async () => {
    const pool = new CollationPool(mariaDbDialect);
    for (const table of ['events', 'events_tags', 'events_meta']) {
      pool.catalogue.set(table, identityColumnsOn(FOLDING));
    }

    const warnings = await captureWarnings(async () => {
      await journalOver(pool, mariaDbDialect).highestSeq('probe');
    });

    expect(warnings[0]).not.toContain('half migrated');
  });

  test('a tagsTable pointed at a new table beside a legacy events is the permanent case', async () => {
    const pool = new CollationPool(msSqlDialect);
    pool.catalogue.set('events', identityColumnsOn('SQL_Latin1_General_CP1_CI_AS'));
    pool.catalogue.set('projection_tags', identityColumnsOn('Latin1_General_100_BIN2'));
    pool.catalogue.set('events_meta', identityColumnsOn('SQL_Latin1_General_CP1_CI_AS'));

    const warnings = await captureWarnings(async () => {
      const journal = new RelationalJournal({
        storeName: 'CollationProbeJournal',
        dialect: msSqlDialect,
        ownsPool: false,
        tagsTable: 'projection_tags',
        openPool: async () => pool,
      });
      await journal.highestSeq('probe');
    });

    expect(pool.catalogueReads().map((read) => read.params?.[0]))
      .toEqual(['events', 'projection_tags', 'events_meta']);
    expect(warnings[0]).toContain('events.persistence_id');
    expect(warnings[0]).toContain('half migrated');
  });
});

describe('the probe is not gated on autoCreateTables (#1412, FORK 2)', () => {
  test('an operator-managed schema is probed and warned about', async () => {
    // The population most likely to still be on the folding default is the
    // one that manages its own schema, and a read-only catalogue query needs
    // no DDL rights — so skipping the probe here would silence exactly the
    // deployment the advisory is for.
    const pool = new CollationPool(mariaDbDialect);
    pool.catalogue.set('events', identityColumnsOn(FOLDING));

    const warnings = await captureWarnings(async () => {
      await journalOver(pool, mariaDbDialect, false).highestSeq('probe');
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('events.persistence_id (utf8mb4_general_ci)');
    // …and still no DDL: the framework was told not to touch the schema.
    expect(pool.statements.some((statement) => /CREATE TABLE/i.test(statement.sql))).toBe(false);
  });
});

describe('unknown is not evidence', () => {
  test('a catalogue read that fails leaves the store working and says nothing', async () => {
    const pool = new CollationPool(mariaDbDialect);
    pool.catalogueFailure = Object.assign(
      new Error("SELECT command denied to user 'app'@'%' for table 'COLUMNS'"),
      { errno: 1142 },
    );

    const warnings = await captureWarnings(async () => {
      expect(await journalOver(pool, mariaDbDialect).highestSeq('probe')).toBe(0);
    });

    expect(warnings).toEqual([]);
  });

  test('a table the catalogue does not know yet is silent', async () => {
    const pool = new CollationPool(mariaDbDialect);

    const warnings = await captureWarnings(async () => {
      await journalOver(pool, mariaDbDialect).highestSeq('probe');
    });

    expect(pool.catalogueReads()).toHaveLength(3);
    expect(warnings).toEqual([]);
  });
});

describe('cost: once per table per store open, never per operation', () => {
  test('a second operation issues no further catalogue read', async () => {
    const pool = new CollationPool(mariaDbDialect);
    pool.catalogue.set('durable_state', identityColumnsOn(FOLDING));
    const store = durableStateStoreOver(pool, mariaDbDialect);

    const warnings = await captureWarnings(async () => {
      await store.load('probe');
      await store.load('probe');
      await store.delete('probe');
    });

    // One table, one read, one warning — the store owns `durable_state` alone.
    expect(pool.catalogueReads()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  test('the three store families read disjoint tables, so one database is read once per table', async () => {
    const pool = new CollationPool(mariaDbDialect);

    await captureWarnings(async () => {
      await journalOver(pool, mariaDbDialect).highestSeq('probe');
      await durableStateStoreOver(pool, mariaDbDialect).load('probe');
    });

    expect(pool.catalogueReads().map((read) => read.params?.[0]))
      .toEqual(['events', 'events_tags', 'events_meta', 'durable_state']);
  });
});
