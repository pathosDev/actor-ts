import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import { MariaDbOptionsValidatorBase, type MariaDbConnection, type MariaDbPoolLike } from '../journals/MariaDbClient.js';

export interface MariaDbSnapshotStoreOptionsType extends MariaDbConnection, StoreSerializerOptionsBase {
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
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`, and the
 * typed `withMaxPoolSize` … `withCaFile`) come from the shared
 * {@link MariaDbConnection} mixin.
 */
export class MariaDbSnapshotStoreOptionsBuilder extends StoreSerializerOptionsBuilder<MariaDbSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MariaDbSnapshotStoreOptionsBuilder()`. */
  static create(): MariaDbSnapshotStoreOptionsBuilder {
    return new MariaDbSnapshotStoreOptionsBuilder();
  }

  /** Connection URI passed straight to `createPool`, e.g. `mariadb://user:pass@host:3306/db`. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /**
   * `createPool` config object (host/user/password/database/…), which takes
   * precedence over `url` — e.g.
   * `{ host, user, password, database, ssl: { rejectUnauthorized: true, ca: fs.readFileSync('rds-ca.pem') } }`.
   *
   * Supply the signing CA rather than switching certificate verification off:
   * encryption without verification authenticates nobody, and this link
   * carries the snapshots.  See
   * https://actor-ts.dev/operations/security/tls-everywhere/.
   */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Pre-built pool — shares one pool across the three stores, or injects a fake in tests. */
  withPool(pool: MariaDbPoolLike): this {
    return this.set('pool', pool);
  }

  /** Most connections the pool holds — the connector's `connectionLimit`.  Unset: the driver's 10. */
  withMaxPoolSize(maxPoolSize: number): this {
    return this.set('maxPoolSize', maxPoolSize);
  }

  /** Wait for a free connection, in ms — the connector's `acquireTimeout`.  Unset: 10 000. */
  withAcquireTimeoutMs(acquireTimeoutMs: number): this {
    return this.set('acquireTimeoutMs', acquireTimeoutMs);
  }

  /** Idle time before the pool closes a connection, in ms — whole seconds only, as the connector counts them.  Unset: 1 800 s. */
  withIdleTimeoutMs(idleTimeoutMs: number): this {
    return this.set('idleTimeoutMs', idleTimeoutMs);
  }

  /** Time allowed to open a connection, in ms — the connector's `connectTimeout`.  Unset: 1 000. */
  withConnectTimeoutMs(connectTimeoutMs: number): this {
    return this.set('connectTimeoutMs', connectTimeoutMs);
  }

  /**
   * PEM file of the CA that signed the server's certificate, read when the
   * pool opens and handed to the connector as `ssl.ca` — see
   * `MariaDbConnection.caFile`.
   */
  withCaFile(caFile: string): this {
    return this.set('caFile', caFile);
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

/** The connection rules every MariaDB store shares — see `MariaDbOptionsValidatorBase`. */
export class MariaDbSnapshotStoreOptionsValidator extends MariaDbOptionsValidatorBase<MariaDbSnapshotStoreOptionsType> {
  constructor() { super('MariaDbSnapshotStoreOptions'); }

  protected rules(s: Partial<MariaDbSnapshotStoreOptionsType>): void {
    this.checkConnection(s);
  }
}
