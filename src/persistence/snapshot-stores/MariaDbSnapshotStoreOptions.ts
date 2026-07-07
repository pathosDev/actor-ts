import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { MariaDbPoolLike, MariaDbConnection } from '../journals/MariaDbClient.js';

export interface MariaDbSnapshotStoreOptionsType extends MariaDbConnection {
  /** Snapshots table name.  Default: `snapshots`. */
  readonly snapshotsTable?: string;
  /** Keep this many snapshots per persistenceId; older ones pruned on save.  Default: 3.  `<=0` keeps all. */
  readonly keepN?: number;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link MariaDbSnapshotStoreOptionsType}:
 *
 *     new MariaDbSnapshotStore(MariaDbSnapshotStoreOptions.create().withPoolConfig({ … }).withKeepN(2))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`) come
 * from the shared {@link MariaDbConnection} mixin.
 */
export class MariaDbSnapshotStoreOptionsBuilder extends OptionsBuilder<MariaDbSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MariaDbSnapshotStoreOptionsBuilder()`. */
  static create(): MariaDbSnapshotStoreOptionsBuilder {
    return new MariaDbSnapshotStoreOptionsBuilder();
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

/**
 * Accepted input for the MariaDB snapshot-store constructor: the fluent
 * {@link MariaDbSnapshotStoreOptionsBuilder} OR a plain {@link MariaDbSnapshotStoreOptionsType} object.
 */
export type MariaDbSnapshotStoreOptions = MariaDbSnapshotStoreOptionsBuilder | Partial<MariaDbSnapshotStoreOptionsType>;
/** Value alias so `MariaDbSnapshotStoreOptions.create()` / `new MariaDbSnapshotStoreOptions()` resolve to the builder. */
export const MariaDbSnapshotStoreOptions = MariaDbSnapshotStoreOptionsBuilder;
