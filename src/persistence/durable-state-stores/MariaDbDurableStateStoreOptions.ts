import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { MariaDbPoolLike } from '../journals/MariaDbClient.js';
import type { MariaDbDurableStateStoreSettings } from './MariaDbDurableStateStore.js';

/**
 * Fluent builder for {@link MariaDbDurableStateStoreSettings}:
 *
 *     new MariaDbDurableStateStore(MariaDbDurableStateStoreOptions.create().withPoolConfig({ … }).withTable('state'))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`) come
 * from the shared {@link MariaDbConnection} mixin.
 */
export class MariaDbDurableStateStoreOptions extends OptionsBuilder<MariaDbDurableStateStoreSettings> {
  /** Start a fresh builder.  Equivalent to `new MariaDbDurableStateStoreOptions()`. */
  static create(): MariaDbDurableStateStoreOptions {
    return new MariaDbDurableStateStoreOptions();
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

  /** Table name.  Default: `durable_state`. */
  withTable(table: string): this {
    return this.set('table', table);
  }

  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}
