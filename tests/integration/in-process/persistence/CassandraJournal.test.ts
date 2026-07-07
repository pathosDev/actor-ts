import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  CASSANDRA_JOURNAL_PLUGIN_ID,
  CASSANDRA_SNAPSHOT_PLUGIN_ID,
  CassandraJournal,
  CassandraJournalOptions,
  CassandraSnapshotStore,
  CassandraSnapshotStoreOptions,
  JournalConcurrencyError,
  PersistenceExtensionId,
  RegisterCassandraPluginsOptions,
  registerCassandraPlugins,
} from '../../../../src/persistence/index.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';

describe('CassandraJournal — append / read', () => {
  test('happy path: append, then read all', async () => {
    const client = new FakeCassandraClient();
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client)
      .withAutoCreateKeyspace(true);
    const journal = new CassandraJournal(journalOptions);
    const written = await journal.append('acc-1', ['created', 'deposited:10', 'deposited:20'], 0);
    expect(written.map((e) => e.sequenceNr)).toEqual([1, 2, 3]);

    const read = await journal.read<string>('acc-1', 1);
    expect(read.map((e) => e.event)).toEqual(['created', 'deposited:10', 'deposited:20']);
    expect(read[0]!.sequenceNr).toBe(1);
    await journal.close();
  });

  test('optimistic concurrency fails when expectedSeq is stale', async () => {
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(new FakeCassandraClient())
      .withAutoCreateKeyspace(true);
    const journal = new CassandraJournal(journalOptions);
    await journal.append('acc-2', ['a'], 0);
    let caught: unknown = null;
    try { await journal.append('acc-2', ['b'], 0); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(JournalConcurrencyError);
    await journal.close();
  });

  test('highestSeq reflects the last append', async () => {
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(new FakeCassandraClient());
    const journal = new CassandraJournal(journalOptions);
    expect(await journal.highestSeq('nobody')).toBe(0);
    await journal.append('acc-3', ['a', 'b', 'c'], 0);
    expect(await journal.highestSeq('acc-3')).toBe(3);
    await journal.append('acc-3', ['d'], 3);
    expect(await journal.highestSeq('acc-3')).toBe(4);
    await journal.close();
  });

  test('read range respects fromSeq + toSeq', async () => {
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(new FakeCassandraClient());
    const journal = new CassandraJournal(journalOptions);
    await journal.append('acc-4', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0);
    const slice = await journal.read<number>('acc-4', 3, 6);
    expect(slice.map((e) => e.event)).toEqual([3, 4, 5, 6]);
    await journal.close();
  });

  test('delete prunes events up to toSeq', async () => {
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(new FakeCassandraClient());
    const journal = new CassandraJournal(journalOptions);
    await journal.append('acc-5', ['a', 'b', 'c', 'd'], 0);
    await journal.delete('acc-5', 2);
    const left = await journal.read<string>('acc-5', 1);
    expect(left.map((e) => e.event)).toEqual(['c', 'd']);
    await journal.close();
  });

  test('persistenceIds enumerates writers seen so far', async () => {
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(new FakeCassandraClient());
    const journal = new CassandraJournal(journalOptions);
    await journal.append('one', ['x'], 0);
    await journal.append('two', ['y'], 0);
    await journal.append('three', ['z'], 0);
    const ids = await journal.persistenceIds();
    expect(new Set(ids)).toEqual(new Set(['one', 'two', 'three']));
    await journal.close();
  });

  test('partition rollover: seq spans multiple Cassandra partitions', async () => {
    const client = new FakeCassandraClient();
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client)
      .withPartitionSize(3); // tiny so we force rollover
    const journal = new CassandraJournal(journalOptions);
    await journal.append('pid', [1, 2, 3], 0);
    await journal.append('pid', [4, 5, 6, 7], 3);
    const all = await journal.read<number>('pid', 1);
    expect(all.map((e) => e.event)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await journal.close();
  });
});

