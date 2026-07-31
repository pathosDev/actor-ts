import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { PgPoolLike, PostgresConnection } from './PostgresClient.js';

export interface PostgresJournalOptionsType extends PostgresConnection {
  /** Events table name.  Default: `events`. */
  readonly eventsTable?: string;
  /** Tags join table name.  Default: `${eventsTable}_tags`. */
  readonly tagsTable?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use.  Default: true. */
  readonly autoCreateTables?: boolean;
}

/**
 * Fluent builder for {@link PostgresJournalOptionsType}:
 *
 *     new PostgresJournal(PostgresJournalOptions.create().withUrl('postgres://…').withEventsTable('journal'))
 *
 * The connection fields (`withUrl` / `withPoolConfig` / `withPool`) come
 * from the shared {@link PostgresConnection} mixin; pass a pre-built
 * `withPool(...)` to share ONE pool across the journal, snapshot, and
 * durable-state stores.
 */
export class PostgresJournalOptionsBuilder extends OptionsBuilder<PostgresJournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new PostgresJournalOptionsBuilder()`. */
  static create(): PostgresJournalOptionsBuilder {
    return new PostgresJournalOptionsBuilder();
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
 * Accepted input for any Postgres-journal constructor: the fluent
 * {@link PostgresJournalOptionsBuilder} OR a plain {@link PostgresJournalOptionsType} object.
 */
export type PostgresJournalOptions = PostgresJournalOptionsBuilder | Partial<PostgresJournalOptionsType>;
/** Value alias so `PostgresJournalOptions.create()` / `new PostgresJournalOptions()` resolve to the builder. */
export const PostgresJournalOptions = PostgresJournalOptionsBuilder;
