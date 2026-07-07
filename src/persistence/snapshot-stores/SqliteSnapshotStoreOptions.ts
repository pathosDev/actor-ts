import type { SqliteDriver } from '../../runtime/sqlite/index.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

export interface SqliteSnapshotStoreOptionsType {
  /** Path or ":memory:". Defaults to ":memory:". */
  readonly path?: string;
  /** Table name; default `snapshots`. */
  readonly snapshotsTable?: string;
  /** Maximum snapshots retained per persistenceId.  Older ones are pruned on save. */
  readonly keepN?: number;
  /**
   * Explicit driver — useful for tests or when you want to pin a
   * specific SQLite backend.  Default: auto-detect via `getSqliteDriver()`.
   */
  readonly driver?: SqliteDriver;
}

/**
 * Fluent builder for {@link SqliteSnapshotStoreOptionsType}:
 *
 *     new SqliteSnapshotStore(SqliteSnapshotStoreOptions.create().withPath(':memory:').withKeepN(2))
 */
export class SqliteSnapshotStoreOptionsBuilder extends OptionsBuilder<SqliteSnapshotStoreOptionsType> {
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
