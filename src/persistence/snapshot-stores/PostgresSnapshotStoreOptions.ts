import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import { PostgresOptionsValidatorBase, type PgPoolLike, type PostgresConnection } from '../journals/PostgresClient.js';

export interface PostgresSnapshotStoreOptionsType extends PostgresConnection, StoreSerializerOptionsBase {
  /** Snapshots table name.  Default: `snapshots`. */
  readonly snapshotsTable?: string;
  /** Keep this many snapshots per persistenceId; older ones pruned on save.  Default: 3.  `<=0` keeps all. */
  readonly keepN?: number;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link PostgresSnapshotStoreOptionsType}:
 *
 *     new PostgresSnapshotStore(PostgresSnapshotStoreOptions.create().withUrl('postgres://…').withKeepN(5))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`, and the
 * typed `withMaxPoolSize` … `withCaFile`) come from the shared
 * {@link PostgresConnection} mixin.
 */
export class PostgresSnapshotStoreOptionsBuilder extends StoreSerializerOptionsBuilder<PostgresSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new PostgresSnapshotStoreOptionsBuilder()`. */
  static create(): PostgresSnapshotStoreOptionsBuilder {
    return new PostgresSnapshotStoreOptionsBuilder();
  }

  /** Connection string, e.g. `postgres://user:pass@host:5432/db`. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /**
   * Extra node-postgres `Pool` config, merged over `{ connectionString: url }`
   * — e.g.
   * `{ max: 10, ssl: { rejectUnauthorized: true, ca: fs.readFileSync('rds-ca.pem') } }`.
   *
   * Supply the signing CA rather than switching certificate verification off:
   * encryption without verification authenticates nobody, and this link
   * carries the snapshots.  See
   * https://actor-ts.dev/operations/security/tls-everywhere/.
   */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Pre-built pool — bypasses the lazy `pg` import; share it across stores. */
  withPool(pool: PgPoolLike): this {
    return this.set('pool', pool);
  }

  /** Most connections the pool holds — pg-pool's `max`.  Unset: the driver's 10. */
  withMaxPoolSize(maxPoolSize: number): this {
    return this.set('maxPoolSize', maxPoolSize);
  }

  /** Idle time before the pool closes a connection, in ms — pg-pool's `idleTimeoutMillis`.  Unset: 10 000. */
  withIdleTimeoutMs(idleTimeoutMs: number): this {
    return this.set('idleTimeoutMs', idleTimeoutMs);
  }

  /** Time allowed to open a connection, in ms — pg's `connectionTimeoutMillis`.  Unset: no limit. */
  withConnectTimeoutMs(connectTimeoutMs: number): this {
    return this.set('connectTimeoutMs', connectTimeoutMs);
  }

  /**
   * PEM file of the CA that signed the server's certificate, read when the
   * pool opens and handed to pg as `ssl.ca` — see `PostgresConnection.caFile`.
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
 * Accepted input for the Postgres snapshot-store constructor: the fluent
 * {@link PostgresSnapshotStoreOptionsBuilder} OR a plain {@link PostgresSnapshotStoreOptionsType} object.
 */
export type PostgresSnapshotStoreOptions = PostgresSnapshotStoreOptionsBuilder | Partial<PostgresSnapshotStoreOptionsType>;
/** Value alias so `PostgresSnapshotStoreOptions.create()` / `new PostgresSnapshotStoreOptions()` resolve to the builder. */
export const PostgresSnapshotStoreOptions = PostgresSnapshotStoreOptionsBuilder;

/** The connection rules every Postgres store shares — see `PostgresOptionsValidatorBase`. */
export class PostgresSnapshotStoreOptionsValidator extends PostgresOptionsValidatorBase<PostgresSnapshotStoreOptionsType> {
  constructor() { super('PostgresSnapshotStoreOptions'); }

  protected rules(s: Partial<PostgresSnapshotStoreOptionsType>): void {
    this.checkConnection(s);
  }
}
