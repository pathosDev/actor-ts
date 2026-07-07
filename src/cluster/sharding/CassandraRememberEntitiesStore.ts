import type { CassandraClientLike, CassandraConnection } from '../../persistence/journals/CassandraClient.js';
import { createCassandraClient, keyspaceDdl } from '../../persistence/journals/CassandraClient.js';
import type { CassandraRememberEntitiesStoreOptions } from './CassandraRememberEntitiesStoreOptions.js';
import type { RememberEntitiesStore, RememberEvent } from './RememberEntitiesStore.js';

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
export interface CassandraRememberEntitiesStoreSettings extends CassandraConnection {
  /** Table for the remember-entities state.  Default: `remember_entities`. */
  readonly table?: string;
  /** Auto-create the table on first use.  Default: `true`. */
  readonly autoCreateTables?: boolean;
  /**
   * Inject a pre-built CQL client.  When omitted, the store
   * instantiates its own (via `cassandra-driver`) — but typical
   * deployments share one client across journal + snapshot store +
   * remember-entities, so passing the existing one in is the
   * recommended pattern.
   */
  readonly client?: CassandraClientLike;
}

interface RememberRow {
  type_name: string;
  shard_id: string | number;
  entity_id: string;
  started_at: string | number;
}

export class CassandraRememberEntitiesStore implements RememberEntitiesStore {
  private readonly options: Partial<CassandraRememberEntitiesStoreSettings>;
  private client: CassandraClientLike;
  private readonly ownsClient: boolean;
  private started = false;
  private stopped = false;

  constructor(options: CassandraRememberEntitiesStoreOptions | Partial<CassandraRememberEntitiesStoreSettings>) {
    this.options = (options as Partial<CassandraRememberEntitiesStoreSettings>);
    this.client = this.options.client ?? (undefined as unknown as CassandraClientLike);
    this.ownsClient = !this.options.client;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.ownsClient && !this.client) {
      this.client = await createCassandraClient(this.options as CassandraConnection);
    }
    await this.client.connect();
    if (this.options.autoCreateKeyspace) {
      await this.client.execute(keyspaceDdl(this.options as CassandraConnection));
    }
    if (this.options.autoCreateTables ?? true) {
      await this.client.execute(rememberEntitiesDdl({
        keyspace: this.options.keyspace as string,
        table: this.options.table,
      }));
    }
    this.started = true;
  }

  async append(typeName: string, event: RememberEvent): Promise<void> {
    await this.ensureStarted();
    if (event.kind === 'started') {
      // Upsert — the same `(type, shard, entity)` re-starting overwrites
      // the previous `started_at` with a fresh timestamp.  The coordinator
      // only ever calls `'started'` once per entity per lifecycle, but
      // re-runs after a coordinator crash MAY emit duplicates and the
      // upsert handles them idempotently.
      await this.client.execute(
        `INSERT INTO ${this.qualified()} (type_name, shard_id, entity_id, started_at) VALUES (?, ?, ?, ?)`,
        [typeName, event.shardId, event.entityId, Date.now()],
        { prepare: true },
      );
      return;
    }
    // 'stopped' — point delete on the full primary key.
    await this.client.execute(
      `DELETE FROM ${this.qualified()} WHERE type_name = ? AND shard_id = ? AND entity_id = ?`,
      [typeName, event.shardId, event.entityId],
      { prepare: true },
    );
  }

  async load(typeName: string): Promise<RememberEvent[]> {
    await this.ensureStarted();
    const res = await this.client.execute(
      `SELECT type_name, shard_id, entity_id, started_at FROM ${this.qualified()} WHERE type_name = ?`,
      [typeName],
      { prepare: true },
    );
    const rows = res.rows as unknown as RememberRow[];
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
      { prepare: true },
    );
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ownsClient && this.started) {
      try { await this.client.shutdown(); } catch { /* ignore */ }
    }
  }

  /* ============================== internals ============================== */

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    await this.start();
  }

  private get table(): string { return this.options.table ?? 'remember_entities'; }

  private qualified(): string {
    return `${this.options.keyspace}.${this.table}`;
  }
}

/**
 * DDL for the remember-entities state table populated by
 * {@link CassandraRememberEntitiesStore} (#84).  Returned as a
 * runnable CQL string so operators applying schemas by hand can
 * mirror the store's exact layout — same pattern as
 * {@link tagIndexDdl} from #44.
 */
export function rememberEntitiesDdl(args: {
  readonly keyspace: string;
  readonly table?: string;
}): string {
  const table = args.table ?? 'remember_entities';
  return `CREATE TABLE IF NOT EXISTS ${args.keyspace}.${table} (`
    + ` type_name text,`
    + ` shard_id int,`
    + ` entity_id text,`
    + ` started_at bigint,`
    + ` PRIMARY KEY ((type_name), shard_id, entity_id)`
    + ` ) WITH CLUSTERING ORDER BY (shard_id ASC, entity_id ASC)`;
}
