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
import type { CassandraClientLike, CassandraRowResult } from '../../../../../src/persistence/index.js';
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

  test('callers sharing a start that fails all see the failure, and the next call retries on the same client', async () => {
    const client = new LifecycleClient({ connects: [1] });
    const store = new OwningCassandraRememberEntitiesStore(() => client);

    const outcomes = await Promise.allSettled([store.load('orders'), store.load('users')]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(client.connects).toBe(1);

    // The failed start does not stay cached: the guard clears, and the retry
    // reuses the client the failed attempt created.
    expect(await store.load('orders')).toEqual([]);
    expect(store.created).toHaveLength(1);
    expect(client.connects).toBe(2);

    await store.close();
    expect(client.shutdowns).toBe(1);
    expect(client.holdsConnection).toBe(false);
  });
});
