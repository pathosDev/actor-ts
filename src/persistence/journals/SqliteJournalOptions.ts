import type { SqliteDriver } from '../../runtime/sqlite/index.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { SqliteJournalSettings } from './SqliteJournal.js';

/**
 * Fluent builder for {@link SqliteJournalSettings}:
 *
 *     new SqliteJournal(SqliteJournalOptions.create().withPath(':memory:').withWal(true))
 */
export class SqliteJournalOptions extends OptionsBuilder<SqliteJournalSettings> {
  /** Start a fresh builder.  Equivalent to `new SqliteJournalOptions()`. */
  static create(): SqliteJournalOptions {
    return new SqliteJournalOptions();
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
