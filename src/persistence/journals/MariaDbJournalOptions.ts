import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { MariaDbPoolLike } from './MariaDbClient.js';
import type { MariaDbJournalSettings } from './MariaDbJournal.js';

/**
 * Fluent builder for {@link MariaDbJournalSettings}:
 *
 *     new MariaDbJournal(MariaDbJournalOptions.create().withUrl('mariadb://…').withEventsTable('journal'))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`) come
 * from the shared {@link MariaDbConnection} mixin; the rest are journal
 * specific.
 */
export class MariaDbJournalOptions extends OptionsBuilder<MariaDbJournalSettings> {
  /** Start a fresh builder.  Equivalent to `new MariaDbJournalOptions()`. */
  static create(): MariaDbJournalOptions {
    return new MariaDbJournalOptions();
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

  /** Events table name.  Default: `events`. */
  withEventsTable(eventsTable: string): this {
    return this.set('eventsTable', eventsTable);
  }

  /** Tags join table name.  Default: `${eventsTable}_tags`. */
  withTagsTable(tagsTable: string): this {
    return this.set('tagsTable', tagsTable);
  }

  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  withAutoCreateTables(autoCreateTables: boolean): this {
    return this.set('autoCreateTables', autoCreateTables);
  }
}
