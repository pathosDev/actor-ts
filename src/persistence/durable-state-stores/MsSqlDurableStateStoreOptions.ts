import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import { MsSqlOptionsValidatorBase, type MsSqlConnection, type MsSqlPoolLike } from '../journals/MsSqlClient.js';

export interface MsSqlDurableStateStoreOptionsType extends MsSqlConnection, StoreSerializerOptionsBase {
  /** Durable-state table name.  Default: `durable_state`. */
  readonly table?: string;
  /** Run the guarded `CREATE TABLE` statement on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link MsSqlDurableStateStoreOptionsType}:
 *
 *     new MsSqlDurableStateStore(MsSqlDurableStateStoreOptions.create()
 *       .withPoolConfig(config))
 */
export class MsSqlDurableStateStoreOptionsBuilder extends StoreSerializerOptionsBuilder<MsSqlDurableStateStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MsSqlDurableStateStoreOptionsBuilder()`. */
  static create(): MsSqlDurableStateStoreOptionsBuilder {
    return new MsSqlDurableStateStoreOptionsBuilder();
  }

  /** Connection string in the `Server=…;Database=…` form — an `mssql://` URL is refused. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /**
   * `mssql` config object (server/port/user/password/database/options/pool)
   * — e.g. `{ server, database, user, password,
   * options: { encrypt: true, cryptoCredentialsDetails: { ca: fs.readFileSync('rds-ca.pem') } } }`.
   *
   * Supply the signing CA rather than telling the driver to trust the server
   * certificate, which switches verification off: encryption without
   * verification authenticates nobody, and this link carries the durable
   * state.  See https://actor-ts.dev/operations/security/tls-everywhere/.
   */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Pre-built pool — bypasses the lazy `mssql` import; share it across stores. */
  withPool(pool: MsSqlPoolLike): this {
    return this.set('pool', pool);
  }

  /** Most connections the pool holds — node-mssql's `pool.max`.  Unset: the driver's 10. */
  withMaxPoolSize(maxPoolSize: number): this {
    return this.set('maxPoolSize', maxPoolSize);
  }

  /** Idle time before the pool closes a connection, in ms — `pool.idleTimeoutMillis`.  Unset: 30 000. */
  withIdleTimeoutMs(idleTimeoutMs: number): this {
    return this.set('idleTimeoutMs', idleTimeoutMs);
  }

  /** Time allowed to open a connection, in ms — node-mssql's `connectionTimeout`.  Unset: 15 000. */
  withConnectTimeoutMs(connectTimeoutMs: number): this {
    return this.set('connectTimeoutMs', connectTimeoutMs);
  }

  /** Time allowed for one request, in ms — node-mssql's `requestTimeout`.  Unset: 15 000. */
  withRequestTimeoutMs(requestTimeoutMs: number): this {
    return this.set('requestTimeoutMs', requestTimeoutMs);
  }

  /**
   * PEM file of the CA that signed the server's certificate, read when the
   * pool opens and handed to tedious as `options.cryptoCredentialsDetails.ca`
   * — see `MsSqlConnection.caFile`.
   */
  withCaFile(caFile: string): this {
    return this.set('caFile', caFile);
  }

  /** Durable-state table name.  Default: `durable_state`. */
  withTable(table: string): this {
    return this.set('table', table);
  }

  /** Run the guarded `CREATE TABLE` statement on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}

/**
 * Accepted input for any SQL Server durable-state constructor: the fluent
 * {@link MsSqlDurableStateStoreOptionsBuilder} OR a plain
 * {@link MsSqlDurableStateStoreOptionsType} object.
 */
export type MsSqlDurableStateStoreOptions =
  | MsSqlDurableStateStoreOptionsBuilder
  | Partial<MsSqlDurableStateStoreOptionsType>;
/** Value alias so `MsSqlDurableStateStoreOptions.create()` resolves to the builder. */
export const MsSqlDurableStateStoreOptions = MsSqlDurableStateStoreOptionsBuilder;

/**
 * Rejects empty strings where a name is expected; the connection rules every
 * SQL Server store shares are `MsSqlOptionsValidatorBase`'s.
 */
export class MsSqlDurableStateStoreOptionsValidator
  extends MsSqlOptionsValidatorBase<MsSqlDurableStateStoreOptionsType> {
  constructor() { super('MsSqlDurableStateStoreOptions'); }

  protected rules(s: Partial<MsSqlDurableStateStoreOptionsType>): void {
    this.checkConnection(s);
    this.nonEmptyString('table');
  }
}
