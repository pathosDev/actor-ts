import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  CASSANDRA_JOURNAL_PLUGIN_ID,
  CASSANDRA_SNAPSHOT_PLUGIN_ID,
  CassandraJournal,
  CassandraJournalOptions,
  CassandraQuery,
  CassandraSnapshotStore,
  CassandraSnapshotStoreOptions,
  JournalConcurrencyError,
  JournalError,
  PersistenceExtensionId,
  RegisterCassandraPluginsOptions,
  offsetStart,
  registerCassandraPlugins,
  type CassandraClientLike,
  type CassandraRowResult,
} from '../../../../src/persistence/index.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';

type ExecuteOptions = { prepare?: boolean; consistency?: number };

/** How a {@link LifecycleClient} fails. */
type LifecycleClientFailures = {
  /** 1-based connect attempts that throw. */
  readonly connects?: ReadonlyArray<number>;
  /** Whether the first `CREATE` statement throws — a start that fails after it connected. */
  readonly firstCreate?: boolean;
};

/**
 * A fake that counts its connects and shutdowns, fails the way it is told to,
 * and can hold a connect open until the test lets it finish — what the
 * lifecycle cases below need to see what a store did with a client.
 *
 * Its `shutdown()` behaves like `cassandra-driver`'s (4.x `Client#_shutdown`)
 * on the one point that matters here: a client that has not finished
 * connecting has nothing to shut down yet, so the call returns, and a connect
 * still in flight completes afterwards, connected.  That is why `close()` has
 * to let a start settle before it shuts the client down, and
 * `holdsConnection` is what shows whether it did.
 */
class LifecycleClient extends FakeCassandraClient {
  connects = 0;
  shutdowns = 0;
  /** Whether the client holds a connection right now — what a leak looks like from outside. */
  holdsConnection = false;
  /** When set, every connect waits for it before it succeeds or fails. */
  heldConnect: Promise<void> | null = null;
  /** When set, the first `CREATE` statement waits for it — a schema step still in flight. */
  heldCreate: Promise<void> | null = null;
  /**
   * Settle when the first connect, and the first `CREATE`, begins — the
   * moments a test closes against.  Promises rather than a polling loop: a
   * loop of bare `await Promise.resolve()` never yields to the timer queue,
   * so a store that never got there would hang the runner instead of timing
   * out.
   */
  readonly firstConnect: Promise<void>;
  readonly firstCreate: Promise<void>;
  private readonly failingConnects: ReadonlySet<number>;
  private failNextCreate: boolean;
  private markConnecting: () => void = () => { /* replaced below */ };
  private markCreating: () => void = () => { /* replaced below */ };

  constructor(failures: LifecycleClientFailures = {}) {
    super();
    this.failingConnects = new Set(failures.connects ?? []);
    this.failNextCreate = failures.firstCreate === true;
    this.firstConnect = new Promise<void>((resolve) => { this.markConnecting = resolve; });
    this.firstCreate = new Promise<void>((resolve) => { this.markCreating = resolve; });
  }

  override async connect(): Promise<void> {
    this.connects++;
    this.markConnecting();
    const attempt = this.connects;
    if (this.heldConnect !== null) await this.heldConnect;
    if (this.failingConnects.has(attempt)) throw new Error('cassandra not up yet');
    await super.connect();
    this.holdsConnection = true;
  }

  override async execute(
    query: string,
    params: ReadonlyArray<unknown> = [],
    options?: ExecuteOptions,
  ): Promise<CassandraRowResult> {
    if (query.trimStart().toUpperCase().startsWith('CREATE')) {
      this.markCreating();
      const held = this.heldCreate;
      this.heldCreate = null;
      if (held !== null) await held;
      if (this.failNextCreate) {
        this.failNextCreate = false;
        throw new Error('Unauthorized: User app has no CREATE permission');
      }
    }
    return super.execute(query, params, options);
  }

  override async shutdown(): Promise<void> {
    this.shutdowns++;
    if (!this.holdsConnection) return;
    this.holdsConnection = false;
    await super.shutdown();
  }
}

/**
 * The client an owning store's `createClient` hands out: always the same one,
 * or the next of several — what a retry that must open a fresh client needs.
 */
type OwnedClients = LifecycleClient | ReadonlyArray<LifecycleClient>;

/** The `created`-th client (1-based) of `owned`; the last one repeats once the list runs out. */
function nthClient(owned: OwnedClients, created: number): LifecycleClient {
  if (owned instanceof LifecycleClient) return owned;
  const client = owned[Math.min(created, owned.length) - 1];
  if (client === undefined) throw new Error('no client to hand out');
  return client;
}

