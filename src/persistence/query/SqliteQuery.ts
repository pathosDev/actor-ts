import type { SqliteJournal } from '../journals/SqliteJournal.js';
import type { PersistentEvent } from '../JournalTypes.js';
import { JournalError } from '../JournalTypes.js';
import { InMemoryQuery } from './InMemoryQuery.js';
import {
  offsetCompare,
  offsetOfEvent,
  type Offset,
  type TaggedEvent,
} from './PersistenceQuery.js';

/**
 * SQLite-backed query.  Inherits the per-pid read path from
 * {@link InMemoryQuery} (which delegates straight to `Journal.read`)
 * and overrides the tag path with a real SQL filter so the entire
 * tag scan happens in the database, not in JS.
 *
 * **Tag column shape.**  `SqliteJournal` stores tags as a
 * comma-separated `TEXT`.  To match a single tag without false
 * positives (`'foo'` vs `'foobar'`) the filter pads both sides:
 *
 *   `',' || tags || ',' LIKE '%,foo,%'`
 *
 * Yes, this is a sequential scan when the tag count is high — for
 * that workload swap to a tags join table.  For the v1 projection
 * use-case (small set of tags, modest event volumes) this is fine
 * and it doesn't require a schema migration.
 */
export class SqliteQuery extends InMemoryQuery {
  /**
   * Builders we cache after the first call so subsequent polls don't
   * re-prepare the same statements.  Sqlite drivers reuse the
   * underlying prepared SQL via the JournalToken.
   */
  private cachedStmts: TagStmts | null = null;

  constructor(private readonly sqlite: SqliteJournal) {
    super(sqlite);
  }

  override async currentEventsByTag<E>(
    tag: string, fromOffset: Offset,
  ): Promise<TaggedEvent<E>[]> {
    const stmts = await this.ensureTagStmts();
    const padded = `%,${tag},%`;
    let rows: TagRow[];
    try {
      rows = stmts.fetchByTag.all(padded, fromOffset.timestamp) as TagRow[];
    } catch (e) {
      throw new JournalError(`SqliteQuery.currentEventsByTag failed: ${(e as Error).message}`, e);
    }

    const out: TaggedEvent<E>[] = [];
    for (const r of rows) {
      const event: PersistentEvent<E> = {
        persistenceId: r.persistence_id,
        sequenceNr: r.sequence_nr,
        event: JSON.parse(r.payload) as E,
        timestamp: r.timestamp,
        tags: r.tags ? r.tags.split(',') : undefined,
      };
      // Defensive: the LIKE filter is over `,foo,` so we shouldn't
      // see false positives, but verify anyway in case a downstream
      // store-loader returns a row whose tags column was hand-edited.
      if (!event.tags?.includes(tag)) continue;
      const offset = offsetOfEvent(event);
      if (offsetCompare(offset, fromOffset) < 0) continue;
      out.push({ event, offset });
    }
    out.sort((a, b) => offsetCompare(a.offset, b.offset));
    return out;
  }

  private async ensureTagStmts(): Promise<TagStmts> {
    if (this.cachedStmts) return this.cachedStmts;
    // Force the journal to open + create its table so we can prepare.
    await this.sqlite.persistenceIds();
    const internal = this.sqlite as unknown as {
      db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } | null;
      table: string;
    };
    if (!internal.db) {
      throw new JournalError('SqliteQuery: underlying SqliteJournal is not open');
    }
    const table = internal.table;
    this.cachedStmts = {
      fetchByTag: internal.db.prepare(
        // The `>= ?` filter on timestamp is a coarse cut — it lets us
        // skip rows that we've definitely already seen on the next
        // poll without having to walk the whole table.  The exact
        // offset comparison still happens in JS via offsetCompare,
        // because sequence_nr / persistence_id tiebreakers don't
        // cleanly translate to a single SQL WHERE clause.
        `SELECT persistence_id, sequence_nr, payload, tags, timestamp
           FROM ${table}
          WHERE ',' || COALESCE(tags, '') || ',' LIKE ?
            AND timestamp >= ?
          ORDER BY timestamp ASC, persistence_id ASC, sequence_nr ASC`,
      ) as TagStmts['fetchByTag'],
    };
    return this.cachedStmts;
  }
}

interface TagStmts {
  fetchByTag: { all(pattern: string, fromTimestamp: number): TagRow[] };
}

interface TagRow {
  persistence_id: string;
  sequence_nr: number;
  payload: string;
  tags: string | null;
  timestamp: number;
}
