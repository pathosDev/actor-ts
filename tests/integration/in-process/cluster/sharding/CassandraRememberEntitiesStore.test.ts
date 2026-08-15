/**
 * Tests for `CassandraRememberEntitiesStore` (#84) — the Cassandra-
 * backed RememberEntitiesStore for ClusterSharding.  Round-trip via
 * `FakeCassandraClient` mirrors the CassandraJournal test pattern;
 * the oracle here is the existing `JournalRememberEntitiesStore`
 * (against `InMemoryJournal`) — both implementations must produce
 * the same load() result for the same sequence of append() calls.
 */
import { describe, expect, test } from 'bun:test';
import {
  CassandraRememberEntitiesStore,
  CassandraRememberEntitiesStoreOptions,
  rememberEntitiesDdl,
  JournalRememberEntitiesStore,
  type RememberEvent,
} from '../../../../../src/cluster/index.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { FakeCassandraClient } from '../../persistence/FakeCassandraClient.js';

function makeStore(): {
  store: CassandraRememberEntitiesStore;
  client: FakeCassandraClient;
} {
  const client = new FakeCassandraClient();
  const storeOptions = CassandraRememberEntitiesStoreOptions.create()
    .withContactPoints(['fake'])
    .withKeyspace('sharding')
    .withAutoCreateKeyspace(true)
    .withClient(client);
  const store = new CassandraRememberEntitiesStore(storeOptions);
  return { store, client };
}

const sortById = (events: RememberEvent[]): RememberEvent[] =>
  [...events].sort((a, b) => a.entityId.localeCompare(b.entityId));

describe('CassandraRememberEntitiesStore — append / load round-trip', () => {
  test('started events upsert into the table and surface via load', async () => {
    const { store, client } = makeStore();
    await store.append('orders', { kind: 'started', shardId: 0, entityId: 'a' });
    await store.append('orders', { kind: 'started', shardId: 0, entityId: 'b' });
    await store.append('orders', { kind: 'started', shardId: 1, entityId: 'c' });

    expect(client.countRows('sharding.remember_entities')).toBe(3);

    const loaded = await store.load('orders');
    expect(sortById(loaded)).toEqual([
      { kind: 'started', shardId: 0, entityId: 'a' },
      { kind: 'started', shardId: 0, entityId: 'b' },
      { kind: 'started', shardId: 1, entityId: 'c' },
    ]);

    await store.close();
  });

  test('stopped event removes the corresponding row', async () => {
    const { store } = makeStore();
    await store.append('orders', { kind: 'started', shardId: 0, entityId: 'a' });
    await store.append('orders', { kind: 'started', shardId: 0, entityId: 'b' });
    await store.append('orders', { kind: 'stopped', shardId: 0, entityId: 'a' });

    const loaded = await store.load('orders');
    expect(loaded).toEqual([{ kind: 'started', shardId: 0, entityId: 'b' }]);

    await store.close();
  });

  test('start-restart-of-the-same-entity is idempotent (upsert overwrites)', async () => {
    const { store, client } = makeStore();
    await store.append('orders', { kind: 'started', shardId: 0, entityId: 'a' });
    await store.append('orders', { kind: 'started', shardId: 0, entityId: 'a' });
    await store.append('orders', { kind: 'started', shardId: 0, entityId: 'a' });
    // Only one row in the table — the upsert key is (type, shard, entity).
    expect(client.countRows('sharding.remember_entities')).toBe(1);

    const loaded = await store.load('orders');
    expect(loaded).toEqual([{ kind: 'started', shardId: 0, entityId: 'a' }]);

    await store.close();
  });

  test('clear removes every row for the given typeName but leaves other types alone', async () => {
    const { store } = makeStore();
    await store.append('orders', { kind: 'started', shardId: 0, entityId: 'a' });
    await store.append('orders', { kind: 'started', shardId: 1, entityId: 'b' });
    await store.append('users',  { kind: 'started', shardId: 0, entityId: 'u1' });

    await store.clear('orders');

    expect(await store.load('orders')).toEqual([]);
    expect(sortById(await store.load('users'))).toEqual([
      { kind: 'started', shardId: 0, entityId: 'u1' },
    ]);

    await store.close();
  });

  test('load returns empty when no rows have been appended for the type', async () => {
    const { store } = makeStore();
    expect(await store.load('untouched')).toEqual([]);
    await store.close();
  });

  test('rememberEntitiesDdl returns a runnable CREATE TABLE statement', () => {
    const ddl = rememberEntitiesDdl({ keyspace: 'app' });
    expect(ddl).toMatch(/^CREATE TABLE IF NOT EXISTS app\.remember_entities/);
    expect(ddl).toMatch(/PRIMARY KEY \(\(type_name\), shard_id, entity_id\)/);
  });
});

