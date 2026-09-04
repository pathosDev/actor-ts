import { JournalError, type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptionSupport } from '../PersistenceCapabilities.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';
import {
  createCassandraClient,
  keyspaceDdl,
  type CassandraClientLike,
  type CassandraConnection,
} from '../journals/CassandraClient.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import {
  DEFAULT_AUTO_CREATE_TABLES,
  DEFAULT_SNAPSHOTS_TABLE,
  DEFAULT_SNAPSHOT_KEEP_N,
  STORAGE_IDENTITY_TABLE,
} from '../Constants.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';
import type { StorageLocality } from '../StorageLocality.js';
import type { CassandraSnapshotStoreOptions, CassandraSnapshotStoreOptionsType } from './CassandraSnapshotStoreOptions.js';

type SnapshotRow = {
  persistence_id: string;
  sequence_nr: string | number;
  timestamp: string | number;
  payload: string;
};

/**
 * SnapshotStore backed by Cassandra/Scylla.  Schema mirrors the journal:
 * clustered on `sequence_nr DESC` so `loadLatest` is a single-row read.
 * When `keepN > 0`, excess snapshots are pruned on each `save`.
 */
export class CassandraSnapshotStore implements SnapshotStore {
  /** A Cassandra/Scylla cluster any node can reach (#1356). */
  readonly storageLocality: StorageLocality = 'shared';

  /** JSON text in a CQL column — `options` is bound and never read (#960). */
  readonly persistenceOptionSupport: PersistenceOptionSupport = {
    encryption: false,
    compression: false,
    integrity: false,
  };

  private cachedStorageIdentity: string | null = null;

  /** Identity of the keyspace's database — journal and snapshot store over one keyspace share it (#1358). */
  async storageIdentity(): Promise<string> {
    if (this.cachedStorageIdentity !== null) return this.cachedStorageIdentity;
    await this.ensureStarted();
    const table = this.qualifiedStorageIdentityTable();
    if (this.options.autoCreateTables ?? DEFAULT_AUTO_CREATE_TABLES) {
      await this.client.execute(
        `CREATE TABLE IF NOT EXISTS ${table} ( singleton int PRIMARY KEY, identity text )`,
      );
    }
    // The LWT claim — losing to the journal on the same keyspace is the expected path.
    await this.client.execute(
      `INSERT INTO ${table} (singleton, identity) VALUES (?, ?) IF NOT EXISTS`,
      [1, crypto.randomUUID()],
      this.readOptions(),
    );
    const response = await this.client.execute(
      `SELECT identity FROM ${table} WHERE singleton = ?`,
      [1],
      this.readOptions(),
    );
    const identity = (response.rows[0] as { identity?: unknown } | undefined)?.identity;
    if (typeof identity !== 'string' || identity.length === 0) {
      throw new JournalError('CassandraSnapshotStore.storageIdentity: identity row missing after insert');
    }
    this.cachedStorageIdentity = identity;
    return identity;
  }

  private qualifiedStorageIdentityTable(): string {
    // Same join `qualified()` performs for the snapshots table — including
    // its behaviour for an unset keyspace — so the identity table always
    // lands beside the data it identifies.
    const keyspace = this.options.keyspace;
    if (keyspace !== undefined) assertSafeIdentifier(keyspace, 'keyspace');
    return `${keyspace}.${STORAGE_IDENTITY_TABLE}`;
  }

  private readonly options: Partial<CassandraSnapshotStoreOptionsType>;
  private client: CassandraClientLike;
  private started = false;
  /** Single-flight guard so two concurrent first calls don't both connect + run DDL. */
  private startPromise: Promise<void> | null = null;
  private stopped = false;
  private readonly ownsClient: boolean;
  private readonly keepN: number;

