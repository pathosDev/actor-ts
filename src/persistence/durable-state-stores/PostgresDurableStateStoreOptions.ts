import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import type { PgPoolLike, PostgresConnection } from '../journals/PostgresClient.js';

export interface PostgresDurableStateStoreOptionsType extends PostgresConnection, StoreSerializerOptionsBase {
  /** Table name.  Default: `durable_state`. */
  readonly table?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link PostgresDurableStateStoreOptionsType}:
 *
 *     new PostgresDurableStateStore(PostgresDurableStateStoreOptions.create().withUrl('postgres://…').withTable('state'))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`) come
 * from the shared {@link PostgresConnection} mixin.
 */
export class PostgresDurableStateStoreOptionsBuilder extends StoreSerializerOptionsBuilder<PostgresDurableStateStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new PostgresDurableStateStoreOptionsBuilder()`. */
  static create(): PostgresDurableStateStoreOptionsBuilder {
    return new PostgresDurableStateStoreOptionsBuilder();
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
   * carries the durable state.  See
   * https://actor-ts.dev/operations/security/tls-everywhere/.
   */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Pre-built pool — bypasses the lazy `pg` import; share it across stores. */
  withPool(pool: PgPoolLike): this {
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
 * Accepted input for the Postgres durable-state-store constructor: the fluent
 * {@link PostgresDurableStateStoreOptionsBuilder} OR a plain {@link PostgresDurableStateStoreOptionsType} object.
 */
export type PostgresDurableStateStoreOptions = PostgresDurableStateStoreOptionsBuilder | Partial<PostgresDurableStateStoreOptionsType>;
/** Value alias so `PostgresDurableStateStoreOptions.create()` / `new PostgresDurableStateStoreOptions()` resolve to the builder. */
export const PostgresDurableStateStoreOptions = PostgresDurableStateStoreOptionsBuilder;