/**
 * A journal that OWNS its client, as one built without `withClient` does —
 * only the client comes from `createClient` instead of `cassandra-driver`,
 * which is not installed here.  Ownership is the point: an injected client
 * is the caller's and is never shut down, so what close() does with a client
 * the journal created can only be seen through this seam.
 */
class OwningCassandraJournal extends CassandraJournal {
  created = 0;
  private readonly ownedClients: OwnedClients;
  /** When given, client creation waits for it — a driver import still in flight. */
  private readonly creating: Promise<void> | undefined;

  constructor(ownedClients: OwnedClients, creating?: Promise<void>, autoCreateKeyspace = false, useTagIndex = false) {
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withAutoCreateKeyspace(autoCreateKeyspace)
      .withUseTagIndex(useTagIndex);
    super(journalOptions);
    this.ownedClients = ownedClients;
    this.creating = creating;
  }

  protected override async createClient(): Promise<CassandraClientLike> {
    this.created++;
    const client = nthClient(this.ownedClients, this.created);
    if (this.creating !== undefined) await this.creating;
    return client;
  }
}

/** The snapshot-store twin of {@link OwningCassandraJournal}. */
class OwningCassandraSnapshotStore extends CassandraSnapshotStore {
  created = 0;
  private readonly ownedClients: OwnedClients;
  private readonly creating: Promise<void> | undefined;

  constructor(ownedClients: OwnedClients, creating?: Promise<void>, autoCreateKeyspace = false) {
    const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withAutoCreateKeyspace(autoCreateKeyspace);
    super(snapshotStoreOptions);
    this.ownedClients = ownedClients;
    this.creating = creating;
  }

  protected override async createClient(): Promise<CassandraClientLike> {
    this.created++;
    const client = nthClient(this.ownedClients, this.created);
    if (this.creating !== undefined) await this.creating;
    return client;
  }
}

/** Both Cassandra stores, as the cases below build them over clients they own. */
const owningStores = [
  {
    label: 'journal',
    closedMessage: 'CassandraJournal is closed',
    make: (clients: OwnedClients, creating?: Promise<void>, autoCreateKeyspace?: boolean) =>
      new OwningCassandraJournal(clients, creating, autoCreateKeyspace),
  },
  {
    label: 'snapshot store',
    closedMessage: 'CassandraSnapshotStore is closed',
    make: (clients: OwnedClients, creating?: Promise<void>, autoCreateKeyspace?: boolean) =>
      new OwningCassandraSnapshotStore(clients, creating, autoCreateKeyspace),
  },
] as const;

/** A promise the test settles by hand — how a connect is held in flight without a timer. */
function heldOpen(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release };
}

describe('CassandraJournal — append / read', () => {
  test('happy path: append, then read all', async () => {
    const client = new FakeCassandraClient();
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client)
      .withAutoCreateKeyspace(true);
    const journal = new CassandraJournal(journalOptions);
    const written = await journal.append('acc-1', [{ event: 'created' }, { event: 'deposited:10' }, { event: 'deposited:20' }], 0);
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
    await journal.append('acc-2', [{ event: 'a' }], 0);
    let caught: unknown = null;
    try { await journal.append('acc-2', [{ event: 'b' }], 0); } catch (e) { caught = e; }
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
    await journal.append('acc-3', [{ event: 'a' }, { event: 'b' }, { event: 'c' }], 0);
    expect(await journal.highestSeq('acc-3')).toBe(3);
    await journal.append('acc-3', [{ event: 'd' }], 3);
    expect(await journal.highestSeq('acc-3')).toBe(4);
    await journal.close();
  });

  test('read range respects fromSeq + toSeq', async () => {
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(new FakeCassandraClient());
    const journal = new CassandraJournal(journalOptions);
    await journal.append('acc-4', [
      { event: 1 },
      { event: 2 },
      { event: 3 },
      { event: 4 },
      { event: 5 },
      { event: 6 },
      { event: 7 },
      { event: 8 },
      { event: 9 },
      { event: 10 },
    ], 0);
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
    await journal.append('acc-5', [{ event: 'a' }, { event: 'b' }, { event: 'c' }, { event: 'd' }], 0);
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
    await journal.append('one', [{ event: 'x' }], 0);
    await journal.append('two', [{ event: 'y' }], 0);
    await journal.append('three', [{ event: 'z' }], 0);
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
    await journal.append('pid', [{ event: 1 }, { event: 2 }, { event: 3 }], 0);
    await journal.append('pid', [{ event: 4 }, { event: 5 }, { event: 6 }, { event: 7 }], 3);
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
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('app');
    const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('app');
    const registerOptions = RegisterCassandraPluginsOptions.create()
      .withClient(client)
      .withJournal(journalOptions)
      .withSnapshotStore(snapshotStoreOptions);
    // Registered through the `plugins` slot (#1473), so both selected stores
    // resolve on the line after `create`.
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
      })
      .withPersistence({ plugins: [(persistence) => registerCassandraPlugins(persistence, registerOptions)] });
    const sys = ActorSystem.create('cassandra-cfg', sysOptions);
    const ext = sys.extension(PersistenceExtensionId);

    expect(ext.journal).toBeInstanceOf(CassandraJournal);
    expect(ext.snapshotStore).toBeInstanceOf(CassandraSnapshotStore);

    // Round-trip through the extension-selected journal.
    await ext.journal.append('x', [{ event: 'hello' }], 0);
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

    await journal.append('acc', [{ event: 'ev1' }, { event: 'ev2' }, { event: 'ev3' }], 0);
    await snaps.save('acc', 3, { sum: 3 });
    await journal.append('acc', [{ event: 'ev4' }, { event: 'ev5' }], 3);

    const snap = (await snaps.loadLatest<{ sum: number }>('acc')).toNullable();
    const tail = await journal.read<string>('acc', snap!.sequenceNr + 1);
    expect(snap!.state.sum).toBe(3);
    expect(tail.map((e) => e.event)).toEqual(['ev4', 'ev5']);

    await journal.close();
    await snaps.close();
  });
});

