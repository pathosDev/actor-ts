import { describe, expect, test } from 'bun:test';
import { assertSafeIdentifier } from '../../../src/persistence/storage/SqlIdentifier.js';
import { SqliteJournal } from '../../../src/persistence/journals/SqliteJournal.js';
import { SqliteSnapshotStore } from '../../../src/persistence/snapshot-stores/SqliteSnapshotStore.js';
import { CassandraJournal } from '../../../src/persistence/journals/CassandraJournal.js';
import { CassandraJournalOptions } from '../../../src/persistence/journals/CassandraJournalOptions.js';
import { CassandraQuery } from '../../../src/persistence/query/CassandraQuery.js';
import { offsetStart } from '../../../src/persistence/query/PersistenceQuery.js';

// security audit #6 — table/keyspace identifiers are interpolated into
// DDL/DML (they can't be bound), so a config-sourced value must be validated.
// Postgres/MariaDB already did; SQLite + Cassandra now share this guard.
describe('assertSafeIdentifier (#6)', () => {
  test('accepts plain identifiers', () => {
    expect(assertSafeIdentifier('events', 't')).toBe('events');
    expect(assertSafeIdentifier('_x9', 't')).toBe('_x9');
    expect(assertSafeIdentifier('My_Table1', 't')).toBe('My_Table1');
  });

  test('rejects injection / illegal identifiers', () => {
    for (const bad of ['ev;DROP TABLE x', 'a b', 'a-b', '1abc', 'a.b', 'a"b', '', 'a)']) {
      expect(() => assertSafeIdentifier(bad, 't')).toThrow(/identifier/);
    }
  });
});

describe('SQLite stores validate the table name at construction (#6)', () => {
  test('SqliteJournal rejects an unsafe eventsTable', () => {
    expect(() => new SqliteJournal({ eventsTable: 'ev; DROP TABLE users' })).toThrow(/identifier/);
    expect(() => new SqliteJournal({ eventsTable: 'events' })).not.toThrow();
  });

  test('SqliteSnapshotStore rejects an unsafe snapshotsTable', () => {
    expect(() => new SqliteSnapshotStore({ snapshotsTable: 'a b' })).toThrow(/identifier/);
    expect(() => new SqliteSnapshotStore({ snapshotsTable: 'snaps' })).not.toThrow();
  });
});

// security audit #614 — CassandraQuery used to rebuild `keyspace.table` by
// hand instead of going through the journal's guarded `qualified()`.  A
// query-only process never runs ensureTables(), so nothing else validated
// those two names on the read path.
describe('CassandraQuery routes the tag-index table through the journal guard (#614)', () => {
  const journalWith = (keyspace: string, tagIndexTable?: string): CassandraJournal => {
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace(keyspace)
      .withUseTagIndex(true);
    if (tagIndexTable !== undefined) journalOptions.withTagIndexTable(tagIndexTable);
    return new CassandraJournal(journalOptions);
  };

  test('qualifiedTagIndexTable yields the validated, fully-qualified name', () => {
    expect(journalWith('ks').qualifiedTagIndexTable).toBe('ks.events_by_tag');
    expect(journalWith('ks', 'by_tag').qualifiedTagIndexTable).toBe('ks.by_tag');
  });

  test('a hostile keyspace is rejected before any CQL is issued', async () => {
    // No client is injected, so reaching `client.execute` would throw a
    // TypeError instead — the /identifier/ match proves the guard fired first.
    const query = new CassandraQuery(journalWith('ks WHERE x = 1 ALLOW FILTERING --'));
    await expect(query.currentEventsByTag('type:Order', offsetStart)).rejects.toThrow(/identifier/);
  });

  test('a hostile tagIndexTable is rejected before any CQL is issued', async () => {
    const query = new CassandraQuery(journalWith('ks', 'events_by_tag; DROP TABLE events'));
    await expect(query.currentEventsByTag({ any: ['a', 'b'] }, offsetStart)).rejects.toThrow(/identifier/);
  });
});
