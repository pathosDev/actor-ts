import { describe, expect, test } from 'bun:test';
import { assertSafeIdentifier } from '../../../src/persistence/storage/SqlIdentifier.js';
import { SqliteJournal } from '../../../src/persistence/journals/SqliteJournal.js';
import { SqliteSnapshotStore } from '../../../src/persistence/snapshot-stores/SqliteSnapshotStore.js';

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
