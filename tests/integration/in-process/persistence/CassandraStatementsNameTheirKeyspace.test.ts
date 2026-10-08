import { describe, expect, test } from 'bun:test';
import { CassandraRememberEntitiesStore } from '../../../../src/cluster/sharding/CassandraRememberEntitiesStore.js';
import { CassandraRememberEntitiesStoreOptions } from '../../../../src/cluster/sharding/CassandraRememberEntitiesStoreOptions.js';
import {
  CassandraJournal,
  CassandraJournalOptions,
  CassandraSnapshotStore,
  CassandraSnapshotStoreOptions,
} from '../../../../src/persistence/index.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';

/**
 * No Cassandra store binds its client to the keyspace: every statement names
 * the keyspace itself, and none is a `USE` (#1491).
 *
 * The `keyspace` option's JSDoc, in the connection type and in all three
 * builders, used to promise a `USE` after connect that nothing ever issued —
 * `createCassandraClient` builds the client without a keyspace on purpose,
 * because `autoCreateKeyspace` may have to create it first.  These cases hold
 * the corrected sentence to the code: a store that started relying on a
 * session keyspace would leave a statement here that names none.
 */

const KEYSPACE = 'app';

/** The table a statement reads or writes — the first name after the clause that introduces it. */
const TABLE_REFERENCE = /\b(?:INTO|UPDATE|FROM|EXISTS)\s+([\w.]+)/i;

/** Why `statement` does not name its keyspace, or `undefined` when it does. */
function unqualified(statement: string): string | undefined {
  if (/^USE\b/i.test(statement)) return 'binds the client to a keyspace';
  const created = /^CREATE KEYSPACE IF NOT EXISTS (\w+)/i.exec(statement)?.[1];
  if (created !== undefined) return created === KEYSPACE ? undefined : `creates ${created}, not ${KEYSPACE}`;
  const table = TABLE_REFERENCE.exec(statement)?.[1];
  if (table === undefined) return 'names no table this check can read';
  return table.startsWith(`${KEYSPACE}.`) ? undefined : `targets ${table}, not ${KEYSPACE}.<table>`;
}

function expectEveryStatementNamesTheKeyspace(log: ReadonlyArray<string>): void {
  // An empty log would pass every check below while proving nothing.
  expect(log.length).toBeGreaterThan(0);
  const offenders = log.flatMap((statement) => {
    const reason = unqualified(statement);
    return reason === undefined ? [] : [`${reason}: ${statement}`];
  });
  expect(offenders).toEqual([]);
}

describe('the check refuses what it is there to refuse', () => {
  test('a USE, an unqualified table, another keyspace and a statement it cannot read', () => {
    expect(unqualified(`use ${KEYSPACE}`)).toBe('binds the client to a keyspace');
    expect(unqualified('SELECT sequence_nr FROM events WHERE persistence_id = ?')).toBe('targets events, not app.<table>');
    expect(unqualified('DELETE FROM other.events WHERE persistence_id = ?')).toBe('targets other.events, not app.<table>');
    expect(unqualified("CREATE KEYSPACE IF NOT EXISTS other WITH replication = { 'class': 'SimpleStrategy' }"))
      .toBe('creates other, not app');
    expect(unqualified(`/* session */ USE ${KEYSPACE}`)).toBe('names no table this check can read');
    expect(unqualified('TRUNCATE app.events')).toBe('names no table this check can read');
  });

  test('keyspace DDL and every qualified shape the stores issue', () => {
    for (const statement of [
      `CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE} WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': 1 }`,
      `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.events ( persistence_id text )`,
      `INSERT INTO ${KEYSPACE}.events (persistence_id) VALUES (?) IF NOT EXISTS`,
      `UPDATE ${KEYSPACE}.metadata SET max_sequence_nr = ? WHERE persistence_id = ?`,
      `SELECT payload FROM ${KEYSPACE}.events WHERE persistence_id = ?`,
      `DELETE FROM ${KEYSPACE}.events WHERE persistence_id = ?`,
    ]) {
      expect(unqualified(statement)).toBeUndefined();
    }
  });
});

describe('every statement a Cassandra store issues names its keyspace', () => {
  test('the journal', async () => {
    const client = new FakeCassandraClient();
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace(KEYSPACE)
      .withClient(client)
      .withAutoCreateKeyspace(true);
    const journal = new CassandraJournal(journalOptions);
    await journal.append('account-1', [{ event: 'a' }, { event: 'b' }], 0);
    await journal.read('account-1', 1);
    await journal.highestSeq('account-1');
    await journal.persistenceIds();
    await journal.delete('account-1', 1);
    await journal.storageIdentity();
    await journal.close();
    expectEveryStatementNamesTheKeyspace(client.log);
  });

  test('the snapshot store', async () => {
    const client = new FakeCassandraClient();
    const storeOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace(KEYSPACE)
      .withClient(client)
      .withAutoCreateKeyspace(true);
    const store = new CassandraSnapshotStore(storeOptions);
    await store.save('account-1', 2, { balance: 10 });
    await store.loadLatest('account-1');
    await store.delete('account-1', 2);
    await store.storageIdentity();
    await store.close();
    expectEveryStatementNamesTheKeyspace(client.log);
  });

  test('the remember-entities store', async () => {
    const client = new FakeCassandraClient();
    const storeOptions = CassandraRememberEntitiesStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace(KEYSPACE)
      .withClient(client)
      .withAutoCreateKeyspace(true);
    const store = new CassandraRememberEntitiesStore(storeOptions);
    await store.append('orders', { kind: 'started', shardId: 0, entityId: 'a' });
    await store.append('orders', { kind: 'stopped', shardId: 0, entityId: 'a' });
    await store.load('orders');
    await store.clear('orders');
    await store.close();
    expectEveryStatementNamesTheKeyspace(client.log);
  });
});
