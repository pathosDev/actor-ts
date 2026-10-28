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
import {
  JournalError,
  type CassandraClientLike,
  type CassandraRowResult,
} from '../../../../../src/persistence/index.js';
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
 * and can hold a connect or the schema step open until the test lets it
 * finish — the client `CassandraJournal.test.ts` drives the persistence
 * stores' lifecycle with (#1473), for the third store built on the same
 * connection.
 *
 * Its `shutdown()` behaves like `cassandra-driver`'s on the one point that
 * matters here: a client that has not finished connecting has nothing to shut
 * down yet, so the call returns, and a connect still in flight completes
 * afterwards, connected.  `holdsConnection` is what a leak looks like from
 * outside.
 */
class LifecycleClient extends FakeCassandraClient {
  connects = 0;
  shutdowns = 0;
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
 * A store that OWNS its client, as one built without `withClient` does — only
 * the client comes from `createClient` instead of `cassandra-driver`, which is
 * not installed here.  Ownership is the point: an injected client is the
 * caller's and is never shut down, so what the store does with a client it
 * created can only be seen through this seam.  Each call asks `newClient` for
 * the client, so a test that hands out a fresh one per call sees a second
 * construction as a second live connection.
 */
class OwningCassandraRememberEntitiesStore extends CassandraRememberEntitiesStore {
  readonly created: LifecycleClient[] = [];
  private readonly newClient: () => LifecycleClient;
  /** When given, client creation waits for it — a driver import still in flight. */
  private readonly creating: Promise<void> | undefined;

  constructor(newClient: () => LifecycleClient, creating?: Promise<void>) {
    const storeOptions = CassandraRememberEntitiesStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('sharding');
    super(storeOptions);
    this.newClient = newClient;
    this.creating = creating;
  }

  protected override async createClient(): Promise<CassandraClientLike> {
    const client = this.newClient();
    this.created.push(client);
    if (this.creating !== undefined) await this.creating;
    return client;
  }
}

/** A promise the test settles by hand — how a step is held in flight without a timer. */
function heldOpen(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release };
}

/** The schema statements a client saw — one per start that reached its DDL. */
const createStatements = (client: FakeCassandraClient): string[] =>
  client.log.filter((statement) => statement.startsWith('CREATE'));

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

