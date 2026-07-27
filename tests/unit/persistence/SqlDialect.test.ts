import { describe, expect, test } from 'bun:test';
import { mariaDbDialect } from '../../../src/persistence/relational/MariaDbDialect.js';
import { msSqlDialect } from '../../../src/persistence/relational/MsSqlDialect.js';
import { postgresDialect } from '../../../src/persistence/relational/PostgresDialect.js';
import { expandPlaceholders } from '../../../src/persistence/relational/SqlDialect.js';

/**
 * Golden statements for the SQL dialects (#389).
 *
 * The relational bases replaced two hand-written store trios; these are the
 * exact statements those trios emitted, so the test is what proves the
 * refactor did not quietly reword anyone's SQL.  Beyond that it keeps the
 * dialects honest going forward: a change to a statement has to be made
 * deliberately, here, rather than slipping in as a side effect.
 *
 * Whitespace is normalized — indentation of a template literal is an artifact
 * of where it sits in the source, not part of the statement.
 */
const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const tables = { events: 'events', tags: 'events_tags', meta: 'events_meta' };

describe('postgresDialect — placeholders and error codes', () => {
  test('placeholders are one-based $n', () => {
    expect(postgresDialect.placeholder(0)).toBe('$1');
    expect(postgresDialect.placeholder(4)).toBe('$5');
  });

  test('row limiting uses LIMIT', () => {
    expect(postgresDialect.rowLimit(1)).toBe('LIMIT 1');
  });

  test('a unique violation is SQLSTATE 23505', () => {
    // Matching the code, not the message, is what lets CockroachDB and
    // YugabyteDB reuse this dialect — they reword the message.
    expect(postgresDialect.isDuplicateKeyError({ code: '23505' })).toBe(true);
    expect(postgresDialect.isDuplicateKeyError({ code: '23503' })).toBe(false);
    expect(postgresDialect.isDuplicateKeyError(new Error('duplicate key'))).toBe(false);
  });
});

