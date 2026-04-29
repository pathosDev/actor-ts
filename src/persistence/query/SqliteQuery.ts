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
 * and overrides the tag path with an indexed JOIN against the
 * `${eventsTable}_tags` join table that `SqliteJournal` maintains.
 *
 * **Index shape.**  The journal's tags table has primary key
 * `(tag, timestamp, persistence_id, sequence_nr)`, so a
 * `WHERE tag = ? AND timestamp >= ?` filter walks a contiguous
 * range of the index — bounded cost per query no matter how big
 * the events table grows.  We then JOIN to `events` to pull the
 * payload + the original CSV tags column.
 *
 * **Backwards-compat.**  `SqliteJournal` upgrades existing v0
 * databases (CSV-only, no join table) by backfilling the join
 * table on `init()` — see `SqliteJournal.backfillTagsTableIfNeeded`.
 * From the query layer's POV the table is always present once the
 * journal is open.
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
    let rows: TagRow[];
    try {
      rows = stmts.fetchByTag.all(tag, fromOffset.timestamp) as TagRow[];
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
      // The full offset comparison still happens here — the SQL
      // `timestamp >= ?` filter is a coarse cut, but the
      // (persistence_id, sequence_nr) tiebreakers in `Offset` mean
      // we still need a precise compare per row.
      const offset = offsetOfEvent(event);
      if (offsetCompare(offset, fromOffset) < 0) continue;
      out.push({ event, offset });
    }
    out.sort((a, b) => offsetCompare(a.offset, b.offset));
    return out;
  }

  private async ensureTagStmts(): Promise<TagStmts> {
    if (this.cachedStmts) return this.cachedStmts;
    // Force the journal to open + create its tables so we can prepare.
    await this.sqlite.persistenceIds();
    const internal = this.sqlite as unknown as {
      db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } | null;
      table: string;
    };
    if (!internal.db) {
      throw new JournalError('SqliteQuery: underlying SqliteJournal is not open');
    }
    const eventsTable = internal.table;
    const tagsTable = `${eventsTable}_tags`;
    this.cachedStmts = {
      fetchByTag: internal.db.prepare(
        // Walk the tags-table PK range for the given tag, JOIN to
        // events to fetch payload + CSV tags column.  ORDER matches
        // the index PK so SQLite doesn't have to sort separately.
        `SELECT e.persistence_id, e.sequence_nr, e.payload, e.tags, e.timestamp
           FROM ${tagsTable} t
           JOIN ${eventsTable} e
             ON e.persistence_id = t.persistence_id AND e.sequence_nr = t.sequence_nr
          WHERE t.tag = ? AND t.timestamp >= ?
          ORDER BY t.timestamp ASC, t.persistence_id ASC, t.sequence_nr ASC`,
      ) as TagStmts['fetchByTag'],
    };
    return this.cachedStmts;
  }
}

interface TagStmts {
  fetchByTag: { all(tag: string, fromTimestamp: number): TagRow[] };
}

interface TagRow {
  persistence_id: string;
  sequence_nr: number;
  payload: string;
  tags: string | null;
  timestamp: number;
}
