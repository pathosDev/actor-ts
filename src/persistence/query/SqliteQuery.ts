import type { SqliteJournal } from '../journals/SqliteJournal.js';
import type { PersistentEvent } from '../JournalTypes.js';
import { JournalError } from '../JournalTypes.js';
import { InMemoryQuery } from './InMemoryQuery.js';
import {
  eventMatchesTagFilter,
  normalizeTagFilter,
  offsetCompare,
  offsetOfEvent,
  type Offset,
  type TagFilter,
  type TagFilterSpec,
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
 *
 * **Multi-tag filters.**  The `TagFilter` operators (`all` / `any` /
 * `not`) are pushed into SQL with one of three strategies:
 *
 *   - At least one `all` tag → walk the join-table for `all[0]`,
 *     JS-refine the rest of the filter against `events.tags`.  The
 *     SQL is the same as the single-tag fast path; only the JS step
 *     is wider.
 *   - No `all`, but `any` is non-empty → walk the join-table with
 *     `t.tag IN (?, ?, …)` (DISTINCT to dedupe events tagged with
 *     more than one of the listed values), JS-refine for `not`.
 *   - Only `not` (or empty filter) → fall back to the inherited
 *     {@link InMemoryQuery} scan path, which iterates persistence ids
 *     and reads each one.  Less efficient, but only-`not` queries
 *     don't have a selective index to use anyway.
 */
export class SqliteQuery extends InMemoryQuery {
  /**
   * Cache for the single-tag fetch statement (also used as the
   * `all[0]` pre-filter).  Subsequent polls reuse the same prepared
   * statement via the SQLite driver's plan cache.
   */
  private cachedSingleTag: TagStmts | null = null;

  /**
   * `IN (?, ?, …)` pre-filter statements keyed by the number of
   * placeholders — re-prepared the first time a query of that shape
   * runs, then reused.
   */
  private readonly cachedAnyByArity = new Map<number, AnyStmts>();

  constructor(private readonly sqlite: SqliteJournal) {
    super(sqlite);
  }

  override async currentEventsByTag<E>(
    filter: TagFilter, fromOffset: Offset,
  ): Promise<TaggedEvent<E>[]> {
    const spec = normalizeTagFilter(filter);
    const allTags = spec.all ?? [];
    const anyTags = spec.any ?? [];

    // Strategy 1: walk the join table on the first `all` tag, JS-
    // refine for the remaining `all` / `any` / `not` constraints.
    if (allTags.length > 0) {
      const stmts = await this.ensureSingleTagStmts();
      let rows: TagRow[];
      try {
        rows = stmts.fetchByTag.all(allTags[0]!, fromOffset.timestamp) as TagRow[];
      } catch (e) {
        throw new JournalError(`SqliteQuery.currentEventsByTag failed: ${(e as Error).message}`, e);
      }
      return refineAndSort<E>(rows, spec, fromOffset);
    }

    // Strategy 2: any-only — walk the join table on `t.tag IN (...)`,
    // DISTINCT-dedupe events that match more than one tag in the set.
    if (anyTags.length > 0) {
      const stmts = await this.ensureAnyStmts(anyTags.length);
      let rows: TagRow[];
      try {
        rows = stmts.fetchByAny.all(...anyTags, fromOffset.timestamp) as TagRow[];
      } catch (e) {
        throw new JournalError(`SqliteQuery.currentEventsByTag failed: ${(e as Error).message}`, e);
      }
      return refineAndSort<E>(rows, spec, fromOffset);
    }

    // Strategy 3: only `not` (or fully empty filter) — fall back to
    // the journal-walking scan in the base class.  We still pass the
    // full filter so the not-clause is applied.
    return super.currentEventsByTag<E>(spec, fromOffset);
  }

  private async ensureSingleTagStmts(): Promise<TagStmts> {
    if (this.cachedSingleTag) return this.cachedSingleTag;
    const { db, eventsTable, tagsTable } = await this.openInternals();
    this.cachedSingleTag = {
      fetchByTag: db.prepare(
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
    return this.cachedSingleTag;
  }

  private async ensureAnyStmts(arity: number): Promise<AnyStmts> {
    const cached = this.cachedAnyByArity.get(arity);
    if (cached) return cached;
    const { db, eventsTable, tagsTable } = await this.openInternals();
    const placeholders = new Array<string>(arity).fill('?').join(', ');
    const stmts: AnyStmts = {
      fetchByAny: db.prepare(
        // DISTINCT collapses an event that matches multiple `any`
        // tags into a single row.  ORDER follows the same composite
        // key so the JS-side refinement keeps the global ordering.
        `SELECT DISTINCT e.persistence_id, e.sequence_nr, e.payload, e.tags, e.timestamp
           FROM ${tagsTable} t
           JOIN ${eventsTable} e
             ON e.persistence_id = t.persistence_id AND e.sequence_nr = t.sequence_nr
          WHERE t.tag IN (${placeholders}) AND t.timestamp >= ?
          ORDER BY e.timestamp ASC, e.persistence_id ASC, e.sequence_nr ASC`,
      ) as AnyStmts['fetchByAny'],
    };
    this.cachedAnyByArity.set(arity, stmts);
    return stmts;
  }

  private async openInternals(): Promise<{
    db: PreparedDb;
    eventsTable: string;
    tagsTable: string;
  }> {
    // Force the journal to open + create its tables so we can prepare.
    await this.sqlite.persistenceIds();
    const internal = this.sqlite as unknown as {
      db: PreparedDb | null;
      table: string;
    };
    if (!internal.db) {
      throw new JournalError('SqliteQuery: underlying SqliteJournal is not open');
    }
    return {
      db: internal.db,
      eventsTable: internal.table,
      tagsTable: `${internal.table}_tags`,
    };
  }
}

/**
 * Translate driver rows into `TaggedEvent`s, JS-refine against the
 * full filter (the SQL only saw the pre-filter strategy), and sort.
 * Shared by both the all-pre-filter and any-pre-filter paths.
 */
function refineAndSort<E>(
  rows: ReadonlyArray<TagRow>,
  spec: TagFilterSpec,
  fromOffset: Offset,
): TaggedEvent<E>[] {
  const out: TaggedEvent<E>[] = [];
  for (const r of rows) {
    const tags = r.tags ? r.tags.split(',') : undefined;
    if (!eventMatchesTagFilter(tags, spec)) continue;
    const event: PersistentEvent<E> = {
      persistenceId: r.persistence_id,
      sequenceNr: r.sequence_nr,
      event: JSON.parse(r.payload) as E,
      timestamp: r.timestamp,
      tags,
    };
    // The SQL `timestamp >= ?` filter is a coarse cut, but the
    // (persistence_id, sequence_nr) tiebreakers in `Offset` mean
    // we still need a precise compare per row.
    const offset = offsetOfEvent(event);
    if (offsetCompare(offset, fromOffset) < 0) continue;
    out.push({ event, offset });
  }
  out.sort((a, b) => offsetCompare(a.offset, b.offset));
  return out;
}

interface TagStmts {
  fetchByTag: { all(tag: string, fromTimestamp: number): TagRow[] };
}

interface AnyStmts {
  fetchByAny: { all(...args: unknown[]): TagRow[] };
}

interface PreparedDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
}

interface TagRow {
  persistence_id: string;
  sequence_nr: number;
  payload: string;
  tags: string | null;
  timestamp: number;
}
