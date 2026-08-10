import type { SqliteDriver } from '../../runtime/sqlite/index.js';
import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS } from '../journals/SqliteClient.js';

export type SqliteSnapshotStoreOptionsType = StoreSerializerOptionsBase & {
  /** Path or ":memory:". Defaults to ":memory:". */
  readonly path?: string;
  /** Table name; default `snapshots`. */
  readonly snapshotsTable?: string;
  /** Maximum snapshots retained per persistenceId.  Older ones are pruned on save. */
  readonly keepN?: number;
  /**
   * How long a blocked writer waits for the database lock before failing with
   * `SQLITE_BUSY`, in milliseconds.  `0` disables the wait — a contended write
   * fails immediately.  Default: {@link DEFAULT_SQLITE_BUSY_TIMEOUT_MS}.
   */
  readonly busyTimeoutMs?: number;
  /**
   * Explicit driver — useful for tests or when you want to pin a
   * specific SQLite backend.  Default: auto-detect via `getSqliteDriver()`.
   */
  readonly driver?: SqliteDriver;
};

/**
 * Fluent builder for {@link SqliteSnapshotStoreOptionsType}:
 *
 *     new SqliteSnapshotStore(SqliteSnapshotStoreOptions.create().withPath(':memory:').withKeepN(2))
 */
export class SqliteSnapshotStoreOptionsBuilder extends StoreSerializerOptionsBuilder<SqliteSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new SqliteSnapshotStoreOptionsBuilder()`. */
  static create(): SqliteSnapshotStoreOptionsBuilder {
    return new SqliteSnapshotStoreOptionsBuilder();
  }

  /** Path or ":memory:". Defaults to ":memory:". */
  withPath(path: string): this {
    return this.set('path', path);
  }

  /** Table name; default `snapshots`. */
  withSnapshotsTable(snapshotsTable: string): this {
    return this.set('snapshotsTable', snapshotsTable);
  }

  /** Maximum snapshots retained per persistenceId.  Older ones are pruned on save. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }

  /**
   * Lock-wait budget for a blocked writer, in milliseconds; `0` fails fast.
   * Default: {@link DEFAULT_SQLITE_BUSY_TIMEOUT_MS}.
   */
  withBusyTimeoutMs(busyTimeoutMs: number): this {
    return this.set('busyTimeoutMs', busyTimeoutMs);
  }

  /** Explicit driver — pin a specific SQLite backend (defaults to auto-detect). */
  withDriver(driver: SqliteDriver): this {
    return this.set('driver', driver);
  }
}

/**
 * Accepted input for the SQLite snapshot-store constructor: the fluent
 * {@link SqliteSnapshotStoreOptionsBuilder} OR a plain {@link SqliteSnapshotStoreOptionsType} object.
 */
export type SqliteSnapshotStoreOptions = SqliteSnapshotStoreOptionsBuilder | Partial<SqliteSnapshotStoreOptionsType>;
/** Value alias so `SqliteSnapshotStoreOptions.create()` / `new SqliteSnapshotStoreOptions()` resolve to the builder. */
export const SqliteSnapshotStoreOptions = SqliteSnapshotStoreOptionsBuilder;

/**
 * Same reasoning as `SqliteJournalOptionsValidator`: a negative
 * `busyTimeoutMs` means "retry forever" to SQLite, which on a synchronous
 * driver is an unbounded event-loop freeze.  `0` stays legal — it is the
 * documented way to fail fast instead of waiting.
 *
 * `keepN` is deliberately NOT checked: the shared snapshot contract suite
 * treats any `keepN <= 0` as "keep everything", so a negative value is a
 * supported input here rather than a mistake.
 */
export class SqliteSnapshotStoreOptionsValidator extends OptionsValidator<SqliteSnapshotStoreOptionsType> {
  constructor() { super('SqliteSnapshotStoreOptions'); }

  protected rules(_s: Partial<SqliteSnapshotStoreOptionsType>): void {
    this.nonNegativeInt('busyTimeoutMs');
  }
}
