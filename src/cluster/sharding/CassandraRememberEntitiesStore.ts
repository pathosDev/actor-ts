import { match } from 'ts-pattern';
import { JournalError } from '../../persistence/JournalTypes.js';
import type { CassandraClientLike, CassandraConnection } from '../../persistence/journals/CassandraClient.js';
import { createCassandraClient, keyspaceDdl } from '../../persistence/journals/CassandraClient.js';
import { assertSafeIdentifier } from '../../persistence/storage/SqlIdentifier.js';
import type { CassandraRememberEntitiesStoreOptions, CassandraRememberEntitiesStoreOptionsType } from './CassandraRememberEntitiesStoreOptions.js';
import type { RememberEntitiesStore, RememberEvent, StartedEvent, StoppedEvent } from './RememberEntitiesStore.js';

type RememberRow = {
  type_name: string;
  shard_id: string | number;
  entity_id: string;
  started_at: string | number;
};

/**
 * Cassandra-backed `RememberEntitiesStore` for `ClusterSharding` (#84)
 * — the natural complement to the existing `JournalRememberEntitiesStore`
 * for deployments using Cassandra/Scylla as their event journal.
 *
 * **Schema design.**  State-based, not event-sourced.  Each known
 * (type, shard, entity) triple lives as a single row with a
 * `started_at` timestamp; `stopped` events translate into a row
 * delete, `started` events into an upsert.  This is materially
 * cheaper to reload than the journal-backed implementation (one
 * partition scan vs. replaying every lifecycle event ever recorded
 * for the type) at the cost of losing history — but the
 * coordinator only needs the **current** entity set.
 *
 * **Partition layout.**  Partition key is `type_name`; clustering
 * key is `(shard_id, entity_id)`.  Every entity for a given sharded
 * type lands in one partition.  Acceptable for typical workloads
 * (thousands of entities per type, fits comfortably in a single
 * Cassandra partition); for very large entity sets, switch to the
 * journal-backed store or split the partition by `shard_id` (the
 * standard Cassandra "wide-row → composite-key" workaround).
 *
 * **`clear` semantics.**  Issues `DELETE FROM tbl WHERE type_name = ?`
 * — a whole-partition delete, atomic in Cassandra.  Scoping resets to
 * one type at a time matches `JournalRememberEntitiesStore`.
 *
 * **Replay shape.**  `load` returns synthetic `'started'` events for
 * every row currently in the partition.  No `'stopped'` events are
 * emitted because they were applied via DELETE at write time —
 * `ShardCoordinator` reapplies the result to its in-memory map and
 * arrives at the same `entitiesPerShard` view the event-replay
 * variant produces.
 */
export class CassandraRememberEntitiesStore implements RememberEntitiesStore {
  private readonly options: Partial<CassandraRememberEntitiesStoreOptionsType>;
  private client: CassandraClientLike;
  private readonly ownsClient: boolean;
  private started = false;
  /** Single-flight guard so two concurrent first calls don't both connect + run DDL. */
  private startPromise: Promise<void> | null = null;
  /** Set by `close()`: from then on `start()` and every operation reject, and shutdown happens once. */
  private stopped = false;

  constructor(options: CassandraRememberEntitiesStoreOptions) {
    this.options = (options as Partial<CassandraRememberEntitiesStoreOptionsType>);
    this.client = this.options.client ?? (undefined as unknown as CassandraClientLike);
    this.ownsClient = !this.options.client;
  }

  /**
   * Explicitly connect + ensure schema.  Called lazily on first use.
   * Single-flight, as the journal's and the snapshot store's `start()` have
   * been since #380: every coordinator awaits `load(typeName)` in its
   * preStart, so one store serving several sharded types sees concurrent
   * first calls as a matter of course — and without the guard each of them
   * built and connected its own client, of which `close()` could end only
   * the last (#1491).  A failed start shuts down a client it created and
   * clears the guard, so a later call retries on a fresh client.  After
   * `close()` it rejects instead of reconnecting, as the persistence stores'
   * `start()` has since #1473 — a store closed before it ever started used to
   * build and connect a fresh owned client nothing would shut down.
   */
  async start(): Promise<void> {
    this.throwIfClosed();
    if (this.started) return;
    if (!this.startPromise) {
      this.startPromise = this.doStart().catch((e) => {
        this.startPromise = null;
        throw e;
      });
    }
    await this.startPromise;
  }

