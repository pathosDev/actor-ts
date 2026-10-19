import { getSqliteDriver, type SqliteDb, type SqliteStatement } from '../../runtime/sqlite/index.js';
import { JournalError, type Snapshot } from '../JournalTypes.js';
import type { PersistenceOptionSupport } from '../PersistenceCapabilities.js';
import type { PersistenceOptions } from '../PersistenceOptions.js';
import type { SnapshotStore } from '../SnapshotStore.js';
import { none, some, type Option } from '../../util/Option.js';
import { decodePayload, encodePayload } from '../storage/PayloadCodec.js';
import { assertSafeIdentifier } from '../storage/SqlIdentifier.js';
import { DEFAULT_SNAPSHOTS_TABLE, DEFAULT_SNAPSHOT_KEEP_N, STORAGE_IDENTITY_TABLE } from '../Constants.js';
import { applySqliteBusyTimeout } from '../journals/SqliteClient.js';
import { SqliteSnapshotStoreOptionsValidator } from './SqliteSnapshotStoreOptions.js';
import type { SqliteSnapshotStoreOptions, SqliteSnapshotStoreOptionsType } from './SqliteSnapshotStoreOptions.js';
import type { StorageLocality } from '../StorageLocality.js';

type Statements = {
  insert: SqliteStatement;
  latest: SqliteStatement;
  before: SqliteStatement;
  deleteUpTo: SqliteStatement;
  deleteOlderThan: SqliteStatement;
};

/**
 * SQLite-backed SnapshotStore — JSON payloads, single table, prune-on-save.
 * Works on Bun, Node and Deno via the `SqliteDriver` abstraction.
 * Construction is lazy (same pattern as `SqliteJournal`): the DB is opened on
 * the first save / load call, and an open that fails closes the handle it
 * opened and is retried by the next call rather than remembered (#1473).
 */
export class SqliteSnapshotStore implements SnapshotStore {
  private readonly options: SqliteSnapshotStoreOptionsType;
  /** The database {@link init} opens: a file or `':memory:'`, checked at construction (#1492). */
  private readonly path: string;
  private readonly table: string;
  private readonly keepN: number;
  /** A local file (or `:memory:`) no other node can reach (#1356). */
  readonly storageLocality: StorageLocality = 'node-local';

  /**
   * JSON text in a SQLite column — `options` is bound and never read (#960).
   * Declared here rather than inherited: this store is a standalone
   * `implements SnapshotStore` and shares no base with the relational
   * family, unlike its durable-state twin.
   */
  readonly persistenceOptionSupport: PersistenceOptionSupport = {
    encryption: false,
    compression: false,
    integrity: false,
  };

  private cachedStorageIdentity: string | null = null;
  private closed = false;

  /** Identity of the database file — see `STORAGE_IDENTITY_TABLE` for why it is unprefixed (#1358). */
  async storageIdentity(): Promise<string> {
    if (this.cachedStorageIdentity !== null) return this.cachedStorageIdentity;
    await this.ensureOpen();
    const database = this.db!;
    database
      .prepare(`INSERT OR IGNORE INTO ${STORAGE_IDENTITY_TABLE}(singleton, identity) VALUES (1, ?)`)
      .run(crypto.randomUUID());
    const row = database
      .prepare(`SELECT identity FROM ${STORAGE_IDENTITY_TABLE} WHERE singleton = 1`)
      .get() as { identity: string } | null | undefined;
    if (row == null || typeof row.identity !== 'string' || row.identity.length === 0) {
      throw new JournalError('SqliteSnapshotStore.storageIdentity: identity row missing after insert');
    }
    this.cachedStorageIdentity = row.identity;
    return row.identity;
  }

