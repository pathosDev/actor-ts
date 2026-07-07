import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { MariaDbPoolLike } from '../journals/MariaDbClient.js';
import type { MariaDbSnapshotStoreSettings } from './MariaDbSnapshotStore.js';

/**
 * Fluent builder for {@link MariaDbSnapshotStoreSettings}:
 *
 *     new MariaDbSnapshotStore(MariaDbSnapshotStoreOptions.create().withPoolConfig({ … }).withKeepN(2))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`) come
 * from the shared {@link MariaDbConnection} mixin.
 */
export class MariaDbSnapshotStoreOptions extends OptionsBuilder<MariaDbSnapshotStoreSettings> {
  /** Start a fresh builder.  Equivalent to `new MariaDbSnapshotStoreOptions()`. */
  static create(): MariaDbSnapshotStoreOptions {
    return new MariaDbSnapshotStoreOptions();
  }

  /** Connection URI passed straight to `createPool`, e.g. `mariadb://user:pass@host:3306/db`. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** `createPool` config object (host/user/password/database/…); takes precedence over `url`. */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Pre-built pool — shares one pool across the three stores, or injects a fake in tests. */
  withPool(pool: MariaDbPoolLike): this {
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
