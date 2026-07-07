import type { SqliteDriver } from '../../runtime/sqlite/index.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

export interface SqliteJournalOptionsType {
  /** File path (absolute or relative) or ":memory:" for an ephemeral DB. */
  readonly path?: string;
  /** Table name for events.  Default: `events`. */
  readonly eventsTable?: string;
  /** If true, opens the DB with WAL mode enabled. */
  readonly wal?: boolean;
  /**
   * Explicit driver — useful for tests or when you want to pin a
   * specific SQLite backend.  Default: auto-detect via `getSqliteDriver()`
   * (Bun → `bun:sqlite`, Node → `better-sqlite3`).
   */
  readonly driver?: SqliteDriver;
}

/**
 * Fluent builder for {@link SqliteJournalOptionsType}:
 *
 *     new SqliteJournal(SqliteJournalOptions.create().withPath(':memory:').withWal(true))
 */
export class SqliteJournalOptionsBuilder extends OptionsBuilder<SqliteJournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new SqliteJournalOptionsBuilder()`. */
  static create(): SqliteJournalOptionsBuilder {
    return new SqliteJournalOptionsBuilder();
  }

  /** File path (absolute or relative) or ":memory:" for an ephemeral DB. */
  withPath(path: string): this {
    return this.set('path', path);
  }

  /** Table name for events.  Default: `events`. */
  withEventsTable(eventsTable: string): this {
    return this.set('eventsTable', eventsTable);
  }

  /** If true, opens the DB with WAL mode enabled. */
  withWal(wal = true): this {
    return this.set('wal', wal);
  }

  /** Explicit driver — pin a specific SQLite backend (defaults to auto-detect). */
  withDriver(driver: SqliteDriver): this {
    return this.set('driver', driver);
  }
}

/**
 * Accepted input for any SQLite-journal constructor: the fluent
 * {@link SqliteJournalOptionsBuilder} OR a plain {@link SqliteJournalOptionsType} object.
 */
export type SqliteJournalOptions = SqliteJournalOptionsBuilder | Partial<SqliteJournalOptionsType>;
/** Value alias so `SqliteJournalOptions.create()` / `new SqliteJournalOptions()` resolve to the builder. */
export const SqliteJournalOptions = SqliteJournalOptionsBuilder;
