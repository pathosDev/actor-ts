import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { PgPoolLike } from '../journals/PostgresClient.js';
import type { PostgresSnapshotStoreSettings } from './PostgresSnapshotStore.js';

/**
 * Fluent builder for {@link PostgresSnapshotStoreSettings}:
 *
 *     new PostgresSnapshotStore(PostgresSnapshotStoreOptions.create().withUrl('postgres://…').withKeepN(5))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`) come
 * from the shared {@link PostgresConnection} mixin.
 */
export class PostgresSnapshotStoreOptions extends OptionsBuilder<PostgresSnapshotStoreSettings> {
  /** Start a fresh builder.  Equivalent to `new PostgresSnapshotStoreOptions()`. */
  static create(): PostgresSnapshotStoreOptions {
    return new PostgresSnapshotStoreOptions();
  }

  /** Connection string, e.g. `postgres://user:pass@host:5432/db`. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Extra node-postgres `Pool` config, merged over `{ connectionString: url }`. */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Pre-built pool — bypasses the lazy `pg` import; share it across stores. */
  withPool(pool: PgPoolLike): this {
    return this.set('pool', pool);
  }

  /** Snapshots table name.  Default: `snapshots`. */
  withSnapshotsTable(snapshotsTable: string): this {
    return this.set('snapshotsTable', snapshotsTable);
  }

  /** Keep this many snapshots per persistenceId; older ones pruned on save.  Default: 3.  `<=0` keeps all. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }

  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}