  /**
   * Build the client this store owns, on the first start when none was
   * injected.  The seam `CassandraJournal.createClient` describes — override
   * it in a test to hand the store a fake it still treats as its own, since
   * `cassandra-driver` is an optional peer the unit tests do not install.
   */
  protected async createClient(): Promise<CassandraClientLike> {
    return createCassandraClient(this.options as CassandraConnection);
  }

  private async doStart(): Promise<void> {
    if (this.ownsClient && !this.client) {
      this.client = await this.createClient();
    }
    try {
      // Re-checked after every wait: a start that finds the store closed stops
      // rather than connecting, or creating a keyspace or table, for nobody.
      this.throwIfClosed();
      await this.client.connect();
      this.throwIfClosed();
      if (this.options.autoCreateKeyspace) {
        await this.client.execute(keyspaceDdl(this.options as CassandraConnection));
        this.throwIfClosed();
      }
      if (this.options.autoCreateTables ?? true) {
        await this.client.execute(rememberEntitiesDdl({
          keyspace: this.options.keyspace as string,
          table: this.options.table,
        }));
      }
      this.throwIfClosed();
    } catch (e) {
      await this.shutDownFailedClient();
      throw e;
    }
    this.started = true;
  }

  /**
   * A failed start holds nothing it opened (#1473), as in the journal and the
   * snapshot store built on the same connection: an owned client is shut down
   * before the rejection surfaces, and dropped, so the next start creates a
   * fresh one — `CassandraJournal.shutDownFailedClient` says why it cannot be
   * kept.  An injected client is the caller's and stays.
   */
  private async shutDownFailedClient(): Promise<void> {
    if (!this.ownsClient || !this.client) return;
    const client = this.client;
    this.client = undefined as unknown as CassandraClientLike;
    try { await client.shutdown(); } catch { /* the start's own failure is the one to report */ }
  }

  async append(typeName: string, event: RememberEvent): Promise<void> {
    await this.ensureStarted();
    await match(event)
      .with({ kind: 'started' }, (e) => this.onStarted(typeName, e))
      .with({ kind: 'stopped' }, (e) => this.onStopped(typeName, e))
      .exhaustive();
  }

  /**
   * Upsert — the same `(type, shard, entity)` re-starting overwrites the
   * previous `started_at` with a fresh timestamp.  The coordinator only ever
   * calls `'started'` once per entity per lifecycle, but re-runs after a
   * coordinator crash MAY emit duplicates and the upsert handles them
   * idempotently.
   */
  private async onStarted(typeName: string, event: StartedEvent): Promise<void> {
    await this.client.execute(
      `INSERT INTO ${this.qualified()} (type_name, shard_id, entity_id, started_at) VALUES (?, ?, ?, ?)`,
      [typeName, event.shardId, event.entityId, Date.now()],
      this.readOptions(),
    );
  }

  /** Point delete on the full primary key. */
  private async onStopped(typeName: string, event: StoppedEvent): Promise<void> {
    await this.client.execute(
      `DELETE FROM ${this.qualified()} WHERE type_name = ? AND shard_id = ? AND entity_id = ?`,
      [typeName, event.shardId, event.entityId],
      this.readOptions(),
    );
  }

  async load(typeName: string): Promise<RememberEvent[]> {
    await this.ensureStarted();
    const response = await this.client.execute(
      `SELECT type_name, shard_id, entity_id, started_at FROM ${this.qualified()} WHERE type_name = ?`,
      [typeName],
      this.readOptions(),
    );
    const rows = response.rows as unknown as RememberRow[];
    return rows.map((r): RememberEvent => ({
      kind: 'started',
      shardId: Number(r.shard_id),
      entityId: r.entity_id,
    }));
  }

