import type { CassandraJournal } from '../journals/CassandraJournal.js';
import { InMemoryQuery } from './InMemoryQuery.js';

/**
 * Cassandra/Scylla query.  The default `events` schema stores tags as
 * a native `LIST<TEXT>`, which CQL can filter via `tags CONTAINS ?`
 * — but only when there's a secondary index on the column, which the
 * default schema does NOT create (secondary indexes have non-trivial
 * costs and the choice is deliberately left to the operator).
 *
 * For v1 this query class therefore inherits the journal-walking
 * behaviour from {@link InMemoryQuery}: `currentEventsByTag` calls
 * `persistenceIds()` and scans every stream client-side, filtering
 * by tag in JS.  Correct for any volume but only fast for
 * small-to-medium event corpora.
 *
 * **Recommendation for high-volume deployments:** add an explicit
 * `events_by_tag` table (`PRIMARY KEY ((tag), timestamp,
 * persistence_id, sequence_nr)`) populated alongside `events` writes,
 * and override `currentEventsByTag` to scan that table.  The hook is
 * deliberately a subclass override rather than a config flag —
 * once you maintain a side table, you also have to migrate it on
 * tag changes, and that's coupling we don't want to bake into the
 * default plug-in.
 */
export class CassandraQuery extends InMemoryQuery {
  constructor(cassandra: CassandraJournal) {
    super(cassandra);
  }
}