describe('CassandraSnapshotStore', () => {
  test('save and loadLatest round-trip', async () => {
    const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(new FakeCassandraClient());
    const store = new CassandraSnapshotStore(snapshotStoreOptions);
    await store.save('pid', 10, { counter: 42 });
    const snap = (await store.loadLatest<{ counter: number }>('pid')).toNullable();
    expect(snap).not.toBeNull();
    expect(snap!.sequenceNr).toBe(10);
    expect(snap!.state.counter).toBe(42);
    await store.close();
  });

  test('loadBefore returns the newest snapshot strictly less than seq', async () => {
    const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(new FakeCassandraClient())
      .withKeepN(0);
    const store = new CassandraSnapshotStore(snapshotStoreOptions);
    await store.save('pid', 5, 'state-at-5');
    await store.save('pid', 10, 'state-at-10');
    await store.save('pid', 15, 'state-at-15');

    const before10 = (await store.loadBefore<string>('pid', 10)).toNullable();
    expect(before10!.sequenceNr).toBe(5);

    const before99 = (await store.loadBefore<string>('pid', 99)).toNullable();
    expect(before99!.sequenceNr).toBe(15);
    await store.close();
  });

  test('delete prunes snapshots up to toSeq', async () => {
    const client = new FakeCassandraClient();
    const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client)
      .withKeepN(0);
    const store = new CassandraSnapshotStore(snapshotStoreOptions);
    await store.save('pid', 5, 'a');
    await store.save('pid', 10, 'b');
    await store.save('pid', 15, 'c');
    await store.delete('pid', 10);
    const left = (await store.loadLatest<string>('pid')).toNullable();
    expect(left!.sequenceNr).toBe(15);
    await store.close();
  });

  test('keepN prunes old snapshots automatically', async () => {
    const client = new FakeCassandraClient();
    const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client)
      .withKeepN(2);
    const store = new CassandraSnapshotStore(snapshotStoreOptions);
    for (let i = 1; i <= 5; i++) await store.save('pid', i * 10, `s-${i}`);
    // Only the last 2 should remain.
    expect(client.countRows('ks.snapshots')).toBeLessThanOrEqual(2);
    const latest = (await store.loadLatest<string>('pid')).toNullable();
    expect(latest!.sequenceNr).toBe(50);
    await store.close();
  });
});

describe('registerCassandraPlugins — config-driven selection', () => {
  test('extension picks up Cassandra plug-ins when the config path names them', async () => {
    const client = new FakeCassandraClient();
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            journal: { plugin: CASSANDRA_JOURNAL_PLUGIN_ID },
            'snapshot-store': { plugin: CASSANDRA_SNAPSHOT_PLUGIN_ID },
          },
        },
      });
    const sys = ActorSystem.create('cassandra-cfg', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);
    const registerOptions = RegisterCassandraPluginsOptions.create()
      .withClient(client)
      .withJournal(CassandraJournalOptions.create().withContactPoints(['fake']).withKeyspace('app'))
      .withSnapshotStore(CassandraSnapshotStoreOptions.create().withContactPoints(['fake']).withKeyspace('app'));
    registerCassandraPlugins(ext, registerOptions);

    expect(ext.journal).toBeInstanceOf(CassandraJournal);
    expect(ext.snapshotStore).toBeInstanceOf(CassandraSnapshotStore);

    // Round-trip through the extension-selected journal.
    await ext.journal.append('x', ['hello'], 0);
    const read = await ext.journal.read<string>('x', 1);
    expect(read[0]!.event).toBe('hello');

    await ext.journal.close?.();
    await ext.snapshotStore.close?.();
    await sys.terminate();
  });
});

describe('CassandraJournal + SnapshotStore — integration', () => {
  test('typical recovery path: snapshot + subsequent events', async () => {
    const client = new FakeCassandraClient();
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client);
    const journal = new CassandraJournal(journalOptions);
    const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client);
    const snaps = new CassandraSnapshotStore(snapshotStoreOptions);

    await journal.append('acc', ['ev1', 'ev2', 'ev3'], 0);
    await snaps.save('acc', 3, { sum: 3 });
    await journal.append('acc', ['ev4', 'ev5'], 3);

    const snap = (await snaps.loadLatest<{ sum: number }>('acc')).toNullable();
    const tail = await journal.read<string>('acc', snap!.sequenceNr + 1);
    expect(snap!.state.sum).toBe(3);
    expect(tail.map((e) => e.event)).toEqual(['ev4', 'ev5']);

    await journal.close();
    await snaps.close();
  });
});
