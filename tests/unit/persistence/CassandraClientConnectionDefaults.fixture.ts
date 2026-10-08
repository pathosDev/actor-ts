/**
 * Child-process fixture for `CassandraClientConnectionDefaults.test.ts` (#1491).
 *
 * The question is what option bag a Cassandra store hands the driver when it
 * builds its own client, and the only place that bag exists is the argument to
 * the driver's `Client` constructor.  `cassandra-driver` is absent from the
 * root install by design (#676), so `createCassandraClient`'s lazy import has
 * to be answered by a stand-in — and the stand-in cannot be installed inside
 * `bun test`.  A `mock.module` is process-wide and permanent, and a module that
 * was never installed leaves a teardown nothing true to put back; `Bun.plugin`
 * has no uninstall at all.  So the stand-in is a resolver plugin in a process
 * of its own, and only stdout crosses back.
 *
 * Every line printed is `<case>=<json>`: the option bag the client one store
 * built for itself was constructed with.  A store whose start fails, or that
 * builds other than exactly one client, ends the run non-zero — and so does a
 * plugin that stopped matching, because the store's lazy import then fails
 * with the missing-package error instead of reaching the stand-in.
 */
import { plugin } from 'bun';

/** What each `new Client(options)` received, in order. */
const built: unknown[] = [];

/** The driver's `Client`, reduced to what the stores call, recording how it was built. */
class RecordingClient {
  constructor(options: unknown) {
    built.push(options);
  }

  async connect(): Promise<void> {}

  async shutdown(): Promise<void> {}

  async execute(): Promise<{ rows: Array<Record<string, unknown>> }> {
    return { rows: [] };
  }

  async batch(): Promise<void> {}
}

plugin({
  name: 'cassandra-driver stand-in',
  setup(build) {
    build.module('cassandra-driver', () => ({ exports: { Client: RecordingClient }, loader: 'object' }));
  },
});

// Imported only now, so nothing below can have resolved the specifier before
// the plugin existed.
const { CassandraJournal } = await import('../../../src/persistence/journals/CassandraJournal.js');
const { CassandraJournalOptions } = await import('../../../src/persistence/journals/CassandraJournalOptions.js');
const { CassandraSnapshotStore } = await import('../../../src/persistence/snapshot-stores/CassandraSnapshotStore.js');
const { CassandraSnapshotStoreOptions } = await import(
  '../../../src/persistence/snapshot-stores/CassandraSnapshotStoreOptions.js'
);
const { CassandraRememberEntitiesStore } = await import('../../../src/cluster/sharding/CassandraRememberEntitiesStore.js');
const { CassandraRememberEntitiesStoreOptions } = await import(
  '../../../src/cluster/sharding/CassandraRememberEntitiesStoreOptions.js'
);

/** Start a store that owns its client, close it, and print the bag that client was built with. */
async function report(name: string, store: { start(): Promise<void>; close(): Promise<void> }): Promise<void> {
  const before = built.length;
  await store.start();
  await store.close();
  if (built.length !== before + 1) {
    throw new Error(`${name}: expected the store to build one client, it built ${built.length - before}`);
  }
  console.log(`${name}=${JSON.stringify(built[before])}`);
}

const journalOptions = CassandraJournalOptions.create()
  .withContactPoints(['127.0.0.1'])
  .withKeyspace('app');
await report('journal', new CassandraJournal(journalOptions));

const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
  .withContactPoints(['127.0.0.1'])
  .withKeyspace('app');
await report('snapshot-store', new CassandraSnapshotStore(snapshotStoreOptions));

const rememberEntitiesOptions = CassandraRememberEntitiesStoreOptions.create()
  .withContactPoints(['127.0.0.1'])
  .withKeyspace('app');
await report('remember-entities', new CassandraRememberEntitiesStore(rememberEntitiesOptions));

const statedJournalOptions = CassandraJournalOptions.create()
  .withContactPoints(['127.0.0.1'])
  .withKeyspace('app')
  .withPort(9142)
  .withLocalDataCenter('eu-west');
await report('journal-stated', new CassandraJournal(statedJournalOptions));