describe('Cassandra storage identity (#1358)', () => {
  test('one keyspace, one identity: shared by both stores, stable across store instances', async () => {
    const client = new FakeCassandraClient();
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client);
    const journal = new CassandraJournal(journalOptions);
    const identity = await journal.storageIdentity();
    expect(identity).toMatch(/^[0-9a-f-]{36}$/);
    expect(await journal.storageIdentity()).toBe(identity);

    // The snapshot store on the same keyspace reads the same row — the
    // identity belongs to the database, not to the store family.
    const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client);
    const snapshotStore = new CassandraSnapshotStore(snapshotStoreOptions);
    expect(await snapshotStore.storageIdentity()).toBe(identity);

    // A fresh store over the same database loses the LWT claim and adopts
    // the stored row — minted once, never re-minted.
    const reopenedOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client);
    const reopened = new CassandraJournal(reopenedOptions);
    expect(await reopened.storageIdentity()).toBe(identity);

    await journal.close();
    await snapshotStore.close();
    await reopened.close();
  });
});

describe('Cassandra stores — start() and close() (#1473)', () => {
  test('journal: start() after close() rejects instead of reconnecting the client', async () => {
    const neverStarted = new LifecycleClient();
    const neverStartedOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(neverStarted);
    const closedFirst = new CassandraJournal(neverStartedOptions);
    await closedFirst.close();
    await expect(closedFirst.start()).rejects.toThrow('CassandraJournal is closed');
    expect(neverStarted.connects).toBe(0);

    const started = new LifecycleClient();
    const startedOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(started);
    const closedAfterStart = new CassandraJournal(startedOptions);
    await closedAfterStart.start();
    await closedAfterStart.close();
    await expect(closedAfterStart.start()).rejects.toBeInstanceOf(JournalError);
    expect(started.connects).toBe(1);
  });

  test('journal: an operation after close() rejects instead of reaching the client', async () => {
    const client = new LifecycleClient();
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client);
    const journal = new CassandraJournal(journalOptions);
    await journal.append('acc', [{ event: 'a' }], 0);
    await journal.close();

    const statementsBefore = client.log.length;
    await expect(journal.highestSeq('acc')).rejects.toThrow('CassandraJournal is closed');
    expect(client.log.length).toBe(statementsBefore);
  });

  test('journal: a failed start() shuts down the owned client it created before it rejects', async () => {
    // Failing at connect: the client exists, and holds nothing yet.
    const refused = new LifecycleClient({ connects: [1] });
    const refusedJournal = new OwningCassandraJournal(refused);
    await expect(refusedJournal.start()).rejects.toThrow('cassandra not up yet');
    expect(refusedJournal.created).toBe(1);
    expect(refused.shutdowns).toBe(1);
    await refusedJournal.close();
    expect(refused.shutdowns).toBe(1);

    // Failing after connect, at the schema step: a live connection, which the
    // failed start ends itself instead of leaving it to a close() that may
    // never come.
    const unauthorized = new LifecycleClient({ firstCreate: true });
    const unauthorizedJournal = new OwningCassandraJournal(unauthorized);
    await expect(unauthorizedJournal.start()).rejects.toThrow(/no CREATE permission/);
    expect(unauthorized.holdsConnection).toBe(false);
    expect(unauthorized.shutdowns).toBe(1);
    await unauthorizedJournal.close();
    expect(unauthorized.shutdowns).toBe(1);
    expect(unauthorized.holdsConnection).toBe(false);
  });

  test('journal: a retried start() opens a fresh client, and close() shuts the live one down once', async () => {
    // A cassandra-driver client that was shut down does not connect again, so
    // the retry cannot reuse the client the failed start ended.
    const failed = new LifecycleClient({ connects: [1] });
    const fresh = new LifecycleClient();
    const journal = new OwningCassandraJournal([failed, fresh]);

    await expect(journal.start()).rejects.toThrow('cassandra not up yet');
    await journal.start();
    expect(journal.created).toBe(2);
    expect(failed.connects).toBe(1);
    expect(fresh.connects).toBe(1);
    expect(await journal.highestSeq('nobody')).toBe(0);

    await journal.close();
    await journal.close();
    expect(failed.shutdowns).toBe(1);
    expect(fresh.shutdowns).toBe(1);
    expect(fresh.holdsConnection).toBe(false);
  });

  test('journal: close() leaves an injected client running, whether or not a start failed', async () => {
    const client = new LifecycleClient({ connects: [1] });
    const journalOptions = CassandraJournalOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client);
    const journal = new CassandraJournal(journalOptions);

    await expect(journal.start()).rejects.toThrow('cassandra not up yet');
    await journal.start();
    await journal.close();
    expect(client.shutdowns).toBe(0);
    expect(client.holdsConnection).toBe(true);
  });

  test('snapshot store: start() after close() rejects, and an operation after close() does too', async () => {
    const client = new LifecycleClient();
    const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('ks')
      .withClient(client);
    const store = new CassandraSnapshotStore(snapshotStoreOptions);
    await store.save('pid', 1, 'state');
    await store.close();

    await expect(store.start()).rejects.toThrow('CassandraSnapshotStore is closed');
    await expect(store.loadLatest('pid')).rejects.toThrow('CassandraSnapshotStore is closed');
    expect(client.connects).toBe(1);
  });

  test('snapshot store: a failed start() shuts down the owned client it created before it rejects', async () => {
    const client = new LifecycleClient({ firstCreate: true });
    const store = new OwningCassandraSnapshotStore(client);

    await expect(store.start()).rejects.toThrow(/no CREATE permission/);
    expect(store.created).toBe(1);
    expect(client.holdsConnection).toBe(false);
    expect(client.shutdowns).toBe(1);
    await store.close();
    expect(client.shutdowns).toBe(1);
    expect(client.holdsConnection).toBe(false);
  });

});

