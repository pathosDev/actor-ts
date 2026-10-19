import type { SqliteDriver } from '../../runtime/sqlite/index.js';
import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS } from '../Constants.js';
import { assertLocalSqlitePath } from './SqliteClient.js';

export type SqliteJournalOptionsType = StoreSerializerOptionsBase & {
  /**
   * Database file (absolute or relative), or `":memory:"` for an in-memory
   * database.  Required: a journal that names no database is refused rather
   * than run in memory, so `":memory:"` is always a choice made on purpose
   * (#1492).
   */
  readonly path?: string;
  /** Table name for events.  Default: `events`. */
  readonly eventsTable?: string;
  /** If true, opens the DB with WAL mode enabled. */
  readonly wal?: boolean;
  /**
   * How long a blocked writer waits for the database lock before failing with
   * `SQLITE_BUSY`, in milliseconds.  `0` disables the wait — a contended write
   * fails immediately.  Default: {@link DEFAULT_SQLITE_BUSY_TIMEOUT_MS}.
   */
  readonly busyTimeoutMs?: number;
  /**
   * Explicit driver — useful for tests or when you want to pin a
   * specific SQLite backend.  Default: auto-detect via `getSqliteDriver()`
   * (Bun → `bun:sqlite`, Node → `better-sqlite3` or `node:sqlite`,
   * Deno → `node:sqlite`).
   */
  readonly driver?: SqliteDriver;
};

/**
 * Fluent builder for {@link SqliteJournalOptionsType}:
 *
 *     new SqliteJournal(SqliteJournalOptions.create().withPath(':memory:').withWal(true))
 */
export class SqliteJournalOptionsBuilder extends StoreSerializerOptionsBuilder<SqliteJournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new SqliteJournalOptionsBuilder()`. */
  static create(): SqliteJournalOptionsBuilder {
    return new SqliteJournalOptionsBuilder();
  }

  /** Database file, or `":memory:"` for an in-memory database.  Required — there is no default (#1492). */
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

  /**
   * Lock-wait budget for a blocked writer, in milliseconds; `0` fails fast.
   * Default: {@link DEFAULT_SQLITE_BUSY_TIMEOUT_MS}.
   */
  withBusyTimeoutMs(busyTimeoutMs: number): this {
    return this.set('busyTimeoutMs', busyTimeoutMs);
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

/**
 * Guards the two fields here with a domain that can hurt.
 *
 * `path` must name a database the local driver can open, and there is nothing
 * to fall back on when it does not: an absent, empty or remote path is
 * refused by `assertLocalSqlitePath`, the rule all three SQLite stores share
 * (#1492).  A journal that quietly ran in memory would look exactly like one
 * that persists, until the process restarted; `":memory:"` is how to ask for
 * that on purpose.
 *
 * A negative `busyTimeoutMs` is not merely odd: SQLite reads it as "retry
 * forever", and `SqliteDriver` is synchronous — so a single contended write
 * would freeze the event loop with no upper bound at all.  `0` is a
 * legitimate value and means "do not wait", which is why the rule is
 * `nonNegativeInt` rather than `positiveInt`.
 *
 * The remaining fields are a table name already funnelled through
 * `assertSafeIdentifier`, a boolean and a driver object — nothing with a
 * domain worth restating here.
 */
export class SqliteJournalOptionsValidator extends OptionsValidator<SqliteJournalOptionsType> {
  constructor() { super('SqliteJournalOptions'); }

  protected rules(s: Partial<SqliteJournalOptionsType>): void {
    // No pre-opened handle stands in for the path: the journal opens its own (#491).
    assertLocalSqlitePath('SqliteJournalOptions', s, { acceptsDatabase: false });
    this.nonNegativeInt('busyTimeoutMs');
  }
}