  constructor(options: CassandraSnapshotStoreOptions) {
    this.options = (options as CassandraSnapshotStoreOptionsType);
    this.client = this.options.client ?? (undefined as unknown as CassandraClientLike);
    this.ownsClient = !this.options.client;
    this.keepN = this.options.keepN ?? DEFAULT_SNAPSHOT_KEEP_N;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.startPromise) {
      this.startPromise = this.doStart().catch((e) => {
        this.startPromise = null;
        throw e;
      });
    }
    await this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.ownsClient && !(this.client as unknown)) {
      this.client = await createCassandraClient(this.options as CassandraConnection);
    }
    await this.client.connect();
    if (this.options.autoCreateKeyspace) {
      await this.client.execute(keyspaceDdl(this.options as CassandraConnection));
    }
    if (this.options.autoCreateTables ?? DEFAULT_AUTO_CREATE_TABLES) {
      await this.ensureTables();
    }
    this.started = true;
  }

  /** CQL query options for data-path reads/writes, honouring the configured consistency level. */
  private readOptions(): { prepare: boolean; consistency?: number } {
    return this.options.consistency === undefined
      ? { prepare: true }
      : { prepare: true, consistency: this.options.consistency };
  }

  async save<S>(persistenceId: string, seq: number, state: S, _options?: PersistenceOptions): Promise<Snapshot<S>> {
    // Cassandra store has no compression / encryption — options ignored.
    await this.ensureStarted();
    const now = Date.now();
    const payload = encodePayload(state, this.options.serializer);
    try {
      await this.client.execute(
        `INSERT INTO ${this.qualified()} (persistence_id, sequence_nr, timestamp, payload) VALUES (?, ?, ?, ?)`,
        [persistenceId, seq, now, payload],
        this.readOptions(),
      );
    } catch (e) {
      throw new JournalError(`CassandraSnapshotStore.save failed: ${(e as Error).message}`, e);
    }
    // Best-effort prune — outside the write's catch on purpose.  See the
    // retention note on `SnapshotStore.save`.
    if (this.keepN > 0) {
      try { await this.pruneKeepN(persistenceId); } catch { /* swallow */ }
    }
    return { persistenceId: persistenceId, sequenceNr: seq, state, timestamp: now };
  }

  async loadLatest<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    await this.ensureStarted();
    const response = await this.client.execute(
      `SELECT persistence_id, sequence_nr, timestamp, payload FROM ${this.qualified()} WHERE persistence_id = ? LIMIT 1`,
      [persistenceId],
      this.readOptions(),
    );
    return this.rowToSnapshot<S>(response.rows[0] as unknown as SnapshotRow | undefined);
  }

  async loadBefore<S>(persistenceId: string, seq: number, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    await this.ensureStarted();
    const response = await this.client.execute(
      `SELECT persistence_id, sequence_nr, timestamp, payload FROM ${this.qualified()} WHERE persistence_id = ? AND sequence_nr < ? LIMIT 1`,
      [persistenceId, seq],
      this.readOptions(),
    );
    return this.rowToSnapshot<S>(response.rows[0] as unknown as SnapshotRow | undefined);
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    await this.ensureStarted();
    try {
      await this.client.execute(
        `DELETE FROM ${this.qualified()} WHERE persistence_id = ? AND sequence_nr <= ?`,
        [persistenceId, toSeq],
        this.readOptions(),
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

  private get table(): string { return this.options.snapshotsTable ?? DEFAULT_SNAPSHOTS_TABLE; }
  private qualified(): string {
    // keyspace + table are interpolated into CQL (identifiers can't be bound),
    // so validate them against a safe charset (security audit #6 / #136).
    const keyspace = this.options.keyspace;
    if (keyspace !== undefined) assertSafeIdentifier(keyspace, 'keyspace');
    return `${keyspace}.${assertSafeIdentifier(this.table, 'snapshots table')}`;
  }

  private rowToSnapshot<S>(row: SnapshotRow | undefined): Option<Snapshot<S>> {
    if (!row) return none;
    return some({
      persistenceId: row.persistence_id,
      sequenceNr: Number(row.sequence_nr),
      timestamp: Number(row.timestamp),
      state: decodePayload(row.payload, this.options.serializer) as S,
    });
  }

  private async pruneKeepN(persistenceId: string): Promise<void> {
    // Read the newest `keepN` sequence numbers and delete everything older.
    const response = await this.client.execute(
      `SELECT sequence_nr FROM ${this.qualified()} WHERE persistence_id = ? LIMIT ?`,
      [persistenceId, this.keepN],
      this.readOptions(),
    );
    const rows = response.rows as unknown as Array<{ sequence_nr: string | number }>;
    if (rows.length < this.keepN) return; // not yet at the cap
    const cutoff = Number(rows[rows.length - 1]!.sequence_nr);
    if (cutoff <= 0) return;
    await this.client.execute(
      `DELETE FROM ${this.qualified()} WHERE persistence_id = ? AND sequence_nr < ?`,
      [persistenceId, cutoff],
      this.readOptions(),
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