describe('CassandraQuery — a tag-index read opens the journal first (#1473)', () => {
  // The index path reads the journal's client itself, so it is the one read
  // that has to open the journal on its own; every other read goes through a
  // journal method that already does.
  test('a read on a journal that never started opens it', async () => {
    const client = new LifecycleClient();
    const journal = new OwningCassandraJournal(client, undefined, false, true);
    const query = new CassandraQuery(journal);

    expect(await query.currentEventsByTag({ all: ['t'] }, offsetStart)).toEqual([]);
    expect(journal.created).toBe(1);
    expect(client.connects).toBe(1);
    await journal.close();
  });

  test('a read after a failed start opens a fresh client instead of failing on the one the start shut down', async () => {
    const failed = new LifecycleClient({ firstCreate: true });
    const fresh = new LifecycleClient();
    const journal = new OwningCassandraJournal([failed, fresh], undefined, false, true);
    const query = new CassandraQuery(journal);

    await expect(journal.start()).rejects.toThrow(/no CREATE permission/);
    expect(await query.currentEventsByTag({ all: ['t'] }, offsetStart)).toEqual([]);
    expect(journal.created).toBe(2);
    expect(fresh.connects).toBe(1);
    expect(failed.holdsConnection).toBe(false);
    await journal.close();
    expect(fresh.holdsConnection).toBe(false);
  });

  test('a read after close() rejects as closed and sends nothing', async () => {
    const client = new LifecycleClient();
    const journal = new OwningCassandraJournal(client, undefined, false, true);
    const query = new CassandraQuery(journal);
    await journal.start();
    await journal.close();

    const statementsBefore = client.log.length;
    // The journal's own error, not one wrapped as a failed read.
    await expect(query.currentEventsByTag({ all: ['t'] }, offsetStart)).rejects.toThrow(/^CassandraJournal is closed$/);
    expect(client.log.length).toBe(statementsBefore);
  });
});

