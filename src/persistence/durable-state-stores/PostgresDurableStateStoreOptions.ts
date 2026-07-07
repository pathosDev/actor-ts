import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { PgPoolLike } from '../journals/PostgresClient.js';
import type { PostgresDurableStateStoreSettings } from './PostgresDurableStateStore.js';

/**
 * Fluent builder for {@link PostgresDurableStateStoreSettings}:
 *
 *     new PostgresDurableStateStore(PostgresDurableStateStoreOptions.create().withUrl('postgres://…').withTable('state'))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`) come
 * from the shared {@link PostgresConnection} mixin.
 */
export class PostgresDurableStateStoreOptions extends OptionsBuilder<PostgresDurableStateStoreSettings> {
  /** Start a fresh builder.  Equivalent to `new PostgresDurableStateStoreOptions()`. */
  static create(): PostgresDurableStateStoreOptions {
    return new PostgresDurableStateStoreOptions();
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

  /** Table name.  Default: `durable_state`. */
  withTable(table: string): this {
    return this.set('table', table);
  }

  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}
