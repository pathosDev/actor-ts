import { describe, expect, test } from 'bun:test';

import { MariaDbJournal } from '../../../../src/persistence/journals/MariaDbJournal.js';
import { MariaDbJournalOptions } from '../../../../src/persistence/journals/MariaDbJournalOptions.js';
import { MsSqlJournal } from '../../../../src/persistence/journals/MsSqlJournal.js';
import { MsSqlJournalOptions } from '../../../../src/persistence/journals/MsSqlJournalOptions.js';
import { FakeMariaDbPool } from './FakeMariaDbPool.js';
import { FakeMsSqlPool } from './FakeMsSqlPool.js';

/**
 * The startup collation advisory (#1412) end to end against the two fake
 * pools, which is as close to the real thing as this machine gets.
 *
 * Both fakes now record what collation each `CREATE TABLE` declared and answer
 * the catalogue read from it, with an uncollated character column taking the
 * server's folding default and a guarded `CREATE` on an existing table staying
 * a no-op — which is precisely the #707 trap: a table created before the pin
 * keeps the collation it was created with, however often the store re-issues
 * its DDL.
 *
 * So these two cases are the in-process twins of the Docker scenarios in
 * `tests/integration/brokers/{mariadb,mssql}/Runner.ts`.  What they cannot
 * show — that a live server accepts `information_schema.COLUMNS` /
 * `sys.columns` and labels the rows as asked — is exactly what those
 * scenarios are for.
 */

const captureWarnings = async (body: () => Promise<void>): Promise<string[]> => {
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => { captured.push(String(args[0])); };
  try { await body(); } finally { console.warn = original; }
  return captured;
};

describe('MariaDB — the fake pool answers the catalogue read', () => {
  test('a schema this framework created is silent', async () => {
    const pool = new FakeMariaDbPool();
    const journal = new MariaDbJournal(MariaDbJournalOptions.create().withPool(pool));

    const warnings = await captureWarnings(async () => {
      await journal.append('account-1', [{ event: 'created', tags: ['ledger'] }], 0);
    });

    // The DDL pinned `utf8mb4_bin` on `persistence_id` and `tag`; `payload`
    // and `tags` came back on the folding server default and are values, not
    // comparisons, so neither is a finding.
    expect(warnings).toEqual([]);
    expect(pool.log.filter((sql) => sql.startsWith('SELECT COLUMN_NAME AS column_name'))).toHaveLength(3);
    await journal.close();
  });

  test('a table created before the pin is found and named', async () => {
    const pool = new FakeMariaDbPool();
    // A pre-#707 schema: the same DDL without the COLLATE clause.  The store's
    // own `CREATE TABLE IF NOT EXISTS` then does nothing, which is the defect.
    await pool.query(`CREATE TABLE IF NOT EXISTS events (
           persistence_id VARCHAR(255) NOT NULL,
           sequence_nr    BIGINT NOT NULL,
           payload        LONGTEXT NOT NULL,
           tags           TEXT,
           timestamp      BIGINT NOT NULL
         )`);
    const journal = new MariaDbJournal(MariaDbJournalOptions.create().withPool(pool));

    const warnings = await captureWarnings(async () => {
      await journal.append('account-1', [{ event: 'created', tags: ['ledger'] }], 0);
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('events.persistence_id (utf8mb4_general_ci)');
    expect(warnings[0]).toContain('on a case-folding collation');
    // `events_tags` was created by the store, with the pin — so this is the
    // half-migrated shape, and the advisory says so (#1507).
    expect(warnings[0]).not.toContain('events_tags.persistence_id');
    expect(warnings[0]).toContain('half migrated');
    await journal.close();
  });
});

describe('SQL Server — the fake pool answers the catalogue read', () => {
  test('a schema this framework created is silent', async () => {
    const pool = new FakeMsSqlPool();
    const journal = new MsSqlJournal(MsSqlJournalOptions.create().withPool(pool));

    const warnings = await captureWarnings(async () => {
      await journal.append('account-1', [{ event: 'created', tags: ['ledger'] }], 0);
    });

    expect(warnings).toEqual([]);
    expect(pool.log.filter((sql) => sql.startsWith('SELECT c.name AS column_name'))).toHaveLength(3);
    await journal.close();
  });

  test('a table created before the pin is found and named', async () => {
    const pool = new FakeMsSqlPool();
    pool.execute(`IF OBJECT_ID(N'[events]', N'U') IS NULL
         CREATE TABLE [events] (
           [persistence_id] NVARCHAR(255) NOT NULL,
           [sequence_nr]    BIGINT NOT NULL,
           [payload]        NVARCHAR(MAX) NOT NULL,
           [tags]           NVARCHAR(MAX) NULL,
           [timestamp]      BIGINT NOT NULL
         )`, new Map());
    const journal = new MsSqlJournal(MsSqlJournalOptions.create().withPool(pool));

    const warnings = await captureWarnings(async () => {
      await journal.append('account-1', [{ event: 'created', tags: ['ledger'] }], 0);
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('events.persistence_id (SQL_Latin1_General_CP1_CI_AS)');
    // The state that makes a tag query fail outright on this backend.
    expect(warnings[0]).toContain('error 468');
    await journal.close();
  });
});