// security audit #615 — one `qualified()` string feeds four differently-shaped
// statements (INSERT / point-DELETE / SELECT / partition-DELETE), and the
// store's auto-create runs the exported `rememberEntitiesDdl` rather than
// `qualified()`, so both doors needed the guard the sibling Cassandra stores
// have always had.
describe('CassandraRememberEntitiesStore validates its identifiers (#615)', () => {
  const storeWith = (
    keyspace: string, table?: string, autoCreateTables = true,
  ): CassandraRememberEntitiesStore => {
    const storeOptions = CassandraRememberEntitiesStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace(keyspace)
      .withAutoCreateTables(autoCreateTables)
      .withClient(new FakeCassandraClient());
    if (table !== undefined) storeOptions.withTable(table);
    return new CassandraRememberEntitiesStore(storeOptions);
  };

  test('the auto-create path rejects a hostile table name', async () => {
    const store = storeWith('sharding', 'remember_entities) WITH x --');
    await expect(store.append('orders', { kind: 'started', shardId: 0, entityId: 'a' }))
      .rejects.toThrow(/identifier/);
    await store.close();
  });

  test('every statement rejects a hostile table name with auto-create off', async () => {
    // `autoCreateTables: false` skips rememberEntitiesDdl entirely, so this
    // reaches `qualified()` — the one string all four statements share.
    const store = storeWith('sharding', 'remember_entities (a) VALUES (?) USING TTL 1 --', false);
    await expect(store.append('orders', { kind: 'started', shardId: 0, entityId: 'a' }))
      .rejects.toThrow(/identifier/);
    await expect(store.append('orders', { kind: 'stopped', shardId: 0, entityId: 'a' }))
      .rejects.toThrow(/identifier/);
    await expect(store.load('orders')).rejects.toThrow(/identifier/);
    await expect(store.clear('orders')).rejects.toThrow(/identifier/);
    await store.close();
  });

  test('a hostile keyspace is rejected on the statement path too', async () => {
    const store = storeWith('sharding WHERE x = 1 --', undefined, false);
    await expect(store.load('orders')).rejects.toThrow(/identifier/);
    await store.close();
  });

  test('rememberEntitiesDdl rejects an injected keyspace or table', () => {
    expect(() => rememberEntitiesDdl({ keyspace: 'app;DROP KEYSPACE x' })).toThrow(/identifier/);
    expect(() => rememberEntitiesDdl({ keyspace: 'app', table: 't) WITH x --' })).toThrow(/identifier/);
    expect(rememberEntitiesDdl({ keyspace: 'app', table: 'remembered' }))
      .toMatch(/^CREATE TABLE IF NOT EXISTS app\.remembered/);
  });
});

describe('CassandraRememberEntitiesStore — oracle equivalence with JournalRememberEntitiesStore', () => {
  /**
   * Apply the same sequence of `append` operations to both stores and
   * verify `load(typeName)` returns the same final entity set.  The
   * Cassandra store is state-based, the journal-backed store is
   * event-sourced — they reach the same `entitiesPerShard` answer
   * (set of started-not-stopped entities) by different paths, so this
   * is the right invariant to pin.
   */
  test('both stores converge on the same active-entity set', async () => {
    const { store: cassandra } = makeStore();
    const journal = new InMemoryJournal();
    const journalStore = new JournalRememberEntitiesStore(journal);

    const ops: ReadonlyArray<[string, RememberEvent]> = [
      ['orders', { kind: 'started', shardId: 0, entityId: 'a' }],
      ['orders', { kind: 'started', shardId: 0, entityId: 'b' }],
      ['orders', { kind: 'started', shardId: 1, entityId: 'c' }],
      ['orders', { kind: 'stopped', shardId: 0, entityId: 'a' }],
      ['orders', { kind: 'started', shardId: 1, entityId: 'd' }],
      ['orders', { kind: 'stopped', shardId: 1, entityId: 'c' }],
      ['orders', { kind: 'started', shardId: 0, entityId: 'a' }], // re-start
    ];
    for (const [type, evt] of ops) {
      await cassandra.append(type, evt);
      await journalStore.append(type, evt);
    }

    const cassandraSet = new Set(
      (await cassandra.load('orders'))
        .filter((entity) => entity.kind === 'started')
        .map((entity) => `${entity.shardId}|${entity.entityId}`),
    );
    // The journal-backed store replays events; the active set is the
    // running `started - stopped` of the replay.
    const journalEvents = await journalStore.load('orders');
    const journalSet = new Set<string>();
    for (const entity of journalEvents) {
      const key = `${entity.shardId}|${entity.entityId}`;
      if (entity.kind === 'started') journalSet.add(key);
      else                      journalSet.delete(key);
    }

    expect(cassandraSet).toEqual(journalSet);
    // Trace: started (a, b, c, d, a-restart), stopped (a, c).  After
    // applying in order, 0|a is still active (re-started after stop),
    // 0|b never stopped, 1|c stopped, 1|d started.  Final set:
    // {0|a, 0|b, 1|d}.
    expect(cassandraSet).toEqual(new Set(['0|a', '0|b', '1|d']));

    await cassandra.close();
  });
});
