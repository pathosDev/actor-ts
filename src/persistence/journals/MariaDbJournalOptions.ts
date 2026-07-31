import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { MariaDbPoolLike, MariaDbConnection } from './MariaDbClient.js';

export interface MariaDbJournalOptionsType extends MariaDbConnection {
  /** Events table name.  Default: `events`. */
  readonly eventsTable?: string;
  /** Tags join table name.  Default: `${eventsTable}_tags`. */
  readonly tagsTable?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link MariaDbJournalOptionsType}:
 *
 *     new MariaDbJournal(MariaDbJournalOptions.create().withUrl('mariadb://…').withEventsTable('journal'))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`) come
 * from the shared {@link MariaDbConnection} mixin; the rest are journal
 * specific.
 */
export class MariaDbJournalOptionsBuilder extends OptionsBuilder<MariaDbJournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MariaDbJournalOptionsBuilder()`. */
  static create(): MariaDbJournalOptionsBuilder {
    return new MariaDbJournalOptionsBuilder();
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

/**
 * Accepted input for any MariaDB-journal constructor: the fluent
 * {@link MariaDbJournalOptionsBuilder} OR a plain {@link MariaDbJournalOptionsType} object.
 */
export type MariaDbJournalOptions = MariaDbJournalOptionsBuilder | Partial<MariaDbJournalOptionsType>;
/** Value alias so `MariaDbJournalOptions.create()` / `new MariaDbJournalOptions()` resolve to the builder. */
export const MariaDbJournalOptions = MariaDbJournalOptionsBuilder;
