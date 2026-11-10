/**
 * Child-process fixture for `CassandraClientConnectionDefaults.test.ts` and
 * `CassandraStoreBuiltClientStatements.test.ts` (#1491).
 *
 * The question is what option bag a Cassandra store hands the driver when it
 * builds its own client, and what it then asks that client to run.  The only
 * place either exists is the driver's `Client` itself: the argument to its
 * constructor, and the calls to its `execute`.  `cassandra-driver` is absent
 * from the root install by design (#676), so `createCassandraClient`'s lazy
 * import has to be answered by a stand-in — and the stand-in cannot be
 * installed inside `bun test`.  A `mock.module` is process-wide and permanent,
 * and a module that was never installed leaves a teardown nothing true to put
 * back; `Bun.plugin` has no uninstall at all.  So the stand-in is a resolver
 * plugin in a process of its own, and only stdout crosses back.
 *
 * Two lines are printed per case.  `<case>=<json>` is the option bag the client
 * one store built for itself was constructed with; `<case>.statements=<json>`
 * is every statement that client was asked to execute, in order, from connect
 * to close — read by `CassandraStoreBuiltClientStatements.test.ts`, because a
 * `USE` issued after connect binds the client to a keyspace without the
 * option bag ever naming one.  A store whose start fails, or that builds
 * other than exactly one client, ends the run non-zero — and so does a plugin
 * that stopped matching, because the store's lazy import then fails with the
 * missing-package error instead of reaching the stand-in.
 */
import { plugin } from 'bun';

/** What each `new Client(options)` received, in order. */
const built: unknown[] = [];
/** What each of those clients was asked to execute, at the same index. */
const executed: string[][] = [];

/** The driver's `Client`, reduced to what the stores call, recording how it was built and what it ran. */
class RecordingClient {
  private readonly statements: string[] = [];

  constructor(options: unknown) {
    built.push(options);
    executed.push(this.statements);
  }

  async connect(): Promise<void> {}

  async shutdown(): Promise<void> {}

  async execute(query: string): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.statements.push(query);
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

/** Start a store that owns its client, close it, and print the bag that client was built with and what it ran. */
async function report(name: string, store: { start(): Promise<void>; close(): Promise<void> }): Promise<void> {
  const before = built.length;
  await store.start();
  await store.close();
  if (built.length !== before + 1) {
    throw new Error(`${name}: expected the store to build one client, it built ${built.length - before}`);
  }
  console.log(`${name}=${JSON.stringify(built[before])}`);
  console.log(`${name}.statements=${JSON.stringify(executed[before])}`);
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
