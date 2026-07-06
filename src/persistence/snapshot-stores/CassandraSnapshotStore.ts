import { JournalError, type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import {
  createCassandraClient,
  keyspaceDdl,
  type CassandraClientLike,
  type CassandraConnection,
} from '../journals/CassandraClient.js';

export interface CassandraSnapshotStoreSettings extends CassandraConnection {
  /** Table name; default `snapshots`. */
  readonly snapshotsTable?: string;
  /** Maximum number of snapshots kept per pid.  `<= 0` = keep all.  Default: 3. */
  readonly keepN?: number;
  /** Auto-create the snapshots table on first connect. */
  readonly autoCreateTables?: boolean;
  /** Pre-built client — bypass internal construction (share with journal). */
  readonly client?: CassandraClientLike;
}

/**
 * Fluent builder for {@link CassandraSnapshotStoreSettings}:
 *
 *     new CassandraSnapshotStore(
 *       CassandraSnapshotStoreOptions.create()
 *         .withContactPoints(['10.0.0.1'])
 *         .withKeyspace('app')
 *         .withKeepN(5),
 *     )
 *
 * Carries `withX` methods for the shared {@link CassandraConnection}
 * fields too — the connection mixin is not built on its own.
 */
export class CassandraSnapshotStoreOptions extends OptionsBuilder<CassandraSnapshotStoreSettings> {
  /** Start a fresh builder.  Equivalent to `new CassandraSnapshotStoreOptions()`. */
  static create(): CassandraSnapshotStoreOptions {
    return new CassandraSnapshotStoreOptions();
  }

  /* --- shared CassandraConnection fields --- */

  /** Node(s) to seed the cluster topology from. */
  withContactPoints(contactPoints: ReadonlyArray<string>): this {
    return this.set('contactPoints', contactPoints);
  }

  /** Local DC — required for DCAwareRoundRobinPolicy.  Defaults to `datacenter1`. */
  withLocalDataCenter(localDataCenter: string): this {
    return this.set('localDataCenter', localDataCenter);
  }

  /** Keyspace to `USE` after connect.  Must already exist, or pass `withAutoCreateKeyspace(true)`. */
  withKeyspace(keyspace: string): this {
    return this.set('keyspace', keyspace);
  }

  /** Username/password for PLAIN auth. */
  withCredentials(username: string, password: string): this {
    return this.set('credentials', { username, password });
  }

  /** Port — defaults to 9042. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** If true, create the keyspace on startup (simple strategy, rf=1). */
  withAutoCreateKeyspace(autoCreateKeyspace = true): this {
    return this.set('autoCreateKeyspace', autoCreateKeyspace);
  }

  /** Replication settings used by autoCreateKeyspace.  Ignored otherwise. */
  withReplication(replication: NonNullable<CassandraSnapshotStoreSettings['replication']>): this {
    return this.set('replication', replication);
  }

  /** CQL consistency level for all reads and writes.  Default `LOCAL_QUORUM` (6). */
  withConsistency(consistency: number): this {
    return this.set('consistency', consistency);
  }

  /* --- snapshot-store-specific fields --- */

  /** Table name; default `snapshots`. */
  withSnapshotsTable(snapshotsTable: string): this {
    return this.set('snapshotsTable', snapshotsTable);
  }

  /** Maximum number of snapshots kept per pid.  `<= 0` = keep all.  Default: 3. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }

  /** Auto-create the snapshots table on first connect. */
  withAutoCreateTables(autoCreateTables = true): this {
    return this.set('autoCreateTables', autoCreateTables);
  }

  /** Pre-built client — bypass internal construction (share with journal). */
  withClient(client: CassandraClientLike): this {
    return this.set('client', client);
  }
}

interface SnapshotRow {
  persistence_id: string;
  sequence_nr: string | number;
  timestamp: string | number;
  payload: string;
}

/**
 * SnapshotStore backed by Cassandra/Scylla.  Schema mirrors the journal:
 * clustered on `sequence_nr DESC` so `loadLatest` is a single-row read.
 * When `keepN > 0`, excess snapshots are pruned on each `save`.
 */
export class CassandraSnapshotStore implements SnapshotStore {
  private readonly options: Partial<CassandraSnapshotStoreSettings>;
  private client: CassandraClientLike;
  private started = false;
  private stopped = false;
  private readonly ownsClient: boolean;
  private readonly keepN: number;

  constructor(options: CassandraSnapshotStoreOptions) {
    this.options = options.build();
    this.client = this.options.client ?? (undefined as unknown as CassandraClientLike);
    this.ownsClient = !this.options.client;
    this.keepN = this.options.keepN ?? 3;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.ownsClient && !(this.client as unknown)) {
      this.client = await createCassandraClient(this.options as CassandraConnection);
    }
    await this.client.connect();
    if (this.options.autoCreateKeyspace) {
      await this.client.execute(keyspaceDdl(this.options as CassandraConnection));
    }
    if (this.options.autoCreateTables ?? true) {
      await this.ensureTables();
    }
    this.started = true;
  }

  async save<S>(pid: string, seq: number, state: S, _options?: PersistenceOptions): Promise<Snapshot<S>> {
    // Cassandra store has no compression / encryption — options ignored.
    await this.ensureStarted();
    const now = Date.now();
    const payload = JSON.stringify(state);
    try {
      await this.client.execute(
        `INSERT INTO ${this.qualified()} (persistence_id, sequence_nr, timestamp, payload) VALUES (?, ?, ?, ?)`,
        [pid, seq, now, payload],
        { prepare: true },
      );
      if (this.keepN > 0) await this.pruneKeepN(pid);
      return { persistenceId: pid, sequenceNr: seq, state, timestamp: now };
    } catch (e) {
      throw new JournalError(`CassandraSnapshotStore.save failed: ${(e as Error).message}`, e);
    }
  }

  async loadLatest<S>(pid: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    await this.ensureStarted();
    const res = await this.client.execute(
      `SELECT persistence_id, sequence_nr, timestamp, payload FROM ${this.qualified()} WHERE persistence_id = ? LIMIT 1`,
      [pid],
      { prepare: true },
    );
    return this.rowToSnapshot<S>(res.rows[0] as unknown as SnapshotRow | undefined);
  }

  async loadBefore<S>(pid: string, seq: number, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    await this.ensureStarted();
    const res = await this.client.execute(
      `SELECT persistence_id, sequence_nr, timestamp, payload FROM ${this.qualified()} WHERE persistence_id = ? AND sequence_nr < ? LIMIT 1`,
      [pid, seq],
      { prepare: true },
    );
    return this.rowToSnapshot<S>(res.rows[0] as unknown as SnapshotRow | undefined);
  }

  async delete(pid: string, toSeq: number): Promise<void> {
    await this.ensureStarted();
    try {
      await this.client.execute(
        `DELETE FROM ${this.qualified()} WHERE persistence_id = ? AND sequence_nr <= ?`,
        [pid, toSeq],
        { prepare: true },
      );
    } catch (e) {
      throw new JournalError(`CassandraSnapshotStore.delete failed: ${(e as Error).message}`, e);
    }
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ownsClient && this.started) {
      try { await this.client.shutdown(); } catch { /* ignore */ }
    }
  }

  /* ========================== internal ========================== */

  private get table(): string { return this.options.snapshotsTable ?? 'snapshots'; }
  private qualified(): string { return `${this.options.keyspace}.${this.table}`; }

  private rowToSnapshot<S>(row: SnapshotRow | undefined): Option<Snapshot<S>> {
    if (!row) return none;
    return some({
      persistenceId: row.persistence_id,
      sequenceNr: Number(row.sequence_nr),
      timestamp: Number(row.timestamp),
      state: JSON.parse(row.payload) as S,
    });
  }

  private async pruneKeepN(pid: string): Promise<void> {
    // Read the newest `keepN` sequence numbers and delete everything older.
    const res = await this.client.execute(
      `SELECT sequence_nr FROM ${this.qualified()} WHERE persistence_id = ? LIMIT ?`,
      [pid, this.keepN],
      { prepare: true },
    );
    const rows = res.rows as unknown as Array<{ sequence_nr: string | number }>;
    if (rows.length < this.keepN) return; // not yet at the cap
    const cutoff = Number(rows[rows.length - 1]!.sequence_nr);
    if (cutoff <= 0) return;
    await this.client.execute(
      `DELETE FROM ${this.qualified()} WHERE persistence_id = ? AND sequence_nr < ?`,
      [pid, cutoff],
      { prepare: true },
    );
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    await this.start();
  }

  private async ensureTables(): Promise<void> {
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS ${this.qualified()} (`
      + ` persistence_id text,`
      + ` sequence_nr bigint,`
      + ` timestamp bigint,`
      + ` payload text,`
      + ` PRIMARY KEY (persistence_id, sequence_nr)`
      + ` ) WITH CLUSTERING ORDER BY (sequence_nr DESC)`,
    );
  }
}