  private db: SqliteDb | null = null;
  private statements: Statements | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: SqliteSnapshotStoreOptions = {}) {
    const resolvedOptions = (options as SqliteSnapshotStoreOptionsType);
    new SqliteSnapshotStoreOptionsValidator().validate(resolvedOptions);
    this.options = resolvedOptions;
    // The validator refuses an absent, empty or remote path, so what is left
    // is the database to open — there is no default behind it.
    this.path = resolvedOptions.path as string;
    // Interpolated into DDL/DML — validate against SQL injection (#6).
    this.table = assertSafeIdentifier(resolvedOptions.snapshotsTable ?? DEFAULT_SNAPSHOTS_TABLE, 'snapshots table');
    this.keepN = resolvedOptions.keepN ?? DEFAULT_SNAPSHOT_KEEP_N;
  }

  async save<S>(persistenceId: string, seq: number, state: S, _options?: PersistenceOptions): Promise<Snapshot<S>> {
    // SQLite store has no compression / encryption — options ignored.
    await this.ensureOpen();
    const statements = this.statements!;
    const now = Date.now();
    try {
      statements.insert.run(persistenceId, seq, encodePayload(state, this.options.serializer), now);
    } catch (e) {
      throw new JournalError(`SqliteSnapshotStore.save failed: ${(e as Error).message}`, e);
    }
    // Best-effort prune — outside the write's catch on purpose.  See the
    // retention note on `SnapshotStore.save`.
    if (this.keepN > 0) {
      try { statements.deleteOlderThan.run(persistenceId, persistenceId, this.keepN); } catch { /* swallow */ }
    }
    return { persistenceId: persistenceId, sequenceNr: seq, state, timestamp: now };
  }

  async loadLatest<S>(persistenceId: string, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    await this.ensureOpen();
    const row = this.statements!.latest.get(persistenceId) as {
      persistence_id: string;
      sequence_nr: number;
      payload: string;
      timestamp: number;
    } | undefined;
    if (!row) return none;
    return some({
      persistenceId: row.persistence_id,
      sequenceNr: row.sequence_nr,
      state: decodePayload(row.payload, this.options.serializer) as S,
      timestamp: row.timestamp,
    });
  }

  async loadBefore<S>(persistenceId: string, seq: number, _options?: PersistenceOptions): Promise<Option<Snapshot<S>>> {
    await this.ensureOpen();
    const row = this.statements!.before.get(persistenceId, seq) as {
      persistence_id: string;
      sequence_nr: number;
      payload: string;
      timestamp: number;
    } | undefined;
    if (!row) return none;
    return some({
      persistenceId: row.persistence_id,
      sequenceNr: row.sequence_nr,
      state: decodePayload(row.payload, this.options.serializer) as S,
      timestamp: row.timestamp,
    });
  }

  async delete(persistenceId: string, toSeq: number): Promise<void> {
    await this.ensureOpen();
    this.statements!.deleteUpTo.run(persistenceId, toSeq);
  }

  /**
   * Open the database now instead of on the first operation (#1473) — the
   * single-flight open `SqliteJournal.start` describes, with the same rules.
   */
  async start(): Promise<void> {
    await this.ensureOpen();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.db?.close(); } catch { /* ignore */ }
  }

  /* --------------------------- internals -------------------------------- */

  private async ensureOpen(): Promise<void> {
    if (this.closed) throw new JournalError('SqliteSnapshotStore is closed');
    if (this.db && this.statements) return;
    if (!this.initPromise) {
      this.initPromise = this.init().catch((e: unknown) => {
        // Not remembered: the next call opens afresh.
        this.initPromise = null;
        throw e;
      });
    }
    await this.initPromise;
    // A close() while this caller waited has closed the handle it would use.
    if (this.closed) throw new JournalError('SqliteSnapshotStore is closed');
  }

  private async init(): Promise<void> {
    const driver = this.options.driver ?? await getSqliteDriver();
    // A close() while the driver resolved: opening now would leave a handle
    // nobody closes.
    if (this.closed) throw new JournalError('SqliteSnapshotStore is closed');
    const db = driver.open(this.path);
    let statements: Statements;
    try {
      statements = this.prepareDatabase(db);
    } catch (e) {
      // A failed open holds nothing: this handle is referenced by nobody else.
      try { db.close(); } catch { /* the open's own failure is the one to report */ }
      throw e;
    }
    this.db = db;
    this.statements = statements;
  }

  /** Busy timeout, schema and prepared statements, on a freshly opened handle. */
  private prepareDatabase(db: SqliteDb): Statements {
    // Before the DDL, not after: `CREATE TABLE` takes the write lock itself,
    // so a second process starting against the same file is the first thing
    // that can hit SQLITE_BUSY.
    applySqliteBusyTimeout(db, this.options.busyTimeoutMs);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        persistence_id TEXT NOT NULL,
        sequence_nr    INTEGER NOT NULL,
        payload        TEXT NOT NULL,
        timestamp      INTEGER NOT NULL,
        PRIMARY KEY (persistence_id, sequence_nr)
      );
      CREATE TABLE IF NOT EXISTS ${STORAGE_IDENTITY_TABLE} (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        identity  TEXT NOT NULL
      );
    `);
    return {
      insert: db.prepare(
        `INSERT OR REPLACE INTO ${this.table}(persistence_id, sequence_nr, payload, timestamp) VALUES (?, ?, ?, ?)`,
      ),
      latest: db.prepare(
        `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${this.table} WHERE persistence_id = ? ORDER BY sequence_nr DESC LIMIT 1`,
      ),
      before: db.prepare(
        `SELECT persistence_id, sequence_nr, payload, timestamp FROM ${this.table} WHERE persistence_id = ? AND sequence_nr < ? ORDER BY sequence_nr DESC LIMIT 1`,
      ),
      deleteUpTo: db.prepare(
        `DELETE FROM ${this.table} WHERE persistence_id = ? AND sequence_nr <= ?`,
      ),
      deleteOlderThan: db.prepare(
        `DELETE FROM ${this.table} WHERE persistence_id = ? AND sequence_nr NOT IN (SELECT sequence_nr FROM ${this.table} WHERE persistence_id = ? ORDER BY sequence_nr DESC LIMIT ?)`,
      ),
    };
  }
}
