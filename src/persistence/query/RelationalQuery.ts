import type { RelationalJournal, RelationalQueryAccess } from '../relational/RelationalJournal.js';
import { expandPlaceholders } from '../relational/SqlDialect.js';
import { JournalError } from '../JournalTypes.js';
import { decodePayload } from '../storage/PayloadCodec.js';
import { InMemoryQuery } from './InMemoryQuery.js';
import {
  eventMatchesTagFilter,
  normalizeTagFilter,
  refineTaggedRows,
  type Offset,
  type TagFilter,
  type TagFilterSpec,
  type TaggedEvent,
} from './PersistenceQuery.js';

/**
 * Indexed tag query for any SQL journal — the read side of the tags join table
 * `RelationalJournal` has always written (#391).
 *
 * Until this existed, a projection over Postgres or MariaDB fell through to
 * {@link InMemoryQuery.currentEventsByTag}, which lists every persistence id
 * and replays every one of them from sequence 1, on every poll.  The tags rows
 * were written on every append and read by nothing.
 *
 * **Written once, for every dialect.**  The statements here are canonical `?`
 * SQL run through `expandPlaceholders`, which is the same trick the journal,
 * snapshot and durable-state bases use — so this one class serves Postgres,
 * MariaDB, MsSQL, libSQL, D1 and any out-of-tree `SqlDialect`, instead of the
 * per-backend copies `SqliteQuery` and `CassandraQuery` are.  The writer of the
 * index is `RelationalJournal`; the reader belongs at the same level.
 *
 * **Index shape.**  The tags table's primary key is
 * `(tag, timestamp, persistence_id, sequence_nr)` on every relational dialect,
 * so `WHERE t.tag = ? AND t.timestamp >= ?` walks one contiguous range of that
 * index — cost proportional to the tag's own history rather than to the
 * journal.  The JOIN back to the events table then pulls the payload and the
 * CSV `tags` column in the same round-trip.
 *
 * **Multi-tag filters** push into SQL exactly as `SqliteQuery`'s do:
 *
 *   - At least one `all` tag → range-walk `all[0]`, refine the rest in JS.
 *   - No `all` but a non-empty `any` → `t.tag IN (?, …)` with `DISTINCT` to
 *     collapse an event carrying several of the listed tags, refine `not` in JS.
 *   - Only `not`, or an empty filter → fall back to the inherited
 *     {@link InMemoryQuery} scan.  A pure exclusion has no selective tag to
 *     seed an index walk with, so there is nothing to push down.
 *
 * **The JS refinement is authoritative, and on MariaDB that is load-bearing.**
 * `MariaDbDialect` declares `tag` as a bare `VARCHAR(255)`, so it inherits the
 * server's default collation, which is case-insensitive on a stock install
 * (#707).  `t.tag = 'Order'` therefore also matches rows tagged `order`.  Those
 * extra rows are wasted work, not wrong answers: every row is re-checked
 * against `events.tags` with `eventMatchesTagFilter`, which compares strings
 * exactly.  Fixing the collation is #707's job; this class is correct either
 * way because it never trusts the pre-filter.
 */
export class RelationalQuery extends InMemoryQuery {
  /** Built on first use — table names are only known once the journal opens. */
  private cachedSingleTagSql: string | null = null;

  /**
   * `IN (?, …)` statements keyed by placeholder count.  A projection re-runs
   * the same filter every poll, so one entry per distinct filter *shape* is all
   * this ever holds.
   */
  private readonly cachedAnySqlByArity = new Map<number, string>();

  constructor(
    private readonly relational: RelationalJournal,
    /**
     * Names the concrete query in error messages.  Same reasoning as
     * `LazyStore.storeName`: a log line reading `PostgresQuery` tells an
     * operator which backend failed, where the shared base name does not.
     */
    protected readonly queryName: string = 'RelationalQuery',
  ) {
    super(relational);
  }

  override async currentEventsByTag<E>(
    filter: TagFilter, fromOffset: Offset,
  ): Promise<TaggedEvent<E>[]> {
    const spec = normalizeTagFilter(filter);
    const allTags = spec.all ?? [];
    const anyTags = spec.any ?? [];

    // Strategy 1: range-walk the join table on the first `all` tag.  The other
    // constraints are narrower than this one by construction, so pre-filtering
    // on any of them would return a superset of the same candidate rows.
    if (allTags.length > 0) {
      const access = await this.relational.openForQuery();
      const sql = this.singleTagSql(access);
      return this.fetchAndRefine<E>(access, sql, [allTags[0]!, fromOffset.timestamp], spec, fromOffset);
    }

    // Strategy 2: any-only — one range walk per listed tag, unioned by the
    // engine rather than by us (unlike Cassandra, which has to scan a partition
    // per tag and merge client-side).
    if (anyTags.length > 0) {
      const access = await this.relational.openForQuery();
      const sql = this.anyTagSql(access, anyTags.length);
      return this.fetchAndRefine<E>(access, sql, [...anyTags, fromOffset.timestamp], spec, fromOffset);
    }

    // Strategy 3: nothing selective to index on — the base class's journal walk,
    // with the full filter so the not-clause still applies.
    return super.currentEventsByTag<E>(spec, fromOffset);
  }

