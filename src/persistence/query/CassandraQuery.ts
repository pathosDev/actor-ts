import type { CassandraJournal } from '../journals/CassandraJournal.js';
import type { CassandraClientLike } from '../journals/CassandraClient.js';
import { JournalError, type PersistentEvent } from '../JournalTypes.js';
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
 * Cassandra/Scylla query.  By default, inherits the journal-walking
 * `currentEventsByTag` from {@link InMemoryQuery} — correct for any
 * volume but only fast for small-to-medium event corpora because the
 * default Cassandra schema has no secondary index on the `tags`
 * column.
 *
 * When the journal was constructed with `useTagIndex: true`, `append`
 * dual-writes every `(event, tag)` pair into an `events_by_tag` side
 * table partitioned by `(tag)` and ordered by `(timestamp,
 * persistence_id, sequence_nr)`.  This class overrides
 * `currentEventsByTag` to walk that side table — a single
 * tag-partition scan instead of a full client-side journal sweep
 * (#44).
 *
 * **Multi-tag filters.**  The `TagFilter` operators (`all` / `any` /
 * `not`, see {@link TagFilter}) translate into the side-table query
 * the same way `SqliteQuery` does:
 *
 *   - `all` non-empty → walk the side-table partition for `all[0]`,
 *     JS-refine the rest of the filter against the per-row `tags`
 *     set carried in the side table.  Bounded scan even when the
 *     final result is the intersection of several tags.
 *   - `any` non-empty (no `all`) → walk one partition per `any` tag
 *     and merge by `(persistence_id, sequence_nr)`.  N partition
 *     scans, sequential, JS-refines `not`.
 *   - Only `not` (or fully empty) → fall back to the inherited
 *     journal scan; only-`not` queries don't have a selective tag
 *     to seed the index walk anyway.
 */
export class CassandraQuery extends InMemoryQuery {
  /** Cached SqliteQuery-style escape hatch into the journal's privates. */
  private readonly access: CassandraInternalAccess;

  constructor(private readonly cassandra: CassandraJournal) {
    super(cassandra);
    this.access = cassandra as unknown as CassandraInternalAccess;
  }

  override async currentEventsByTag<E>(
    filter: TagFilter, fromOffset: Offset,
  ): Promise<TaggedEvent<E>[]> {
    if (!this.cassandra.useTagIndex) {
      // No side table → fall back to the journal-walking scan.
      return super.currentEventsByTag<E>(filter, fromOffset);
    }
    const spec = normalizeTagFilter(filter);
    const allTags = spec.all ?? [];
    const anyTags = spec.any ?? [];

    // Strategy 1: at least one `all` tag — walk that partition only.
    if (allTags.length > 0) {
      const rows = await this.fetchTagPartition(allTags[0]!, fromOffset.timestamp);
      return refineAndSort<E>(rows, spec, fromOffset);
    }

    // Strategy 2: any-only — scan one partition per listed tag and
    // merge.  The candidate set may contain duplicates (an event tagged
    // with multiple `any` values surfaces from each partition) — the
    // dedupe-by-(pid, seq) below collapses them before refining.
    if (anyTags.length > 0) {
      const seen = new Set<string>();
      const merged: TagIndexRow[] = [];
      for (const tag of anyTags) {
        const rows = await this.fetchTagPartition(tag, fromOffset.timestamp);
        for (const row of rows) {
          const key = `${row.persistence_id}|${row.sequence_nr}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(row);
        }
      }
      return refineAndSort<E>(merged, spec, fromOffset);
    }

    // Strategy 3: only `not` (or empty) — fall back to the inherited scan.
    return super.currentEventsByTag<E>(spec, fromOffset);
  }

  private async fetchTagPartition(tag: string, fromTimestamp: number): Promise<TagIndexRow[]> {
    const qualified = `${this.access.options.keyspace}.${this.cassandra.tagIndexTable}`;
    let response;
    try {
      response = await this.access.client.execute(
        `SELECT persistence_id, sequence_nr, timestamp, payload, tags FROM ${qualified} `
        + `WHERE tag = ? AND timestamp >= ?`,
        [tag, fromTimestamp],
        { prepare: true },
      );
    } catch (e) {
      throw new JournalError(`CassandraQuery.currentEventsByTag failed: ${(e as Error).message}`, e);
    }
    return response.rows as unknown as TagIndexRow[];
  }
}

/**
 * Translate driver rows into `TaggedEvent`s, JS-refine against the
 * full filter, and sort.  The side-table SQL only saw the pre-filter
 * tag, so multi-tag operators (`all` past index-0, `any` cross-tag,
 * `not`) get applied in JS against the per-row `tags` set.
 */
function refineAndSort<E>(
  rows: ReadonlyArray<TagIndexRow>,
  spec: TagFilterSpec,
  fromOffset: Offset,
): TaggedEvent<E>[] {
  const out: TaggedEvent<E>[] = [];
  for (const row of rows) {
    const tags = Array.isArray(row.tags) && row.tags.length > 0 ? row.tags : undefined;
    if (!eventMatchesTagFilter(tags, spec)) continue;
    const event: PersistentEvent<E> = {
      persistenceId: row.persistence_id,
      sequenceNr: Number(row.sequence_nr),
      event: JSON.parse(row.payload) as E,
      timestamp: Number(row.timestamp),
      tags,
    };
    const offset = offsetOfEvent(event);
    if (offsetCompare(offset, fromOffset) < 0) continue;
    out.push({ event, offset });
  }
  out.sort((a, b) => offsetCompare(a.offset, b.offset));
  return out;
}

interface TagIndexRow {
  persistence_id: string;
  sequence_nr: string | number;
  timestamp: string | number;
  payload: string;
  tags: string[] | null;
}

/** Type-only escape hatch matching the layout of `CassandraJournal`'s privates. */
interface CassandraInternalAccess {
  readonly client: CassandraClientLike;
  readonly options: { readonly keyspace: string };
}