/** A start that fails at one step, after the store created its client. */
type FailedStart = {
  readonly step: string;
  readonly failing: () => LifecycleClient;
  readonly message: RegExp;
};

const failedStarts: FailedStart[] = [
  { step: 'its connect', failing: () => new LifecycleClient({ connects: [1] }), message: /cassandra not up yet/ },
  { step: 'its schema step', failing: () => new LifecycleClient({ firstCreate: true }), message: /no CREATE permission/ },
];

for (const owning of owningStores) {
  describe(`Cassandra ${owning.label} — a failed start() holds nothing it opened (#1473)`, () => {
    test.each(failedStarts)(
      'a start that failed at $step shuts its client down, and the retry opens a fresh one',
      async ({ failing, message }) => {
        const failed = failing();
        const fresh = new LifecycleClient();
        const store = owning.make([failed, fresh]);

        await expect(store.start()).rejects.toThrow(message);
        expect(failed.holdsConnection).toBe(false);
        expect(failed.shutdowns).toBe(1);

        await store.start();
        expect(store.created).toBe(2);
        expect(failed.connects).toBe(1);
        expect(fresh.connects).toBe(1);
        expect(fresh.holdsConnection).toBe(true);

        await store.close();
        expect(fresh.holdsConnection).toBe(false);
        expect(failed.shutdowns).toBe(1);
      },
    );
  });

  describe(`Cassandra ${owning.label} — close() racing a start() (#1473)`, () => {
    test('close() while the client is still being created connects nothing', async () => {
      const client = new LifecycleClient();
      const creating = heldOpen();
      const store = owning.make(client, creating.held);

      // `created` counts synchronously: the start is inside createClient now.
      const starting = store.start().then(() => 'started', (e: unknown) => (e as Error).message);
      expect(store.created).toBe(1);
      const closing = store.close();
      creating.release();
      await closing;

      expect(await starting).toBe(owning.closedMessage);
      expect(client.connects).toBe(0);
      expect(client.holdsConnection).toBe(false);
    });

    test('close() while start() is connecting leaves nothing connected', async () => {
      const client = new LifecycleClient();
      const connecting = heldOpen();
      client.heldConnect = connecting.held;
      const store = owning.make(client);

      const starting = store.start().then(() => 'started', (e: unknown) => (e as Error).message);
      // Close only once the start has created the client and reached its connect.
      await client.firstConnect;
      const closing = store.close();
      connecting.release();
      await closing;

      expect(await starting).toBe(owning.closedMessage);
      // Asserted once everything has settled: a close() that shut the client
      // down while its connect was still in flight did nothing, and the
      // connect completed afterwards — connected, behind a closed store.
      expect(client.holdsConnection).toBe(false);
      expect(client.shutdowns).toBe(1);
      // No DDL ran for a store nobody can use.
      expect(client.log.filter((statement) => statement.startsWith('CREATE'))).toEqual([]);
    });

    test('close() while the schema is being created fails that start and shuts the client down', async () => {
      const client = new LifecycleClient();
      const schema = heldOpen();
      client.heldCreate = schema.held;
      const store = owning.make(client);

      const starting = store.start().then(() => 'started', (e: unknown) => (e as Error).message);
      await client.firstCreate;
      const closing = store.close();
      schema.release();
      await closing;

      // The start that raced close() does not report success for a store
      // that is already closed.
      expect(await starting).toBe(owning.closedMessage);
      expect(client.holdsConnection).toBe(false);
    });

    test('close() while the keyspace is being created runs no table DDL after it', async () => {
      const client = new LifecycleClient();
      const keyspace = heldOpen();
      client.heldCreate = keyspace.held;
      const store = owning.make(client, undefined, true);

      const starting = store.start().then(() => 'started', (e: unknown) => (e as Error).message);
      await client.firstCreate;
      const closing = store.close();
      keyspace.release();
      await closing;

      expect(await starting).toBe(owning.closedMessage);
      // The keyspace statement was already on the wire when close() came; the
      // tables after it are DDL for a store nobody can use any more.
      const created = client.log
        .filter((statement) => statement.startsWith('CREATE'))
        .map((statement) => statement.split(' ').slice(0, 2).join(' '));
      expect(created).toEqual(['CREATE KEYSPACE']);
    });
  });
}