  /* --------------------------- internals -------------------------------- */

  /** Run the pre-filter, then apply the full filter and the offset in JS. */
  private async fetchAndRefine<E>(
    access: RelationalQueryAccess,
    sql: string,
    parameters: ReadonlyArray<unknown>,
    spec: TagFilterSpec,
    fromOffset: Offset,
  ): Promise<TaggedEvent<E>[]> {
    let rows: ReadonlyArray<TagJoinRow>;
    try {
      const result = await access.pool.query(sql, parameters);
      rows = result.rows as unknown as ReadonlyArray<TagJoinRow>;
    } catch (e) {
      throw new JournalError(
        `${this.queryName}.currentEventsByTag failed: ${(e as Error).message}`, e,
      );
    }
    return refineTaggedRows<TagJoinRow, E>(rows, fromOffset, (row) => {
      // The events table carries the tag list as a CSV column beside the event;
      // the join table is an index over it, not a second source of truth.
      const tags = row.tags ? String(row.tags).split(',') : undefined;
      if (!eventMatchesTagFilter(tags, spec)) return null;
      return {
        persistenceId: row.persistence_id,
        sequenceNr: Number(row.sequence_nr),
        event: decodePayload(row.payload, access.serializer) as E,
        // BIGINT arrives as a string from node-postgres and a bigint from the
        // MariaDB connector, so the widening has to happen here, as it does in
        // `RelationalJournal.read`.
        timestamp: Number(row.timestamp),
        tags,
      };
    });
  }

  /**
   * `ORDER BY` follows the tags-table primary key, so the engine reads the
   * range out already sorted instead of sorting it afterwards.  It is a hint,
   * not the guarantee — `refineTaggedRows` re-sorts on the composite offset,
   * because the coarse `timestamp >=` bound cannot express the
   * `(persistenceId, sequenceNr)` tiebreak an `Offset` orders by.
   */
  private singleTagSql(access: RelationalQueryAccess): string {
    if (this.cachedSingleTagSql !== null) return this.cachedSingleTagSql;
    const { tables, dialect } = access;
    this.cachedSingleTagSql = expandPlaceholders(
      `SELECT e.persistence_id, e.sequence_nr, e.payload, e.tags, e.timestamp`
      + ` FROM ${tables.tags} t`
      + ` JOIN ${tables.events} e`
      + ` ON e.persistence_id = t.persistence_id AND e.sequence_nr = t.sequence_nr`
      + ` WHERE t.tag = ? AND t.timestamp >= ?`
      + ` ORDER BY t.timestamp ASC, t.persistence_id ASC, t.sequence_nr ASC`,
      dialect,
    );
    return this.cachedSingleTagSql;
  }

  /**
   * The any-path orders on the `e.` columns rather than the index's own `t.`
   * ones.  Not a preference: `SELECT DISTINCT` restricts `ORDER BY` to
   * expressions in the select list, and Postgres rejects the `t.` spelling
   * outright.  The two column sets are equal on every joined row anyway — the
   * JOIN is on the key the timestamp is copied along with.
   */
  private anyTagSql(access: RelationalQueryAccess, arity: number): string {
    const cached = this.cachedAnySqlByArity.get(arity);
    if (cached !== undefined) return cached;
    const { tables, dialect } = access;
    const placeholders = new Array<string>(arity).fill('?').join(', ');
    const sql = expandPlaceholders(
      `SELECT DISTINCT e.persistence_id, e.sequence_nr, e.payload, e.tags, e.timestamp`
      + ` FROM ${tables.tags} t`
      + ` JOIN ${tables.events} e`
      + ` ON e.persistence_id = t.persistence_id AND e.sequence_nr = t.sequence_nr`
      + ` WHERE t.tag IN (${placeholders}) AND t.timestamp >= ?`
      + ` ORDER BY e.timestamp ASC, e.persistence_id ASC, e.sequence_nr ASC`,
      dialect,
    );
    this.cachedAnySqlByArity.set(arity, sql);
    return sql;
  }
}

/** One joined row: the index supplies the match, the events table the event. */
type TagJoinRow = {
  persistence_id: string;
  sequence_nr: string | number | bigint;
  payload: string;
  tags: string | null;
  timestamp: string | number | bigint;
};