  async clear(typeName: string): Promise<void> {
    await this.ensureStarted();
    await this.client.execute(
      `DELETE FROM ${this.qualified()} WHERE type_name = ?`,
      [typeName],
      this.readOptions(),
    );
  }

  /**
   * Stop the store: from here on `start()` and every operation reject.  A
   * start still in flight settles first: it sees the close at its next step
   * and fails, shutting down the client it is creating or connecting rather
   * than leaving it connected — the driver treats a shutdown before its
   * connect completes as a no-op, which is why it has to settle first.  What
   * is left below is a started client, since a start that failed shut its own
   * client down and dropped it.  An injected client is the caller's and is
   * left running.
   */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const pending = this.startPromise;
    if (pending !== null) {
      try { await pending; } catch { /* the caller that started it reports the failure */ }
    }
    if (this.ownsClient && this.client) {
      try { await this.client.shutdown(); } catch { /* ignore */ }
    }
  }

  /* ============================== internals ============================== */

  private throwIfClosed(): void {
    if (this.stopped) throw new JournalError('CassandraRememberEntitiesStore is closed');
  }

  /**
   * CQL query options for the four data-path statements, honouring the
   * configured consistency level — the journal's and the snapshot store's
   * `readOptions()`, which #380 wired and this third consumer of the same
   * connection never got (#1491).  Unset sends no `consistency` key at all, so
   * `cassandra-driver`'s own default applies; the schema statements in
   * `doStart()` stay at the driver default either way, as in the siblings.
   */
  private readOptions(): { prepare: boolean; consistency?: number } {
    return this.options.consistency === undefined
      ? { prepare: true }
      : { prepare: true, consistency: this.options.consistency };
  }

  private async ensureStarted(): Promise<void> {
    // Before the `started` shortcut: a store closed after it started has shut
    // its own client down, or must stop writing through an injected one —
    // either way the caller gets the closed error, not a driver's.
    this.throwIfClosed();
    if (this.started) return;
    await this.start();
  }

  private get table(): string { return this.options.table ?? 'remember_entities'; }

  private qualified(): string {
    // keyspace + table are interpolated into CQL (identifiers can't be bound),
    // so validate both against a safe charset — the guard CassandraJournal and
    // CassandraSnapshotStore have always applied, missing here (security audit
    // #615).  One string feeds four differently-shaped statements below, so an
    // injected name is not merely a bad table: it rewrites INSERT, DELETE and
    // SELECT alike.
    const keyspace = this.options.keyspace;
    if (keyspace !== undefined) assertSafeIdentifier(keyspace, 'keyspace');
    return `${keyspace}.${assertSafeIdentifier(this.table, 'remember-entities table')}`;
  }
}

/**
 * DDL for the remember-entities state table populated by
 * {@link CassandraRememberEntitiesStore} (#84).  Returned as a
 * runnable CQL string so operators applying schemas by hand can
 * mirror the store's exact layout — same pattern as
 * {@link tagIndexDdl} from #44.
 *
 * Not only an operator convenience: this *is* the store's auto-create path
 * (`autoCreateTables` defaults to true), so it needs the same identifier
 * guard `qualified()` applies — the siblings reach their CREATE TABLE
 * through their guarded `qualified()` and never had a second door (security
 * audit #615).
 */
export function rememberEntitiesDdl(args: {
  readonly keyspace: string;
  readonly table?: string;
}): string {
  const table = args.table ?? 'remember_entities';
  return `CREATE TABLE IF NOT EXISTS ${assertSafeIdentifier(args.keyspace, 'keyspace')}`
    + `.${assertSafeIdentifier(table, 'remember-entities table')} (`
    + ` type_name text,`
    + ` shard_id int,`
    + ` entity_id text,`
    + ` started_at bigint,`
    + ` PRIMARY KEY ((type_name), shard_id, entity_id)`
    + ` ) WITH CLUSTERING ORDER BY (shard_id ASC, entity_id ASC)`;
}