// Every coordinator awaits `load(typeName)` in its preStart, and one store
// serving several sharded types is the shape the options recommend — so two
// first calls at once is the ordinary start-up, not a corner case.  The
// persistence stores have run a single start since #380; this one had none.
describe('CassandraRememberEntitiesStore — one start() at a time (#1491)', () => {
  test('two concurrent first calls on an owned client construct and connect one client, and close() ends it', async () => {
    const store = new OwningCassandraRememberEntitiesStore(() => new LifecycleClient());

    await Promise.all([store.load('orders'), store.load('users')]);

    expect(store.created).toHaveLength(1);
    const [client] = store.created;
    expect(client!.connects).toBe(1);
    expect(createStatements(client!)).toHaveLength(1);

    await store.close();
    // Every client the store built is closed — a second construction would
    // be a live connection nothing ever shuts down.
    expect(store.created.map((created) => created.holdsConnection)).toEqual([false]);
    expect(client!.shutdowns).toBe(1);
  });

  test('concurrent first calls on an injected client connect it once and run the schema once', async () => {
    const client = new LifecycleClient();
    const storeOptions = CassandraRememberEntitiesStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('sharding')
      .withAutoCreateKeyspace(true)
      .withClient(client);
    const store = new CassandraRememberEntitiesStore(storeOptions);

    await Promise.all([
      store.start(),
      store.load('orders'),
      store.append('users', { kind: 'started', shardId: 0, entityId: 'u1' }),
    ]);

    expect(client.connects).toBe(1);
    expect(createStatements(client).map((statement) => statement.split(' ').slice(0, 2).join(' ')))
      .toEqual(['CREATE KEYSPACE', 'CREATE TABLE']);
    await store.close();
  });

  test('callers sharing a start that fails all see the failure, and the next call retries on a fresh client', async () => {
    const failed = new LifecycleClient({ connects: [1] });
    const fresh = new LifecycleClient();
    const handedOut = [failed, fresh];
    const store = new OwningCassandraRememberEntitiesStore(() => handedOut.shift() ?? fresh);

    const outcomes = await Promise.allSettled([store.load('orders'), store.load('users')]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(failed.connects).toBe(1);
    // One shared start, one failure path: the client it created is shut down once.
    expect(failed.shutdowns).toBe(1);

    // The failed start does not stay cached: the guard clears, and the retry
    // opens a fresh client, since the failed one was shut down.
    expect(await store.load('orders')).toEqual([]);
    expect(store.created).toHaveLength(2);
    expect(failed.connects).toBe(1);
    expect(fresh.connects).toBe(1);

    await store.close();
    expect(fresh.shutdowns).toBe(1);
    expect(fresh.holdsConnection).toBe(false);
    expect(failed.shutdowns).toBe(1);
  });
});

/** An injected-client store over `client`, the way an application wires one it shares. */
function storeOver(client: LifecycleClient, autoCreateKeyspace = false): CassandraRememberEntitiesStore {
  const storeOptions = CassandraRememberEntitiesStoreOptions.create()
    .withContactPoints(['fake'])
    .withKeyspace('sharding')
    .withAutoCreateKeyspace(autoCreateKeyspace)
    .withClient(client);
  return new CassandraRememberEntitiesStore(storeOptions);
}

const closedMessage = 'CassandraRememberEntitiesStore is closed';

// The lifecycle the persistence stores got in 9783e6ae (#1473), for the third
// store built on the same Cassandra connection.
describe('CassandraRememberEntitiesStore — start() and close() (found while #1473)', () => {
  test('start() after close() rejects instead of connecting a client', async () => {
    // Owned and never started: closing first must not leave a start able to
    // build and connect a client nobody will shut down.
    const owned = new OwningCassandraRememberEntitiesStore(() => new LifecycleClient());
    await owned.close();
    await expect(owned.start()).rejects.toThrow(closedMessage);
    expect(owned.created).toHaveLength(0);

    const neverStarted = new LifecycleClient();
    const closedFirst = storeOver(neverStarted);
    await closedFirst.close();
    await expect(closedFirst.start()).rejects.toThrow(closedMessage);
    expect(neverStarted.connects).toBe(0);

    const started = new LifecycleClient();
    const closedAfterStart = storeOver(started);
    await closedAfterStart.start();
    await closedAfterStart.close();
    await expect(closedAfterStart.start()).rejects.toBeInstanceOf(JournalError);
    expect(started.connects).toBe(1);
  });

  test('an operation after close() rejects instead of reaching the client', async () => {
    const client = new LifecycleClient();
    const store = storeOver(client);
    await store.append('orders', { kind: 'started', shardId: 0, entityId: 'a' });
    await store.close();

    const statementsBefore = client.log.length;
    await expect(store.load('orders')).rejects.toThrow(closedMessage);
    await expect(store.append('orders', { kind: 'started', shardId: 0, entityId: 'b' }))
      .rejects.toThrow(closedMessage);
    await expect(store.append('orders', { kind: 'stopped', shardId: 0, entityId: 'a' }))
      .rejects.toThrow(closedMessage);
    await expect(store.clear('orders')).rejects.toThrow(closedMessage);
    expect(client.log.length).toBe(statementsBefore);
  });

  test('a failed start() shuts down the owned client it created before it rejects', async () => {
    // Failing at connect: the client exists, and holds nothing yet.
    const refused = new LifecycleClient({ connects: [1] });
    const refusedStore = new OwningCassandraRememberEntitiesStore(() => refused);
    await expect(refusedStore.start()).rejects.toThrow('cassandra not up yet');
    expect(refusedStore.created).toHaveLength(1);
    expect(refused.shutdowns).toBe(1);
    await refusedStore.close();
    expect(refused.shutdowns).toBe(1);

    // Failing after connect, at the schema step: a live connection, which the
    // failed start ends itself instead of leaving it to a close() that may
    // never come.
    const unauthorized = new LifecycleClient({ firstCreate: true });
    const unauthorizedStore = new OwningCassandraRememberEntitiesStore(() => unauthorized);
    await expect(unauthorizedStore.load('orders')).rejects.toThrow(/no CREATE permission/);
    expect(unauthorized.holdsConnection).toBe(false);
    expect(unauthorized.shutdowns).toBe(1);
    await unauthorizedStore.close();
    expect(unauthorized.shutdowns).toBe(1);
    expect(unauthorized.holdsConnection).toBe(false);
  });

  test('a load after a start that failed at the schema step opens a fresh client', async () => {
    const failed = new LifecycleClient({ firstCreate: true });
    const fresh = new LifecycleClient();
    const handedOut = [failed, fresh];
    const store = new OwningCassandraRememberEntitiesStore(() => handedOut.shift() ?? fresh);

    await expect(store.load('orders')).rejects.toThrow(/no CREATE permission/);
    expect(failed.holdsConnection).toBe(false);

    expect(await store.load('orders')).toEqual([]);
    expect(store.created).toHaveLength(2);
    expect(failed.connects).toBe(1);
    expect(fresh.connects).toBe(1);
    expect(fresh.holdsConnection).toBe(true);

    await store.close();
    expect(fresh.holdsConnection).toBe(false);
  });

  test('close() shuts an owned client down once, however often it is called', async () => {
    const client = new LifecycleClient();
    const store = new OwningCassandraRememberEntitiesStore(() => client);
    await store.load('orders');
    await store.close();
    await store.close();
    expect(client.shutdowns).toBe(1);
  });

  test('close() leaves an injected client running, whether or not a start failed', async () => {
    const client = new LifecycleClient({ connects: [1] });
    const store = storeOver(client);

    await expect(store.start()).rejects.toThrow('cassandra not up yet');
    await store.start();
    await store.close();
    expect(client.shutdowns).toBe(0);
    expect(client.holdsConnection).toBe(true);
  });
});

describe('CassandraRememberEntitiesStore — close() racing a start() (found while #1473)', () => {
  test('close() while the client is still being created connects nothing', async () => {
    const client = new LifecycleClient();
    const creating = heldOpen();
    const store = new OwningCassandraRememberEntitiesStore(() => client, creating.held);

    const starting = store.start().then(() => 'started', (e: unknown) => (e as Error).message);
    // `created` fills synchronously: the start is inside createClient now.
    expect(store.created).toHaveLength(1);
    const closing = store.close();
    creating.release();
    await closing;

    expect(await starting).toBe(closedMessage);
    expect(client.connects).toBe(0);
    expect(client.holdsConnection).toBe(false);
  });

  test('close() while start() is connecting leaves nothing connected and runs no schema', async () => {
    const client = new LifecycleClient();
    const connecting = heldOpen();
    client.heldConnect = connecting.held;
    const store = new OwningCassandraRememberEntitiesStore(() => client);

    const starting = store.start().then(() => 'started', (e: unknown) => (e as Error).message);
    // Close only once the start has created the client and reached its connect.
    await client.firstConnect;
    const closing = store.close();
    connecting.release();
    await closing;

    expect(await starting).toBe(closedMessage);
    // Asserted once everything has settled: a close() that shut the client
    // down while its connect was still in flight did nothing, and the connect
    // completed afterwards — connected, behind a closed store.
    expect(client.holdsConnection).toBe(false);
    expect(client.shutdowns).toBe(1);
    expect(createStatements(client)).toEqual([]);
  });

  test('close() while the table is being created fails that start and shuts the client down', async () => {
    const client = new LifecycleClient();
    const schema = heldOpen();
    client.heldCreate = schema.held;
    const store = new OwningCassandraRememberEntitiesStore(() => client);

    const starting = store.start().then(() => 'started', (e: unknown) => (e as Error).message);
    await client.firstCreate;
    const closing = store.close();
    schema.release();
    await closing;

    // The start that raced close() does not report success for a store that
    // is already closed.
    expect(await starting).toBe(closedMessage);
    expect(client.holdsConnection).toBe(false);
  });

  test('close() while the keyspace is being created runs no table DDL after it', async () => {
    const client = new LifecycleClient();
    const keyspace = heldOpen();
    client.heldCreate = keyspace.held;
    const store = storeOver(client, true);

    const starting = store.start().then(() => 'started', (e: unknown) => (e as Error).message);
    await client.firstCreate;
    const closing = store.close();
    keyspace.release();
    await closing;

    expect(await starting).toBe(closedMessage);
    expect(createStatements(client).map((statement) => statement.split(' ').slice(0, 2).join(' ')))
      .toEqual(['CREATE KEYSPACE']);
  });
});

/**
 * Records every statement with the options it went out with — the half
 * `FakeCassandraClient` drops, and the only place the consistency level a
 * statement asked for is visible.
 */
class RecordingCassandraClient extends FakeCassandraClient {
  readonly sent: Array<{ readonly statement: string; readonly options: ExecuteOptions | undefined }> = [];

  override async execute(
    query: string,
    params: ReadonlyArray<unknown> = [],
    options?: ExecuteOptions,
  ): Promise<CassandraRowResult> {
    this.sent.push({ statement: query.trim().replace(/\s+/g, ' '), options });
    return super.execute(query, params, options);
  }
}

/** The four data-path statements, told apart by their shape. */
const dataPathStatements = {
  'started INSERT': /^INSERT INTO sharding\.remember_entities /,
  'stopped point DELETE': /^DELETE FROM sharding\.remember_entities WHERE type_name = \? AND shard_id = \? AND entity_id = \?$/,
  'load SELECT': /^SELECT .+ FROM sharding\.remember_entities WHERE type_name = \?$/,
  'clear partition DELETE': /^DELETE FROM sharding\.remember_entities WHERE type_name = \?$/,
} as const;

/** Send each of the four once: an upsert, a point delete, a partition read and a partition delete. */
async function sendEveryDataPathStatement(store: CassandraRememberEntitiesStore): Promise<void> {
  await store.append('orders', { kind: 'started', shardId: 0, entityId: 'a' });
  await store.append('orders', { kind: 'stopped', shardId: 0, entityId: 'a' });
  await store.load('orders');
  await store.clear('orders');
}

/** The options each data-path statement went out with, keyed by its shape. */
function dataPathOptions(client: RecordingCassandraClient): Record<string, Array<ExecuteOptions | undefined>> {
  return Object.fromEntries(Object.entries(dataPathStatements).map(([shape, pattern]) => [
    shape,
    client.sent.filter((sent) => pattern.test(sent.statement)).map((sent) => sent.options),
  ]));
}

/** The options the schema statements went out with. */
const schemaOptions = (client: RecordingCassandraClient): Array<ExecuteOptions | undefined> =>
  client.sent.filter((sent) => sent.statement.startsWith('CREATE')).map((sent) => sent.options);

// The store took `consistency` through the shared CassandraConnection and
// read it nowhere: #380 threaded the level through the journal and the
// snapshot store and never reached this third consumer, so withConsistency()
// was silently dropped while the same setting on CassandraSnapshotStore went
// out on every statement.  FakeCassandraClient discards the options, hence the
// recording client.
describe('CassandraRememberEntitiesStore — consistency level is honoured (#1491)', () => {
  test('a configured level reaches every data-path statement, and the schema keeps the driver default', async () => {
    const client = new RecordingCassandraClient();
    const storeOptions = CassandraRememberEntitiesStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('sharding')
      .withAutoCreateKeyspace(true)
      .withConsistency(6)
      .withClient(client);
    const store = new CassandraRememberEntitiesStore(storeOptions);

    await sendEveryDataPathStatement(store);

    expect(dataPathOptions(client)).toStrictEqual({
      'started INSERT': [{ prepare: true, consistency: 6 }],
      'stopped point DELETE': [{ prepare: true, consistency: 6 }],
      'load SELECT': [{ prepare: true, consistency: 6 }],
      'clear partition DELETE': [{ prepare: true, consistency: 6 }],
    });
    // CREATE KEYSPACE and CREATE TABLE go out bare, as in the sibling stores.
    expect(schemaOptions(client)).toStrictEqual([undefined, undefined]);
    await store.close();
  });

  test('a plain options object carries the level the same way', async () => {
    const client = new RecordingCassandraClient();
    const store = new CassandraRememberEntitiesStore({
      contactPoints: ['fake'],
      keyspace: 'sharding',
      consistency: 1,
      client,
    });

    await sendEveryDataPathStatement(store);

    for (const options of Object.values(dataPathOptions(client))) {
      expect(options).toStrictEqual([{ prepare: true, consistency: 1 }]);
    }
    await store.close();
  });

  test('without a configured level, no consistency is sent and the driver decides', async () => {
    const client = new RecordingCassandraClient();
    const storeOptions = CassandraRememberEntitiesStoreOptions.create()
      .withContactPoints(['fake'])
      .withKeyspace('sharding')
      .withClient(client);
    const store = new CassandraRememberEntitiesStore(storeOptions);

    await sendEveryDataPathStatement(store);

    // Strict: a `consistency` key present with an undefined value is a key
    // the contract says is not sent.
    expect(dataPathOptions(client)).toStrictEqual({
      'started INSERT': [{ prepare: true }],
      'stopped point DELETE': [{ prepare: true }],
      'load SELECT': [{ prepare: true }],
      'clear partition DELETE': [{ prepare: true }],
    });
    await store.close();
  });
});