describe('postgresDialect — golden DML', () => {
  test('tag insert skips duplicates via ON CONFLICT DO NOTHING', () => {
    expect(norm(postgresDialect.insertTagSql('events_tags'))).toBe(
      'INSERT INTO events_tags(persistence_id, sequence_nr, tag, timestamp) '
      + 'VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    );
  });

  test('deleted_to upsert is monotonic via GREATEST', () => {
    expect(norm(postgresDialect.upsertDeletedToSql('events_meta'))).toBe(
      'INSERT INTO events_meta(persistence_id, deleted_to) VALUES ($1, $2) '
      + 'ON CONFLICT (persistence_id) DO UPDATE SET '
      + 'deleted_to = GREATEST(events_meta.deleted_to, EXCLUDED.deleted_to)',
    );
  });

  test('snapshot upsert overwrites payload and timestamp', () => {
    expect(norm(postgresDialect.upsertSnapshotSql('snapshots'))).toBe(
      'INSERT INTO snapshots(persistence_id, sequence_nr, payload, timestamp) VALUES ($1, $2, $3, $4) '
      + 'ON CONFLICT (persistence_id, sequence_nr) DO UPDATE SET '
      + 'payload = EXCLUDED.payload, timestamp = EXCLUDED.timestamp',
    );
  });

  test('keepN prune binds the persistence id once and reuses $1', () => {
    const prune = postgresDialect.pruneSnapshotsStatement('snapshots');
    expect(norm(prune.sql)).toBe(
      'DELETE FROM snapshots WHERE persistence_id = $1 AND sequence_nr NOT IN ( '
      + 'SELECT sequence_nr FROM snapshots WHERE persistence_id = $1 ORDER BY sequence_nr DESC LIMIT $2)',
    );
    expect(prune.params('account-1', 2)).toEqual(['account-1', 2]);
  });

  test('durable-state insert is guarded, so a collision is zero affected rows', () => {
    expect(norm(postgresDialect.insertStateSql('durable_state'))).toBe(
      'INSERT INTO durable_state(persistence_id, revision, payload, timestamp) VALUES ($1, $2, $3, $4) '
      + 'ON CONFLICT (persistence_id) DO NOTHING',
    );
    expect(postgresDialect.stateInsertConflictSignal).toBe('affected-rows');
  });
});

describe('postgresDialect — golden DDL', () => {
  test('journal DDL is three tables plus two separate indexes', () => {
    expect(postgresDialect.journalDdl(tables).map(norm)).toEqual([
      'CREATE TABLE IF NOT EXISTS events ( persistence_id TEXT NOT NULL, sequence_nr BIGINT NOT NULL, '
      + 'payload TEXT NOT NULL, tags TEXT, timestamp BIGINT NOT NULL, '
      + 'PRIMARY KEY (persistence_id, sequence_nr) )',
      'CREATE INDEX IF NOT EXISTS idx_events_pid ON events(persistence_id)',
      'CREATE TABLE IF NOT EXISTS events_tags ( persistence_id TEXT NOT NULL, sequence_nr BIGINT NOT NULL, '
      + 'tag TEXT NOT NULL, timestamp BIGINT NOT NULL, '
      + 'PRIMARY KEY (tag, timestamp, persistence_id, sequence_nr) )',
      'CREATE INDEX IF NOT EXISTS idx_events_tags_pid_seq ON events_tags(persistence_id, sequence_nr)',
      'CREATE TABLE IF NOT EXISTS events_meta ( persistence_id TEXT PRIMARY KEY, deleted_to BIGINT NOT NULL )',
    ]);
  });

  test('snapshot and durable-state DDL', () => {
    expect(postgresDialect.snapshotDdl('snapshots').map(norm)).toEqual([
      'CREATE TABLE IF NOT EXISTS snapshots ( persistence_id TEXT NOT NULL, sequence_nr BIGINT NOT NULL, '
      + 'payload TEXT NOT NULL, timestamp BIGINT NOT NULL, PRIMARY KEY (persistence_id, sequence_nr) )',
    ]);
    expect(postgresDialect.durableStateDdl('durable_state').map(norm)).toEqual([
      'CREATE TABLE IF NOT EXISTS durable_state ( persistence_id TEXT PRIMARY KEY, revision BIGINT NOT NULL, '
      + 'payload TEXT NOT NULL, timestamp BIGINT NOT NULL )',
    ]);
  });
});

describe('mariaDbDialect — placeholders and error codes', () => {
  test('placeholders are positional question marks', () => {
    expect(mariaDbDialect.placeholder(0)).toBe('?');
    expect(mariaDbDialect.placeholder(9)).toBe('?');
  });

  test('row limiting uses LIMIT', () => {
    expect(mariaDbDialect.rowLimit(1)).toBe('LIMIT 1');
  });

  test('a duplicate key is errno 1062 / ER_DUP_ENTRY', () => {
    expect(mariaDbDialect.isDuplicateKeyError({ errno: 1062 })).toBe(true);
    expect(mariaDbDialect.isDuplicateKeyError({ code: 'ER_DUP_ENTRY' })).toBe(true);
    expect(mariaDbDialect.isDuplicateKeyError({ errno: 1048 })).toBe(false);
  });
});

describe('mariaDbDialect — golden DML', () => {
  test('tag insert skips duplicates via INSERT IGNORE', () => {
    expect(norm(mariaDbDialect.insertTagSql('events_tags'))).toBe(
      'INSERT IGNORE INTO events_tags(persistence_id, sequence_nr, tag, timestamp) VALUES (?, ?, ?, ?)',
    );
  });

  test('deleted_to upsert is monotonic via GREATEST', () => {
    expect(norm(mariaDbDialect.upsertDeletedToSql('events_meta'))).toBe(
      'INSERT INTO events_meta(persistence_id, deleted_to) VALUES (?, ?) '
      + 'ON DUPLICATE KEY UPDATE deleted_to = GREATEST(deleted_to, VALUES(deleted_to))',
    );
  });

  test('snapshot upsert overwrites payload and timestamp', () => {
    expect(norm(mariaDbDialect.upsertSnapshotSql('snapshots'))).toBe(
      'INSERT INTO snapshots(persistence_id, sequence_nr, payload, timestamp) VALUES (?, ?, ?, ?) '
      + 'ON DUPLICATE KEY UPDATE payload = VALUES(payload), timestamp = VALUES(timestamp)',
    );
  });

  test('keepN prune wraps the subquery in a derived table and binds the id twice', () => {
    const prune = mariaDbDialect.pruneSnapshotsStatement('snapshots');
    // MySQL/MariaDB reject LIMIT inside a bare IN (SELECT …) against the table
    // being deleted from, so the subquery has to be materialized.
    expect(norm(prune.sql)).toBe(
      'DELETE FROM snapshots WHERE persistence_id = ? AND sequence_nr NOT IN ( '
      + 'SELECT keep_seq FROM ( '
      + 'SELECT sequence_nr AS keep_seq FROM snapshots WHERE persistence_id = ? ORDER BY sequence_nr DESC LIMIT ? '
      + ') AS keep)',
    );
    expect(prune.params('account-1', 2)).toEqual(['account-1', 'account-1', 2]);
  });

  test('durable-state insert is unguarded, so a collision throws', () => {
    expect(norm(mariaDbDialect.insertStateSql('durable_state'))).toBe(
      'INSERT INTO durable_state(persistence_id, revision, payload, timestamp) VALUES (?, ?, ?, ?)',
    );
    expect(mariaDbDialect.stateInsertConflictSignal).toBe('duplicate-key-error');
  });
});

describe('mariaDbDialect — golden DDL', () => {
  test('journal DDL is three tables with inline indexes', () => {
    // `CREATE INDEX IF NOT EXISTS` is not portable across MariaDB/MySQL
    // versions, so indexes are declared inside CREATE TABLE.
    expect(mariaDbDialect.journalDdl(tables).map(norm)).toEqual([
      'CREATE TABLE IF NOT EXISTS events ( persistence_id VARCHAR(255) NOT NULL, sequence_nr BIGINT NOT NULL, '
      + 'payload LONGTEXT NOT NULL, tags TEXT, timestamp BIGINT NOT NULL, '
      + 'PRIMARY KEY (persistence_id, sequence_nr), INDEX idx_events_pid (persistence_id) )',
      'CREATE TABLE IF NOT EXISTS events_tags ( persistence_id VARCHAR(255) NOT NULL, sequence_nr BIGINT NOT NULL, '
      + 'tag VARCHAR(255) NOT NULL, timestamp BIGINT NOT NULL, '
      + 'PRIMARY KEY (tag, timestamp, persistence_id, sequence_nr), '
      + 'INDEX idx_events_tags_pid_seq (persistence_id, sequence_nr) )',
      'CREATE TABLE IF NOT EXISTS events_meta ( persistence_id VARCHAR(255) NOT NULL, deleted_to BIGINT NOT NULL, '
      + 'PRIMARY KEY (persistence_id) )',
    ]);
  });

  test('snapshot and durable-state DDL', () => {
    expect(mariaDbDialect.snapshotDdl('snapshots').map(norm)).toEqual([
      'CREATE TABLE IF NOT EXISTS snapshots ( persistence_id VARCHAR(255) NOT NULL, sequence_nr BIGINT NOT NULL, '
      + 'payload LONGTEXT NOT NULL, timestamp BIGINT NOT NULL, PRIMARY KEY (persistence_id, sequence_nr) )',
    ]);
    expect(mariaDbDialect.durableStateDdl('durable_state').map(norm)).toEqual([
      'CREATE TABLE IF NOT EXISTS durable_state ( persistence_id VARCHAR(255) NOT NULL, revision BIGINT NOT NULL, '
      + 'payload LONGTEXT NOT NULL, timestamp BIGINT NOT NULL, PRIMARY KEY (persistence_id) )',
    ]);
  });
});

describe('msSqlDialect — placeholders, row limiting and error numbers', () => {
  test('placeholders are named @pN, which lets a statement reuse one', () => {
    // The reuse is what makes the keepN prune bind the persistence id once
    // where the positional dialects have to bind it twice.
    expect(msSqlDialect.placeholder(0)).toBe('@p1');
    expect(msSqlDialect.placeholder(4)).toBe('@p5');
  });

  test('row limiting uses the ANSI OFFSET/FETCH tail — T-SQL has no LIMIT', () => {
    expect(msSqlDialect.rowLimit(1)).toBe('OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY');
    expect(msSqlDialect.rowLimit(5)).toBe('OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY');
  });

  test('a duplicate key is error 2627 or 2601, wrapped or not', () => {
    expect(msSqlDialect.isDuplicateKeyError({ number: 2627 })).toBe(true);
    expect(msSqlDialect.isDuplicateKeyError({ number: 2601 })).toBe(true);
    expect(msSqlDialect.isDuplicateKeyError({ number: 547 })).toBe(false);
    // `mssql` wraps the tedious error for some failures.
    expect(msSqlDialect.isDuplicateKeyError({ originalError: { info: { number: 2627 } } })).toBe(true);
    expect(msSqlDialect.isDuplicateKeyError(new Error('duplicate key'))).toBe(false);
  });
});

describe('msSqlDialect — golden DML', () => {
  test('tag insert is INSERT … SELECT … WHERE NOT EXISTS', () => {
    // T-SQL has neither INSERT IGNORE nor ON CONFLICT DO NOTHING.
    expect(norm(msSqlDialect.insertTagSql('events_tags'))).toBe(
      'INSERT INTO [events_tags] ([persistence_id], [sequence_nr], [tag], [timestamp]) '
      + 'SELECT @p1, @p2, @p3, @p4 '
      + 'WHERE NOT EXISTS (SELECT 1 FROM [events_tags] '
      + 'WHERE [tag] = @p3 AND [timestamp] = @p4 '
      + 'AND [persistence_id] = @p1 AND [sequence_nr] = @p2)',
    );
  });

  test('deleted_to upsert is a HOLDLOCK merge with a monotonic guard', () => {
    expect(norm(msSqlDialect.upsertDeletedToSql('events_meta'))).toBe(
      'MERGE INTO [events_meta] WITH (HOLDLOCK) AS target '
      + 'USING (SELECT @p1 AS [persistence_id], @p2 AS [deleted_to]) AS source '
      + 'ON target.[persistence_id] = source.[persistence_id] '
      + 'WHEN MATCHED AND target.[deleted_to] < source.[deleted_to] '
      + 'THEN UPDATE SET [deleted_to] = source.[deleted_to] '
      + 'WHEN NOT MATCHED '
      + 'THEN INSERT ([persistence_id], [deleted_to]) '
      + 'VALUES (source.[persistence_id], source.[deleted_to]);',
    );
  });

  test('snapshot upsert is a HOLDLOCK merge', () => {
    // Without HOLDLOCK two concurrent merges can both take NOT MATCHED.
    const sql = norm(msSqlDialect.upsertSnapshotSql('snapshots'));
    expect(sql).toContain('MERGE INTO [snapshots] WITH (HOLDLOCK) AS target');
    expect(sql).toContain('WHEN MATCHED THEN UPDATE SET [payload] = @p3, [timestamp] = @p4');
    expect(sql).toContain('WHEN NOT MATCHED THEN INSERT ([persistence_id], [sequence_nr], [payload], [timestamp]) '
      + 'VALUES (@p1, @p2, @p3, @p4);');
  });

  test('keepN prune uses TOP and binds the persistence id once', () => {
    const prune = msSqlDialect.pruneSnapshotsStatement('snapshots');
    expect(norm(prune.sql)).toBe(
      'DELETE FROM [snapshots] WHERE [persistence_id] = @p1 AND [sequence_nr] NOT IN ( '
      + 'SELECT TOP (@p2) [sequence_nr] FROM [snapshots] '
      + 'WHERE [persistence_id] = @p1 ORDER BY [sequence_nr] DESC)',
    );
    // Named parameters can be referenced twice — so, unlike MariaDB and SQLite,
    // the id is bound once.
    expect(prune.params('account-1', 2)).toEqual(['account-1', 2]);
  });

  test('durable-state insert is unguarded, so a collision throws', () => {
    expect(norm(msSqlDialect.insertStateSql('durable_state'))).toBe(
      'INSERT INTO [durable_state] ([persistence_id], [revision], [payload], [timestamp]) '
      + 'VALUES (@p1, @p2, @p3, @p4)',
    );
    expect(msSqlDialect.stateInsertConflictSignal).toBe('duplicate-key-error');
  });
});

describe('msSqlDialect — golden DDL', () => {
  test('every CREATE is guarded, since T-SQL has no IF NOT EXISTS', () => {
    const statements = msSqlDialect.journalDdl(tables).map(norm);
    expect(statements).toHaveLength(5);
    expect(statements[0]).toContain("IF OBJECT_ID(N'[events]', N'U') IS NULL CREATE TABLE [events]");
    expect(statements[1]).toBe(
      "IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'idx_events_pid' "
      + "AND object_id = OBJECT_ID(N'[events]')) CREATE INDEX [idx_events_pid] ON [events] ([persistence_id])",
    );
    expect(statements[4]).toContain("IF OBJECT_ID(N'[events_meta]', N'U') IS NULL");
  });

  test('the tags primary key is NONCLUSTERED because the key exceeds 900 bytes', () => {
    // NVARCHAR(255) counts 510 index bytes, so tag + timestamp + pid + seq is
    // 1036 — past the clustered limit, inside the nonclustered one.
    const tagsDdl = norm(msSqlDialect.journalDdl(tables)[2]!);
    expect(tagsDdl).toContain('[persistence_id] NVARCHAR(255) NOT NULL');
    expect(tagsDdl).toContain(
      'CONSTRAINT [PK_events_tags] PRIMARY KEY NONCLUSTERED '
      + '([tag], [timestamp], [persistence_id], [sequence_nr])',
    );
    // The events key is 518 bytes, so it stays clustered.
    expect(norm(msSqlDialect.journalDdl(tables)[0]!))
      .toContain('CONSTRAINT [PK_events] PRIMARY KEY ([persistence_id], [sequence_nr])');
  });

  test('column identifiers are bracketed so `timestamp` cannot be read as a type', () => {
    // `timestamp` is a deprecated type alias in T-SQL; bare in a column
    // definition it invites the parser to read it as one.
    for (const statements of [
      msSqlDialect.journalDdl(tables), msSqlDialect.snapshotDdl('snapshots'),
      msSqlDialect.durableStateDdl('durable_state'),
    ]) {
      for (const statement of statements) {
        expect(norm(statement)).not.toMatch(/[ ,(]timestamp +BIGINT/);
      }
    }
    expect(norm(msSqlDialect.snapshotDdl('snapshots')[0]!)).toContain('[timestamp] BIGINT NOT NULL');
    expect(norm(msSqlDialect.durableStateDdl('durable_state')[0]!)).toContain('[payload] NVARCHAR(MAX) NOT NULL');
  });
});

describe('expandPlaceholders', () => {
  test('rewrites canonical ? placeholders left to right', () => {
    const canonical = 'SELECT a FROM t WHERE b = ? AND c >= ? AND d <= ?';
    expect(expandPlaceholders(canonical, postgresDialect))
      .toBe('SELECT a FROM t WHERE b = $1 AND c >= $2 AND d <= $3');
    // A `?`-native dialect is the identity case.
    expect(expandPlaceholders(canonical, mariaDbDialect)).toBe(canonical);
    expect(expandPlaceholders(canonical, msSqlDialect))
      .toBe('SELECT a FROM t WHERE b = @p1 AND c >= @p2 AND d <= @p3');
  });

  test('leaves a statement without placeholders alone', () => {
    expect(expandPlaceholders('SELECT DISTINCT persistence_id FROM events', postgresDialect))
      .toBe('SELECT DISTINCT persistence_id FROM events');
  });
});
