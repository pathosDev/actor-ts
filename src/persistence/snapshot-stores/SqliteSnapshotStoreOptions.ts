import type { SqliteDriver } from '../../runtime/sqlite/index.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { SqliteSnapshotStoreSettings } from './SqliteSnapshotStore.js';

/**
 * Fluent builder for {@link SqliteSnapshotStoreSettings}:
 *
 *     new SqliteSnapshotStore(SqliteSnapshotStoreOptions.create().withPath(':memory:').withKeepN(2))
 */
export class SqliteSnapshotStoreOptions extends OptionsBuilder<SqliteSnapshotStoreSettings> {
  /** Start a fresh builder.  Equivalent to `new SqliteSnapshotStoreOptions()`. */
  static create(): SqliteSnapshotStoreOptions {
    return new SqliteSnapshotStoreOptions();
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
