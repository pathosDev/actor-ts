import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import type { MariaDbPoolLike, MariaDbConnection } from '../journals/MariaDbClient.js';

export interface MariaDbDurableStateStoreOptionsType extends MariaDbConnection, StoreSerializerOptionsBase {
  /** Table name.  Default: `durable_state`. */
  readonly table?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link MariaDbDurableStateStoreOptionsType}:
 *
 *     new MariaDbDurableStateStore(MariaDbDurableStateStoreOptions.create().withPoolConfig({ … }).withTable('state'))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`) come
 * from the shared {@link MariaDbConnection} mixin.
 */
export class MariaDbDurableStateStoreOptionsBuilder extends StoreSerializerOptionsBuilder<MariaDbDurableStateStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MariaDbDurableStateStoreOptionsBuilder()`. */
  static create(): MariaDbDurableStateStoreOptionsBuilder {
    return new MariaDbDurableStateStoreOptionsBuilder();
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
   * carries the durable state.  See
   * https://actor-ts.dev/operations/security/tls-everywhere/.
   */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Pre-built pool — shares one pool across the three stores, or injects a fake in tests. */
  withPool(pool: MariaDbPoolLike): this {
    return this.set('pool', pool);
  }

  /** Table name.  Default: `durable_state`. */
  withTable(table: string): this {
    return this.set('table', table);
  }

  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}

/**
 * Accepted input for the MariaDB durable-state-store constructor: the fluent
 * {@link MariaDbDurableStateStoreOptionsBuilder} OR a plain {@link MariaDbDurableStateStoreOptionsType} object.
 */
export type MariaDbDurableStateStoreOptions = MariaDbDurableStateStoreOptionsBuilder | Partial<MariaDbDurableStateStoreOptionsType>;
/** Value alias so `MariaDbDurableStateStoreOptions.create()` / `new MariaDbDurableStateStoreOptions()` resolve to the builder. */
export const MariaDbDurableStateStoreOptions = MariaDbDurableStateStoreOptionsBuilder;
