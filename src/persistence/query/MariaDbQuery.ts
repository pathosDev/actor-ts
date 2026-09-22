import type { MariaDbJournal } from '../journals/MariaDbJournal.js';
import { RelationalQuery } from './RelationalQuery.js';

/**
 * Query over a {@link MariaDbJournal} — the read side of the `events_tags`
 * index that journal has always maintained (#391).  Serves MySQL too, the same
 * way the journal does.
 *
 * The behaviour lives in `RelationalQuery`; this class supplies the name, so a
 * failure reports `MariaDbQuery` rather than the shared base.
 *
 * **Two MariaDB-specific caveats about the pre-filter's selectivity.**
 * Neither changes an answer — `RelationalQuery` re-checks every row the join
 * hands back against the events table's own `tags` column — so both cost only
 * rows fetched and discarded.
 *
 *   - **On a legacy schema.**  The dialect now declares the indexed `tag`
 *     column `COLLATE utf8mb4_bin` (#707), but `CREATE TABLE IF NOT EXISTS`
 *     never revisits a table, so one created before that still carries the
 *     server's case-insensitive default and its index hands back rows for tags
 *     differing only in case.  The journal page carries the `ALTER TABLE` that
 *     closes it.
 *   - **On any schema, including a pinned one.**  `utf8mb4_bin` is PAD SPACE:
 *     `'order '` and `'order'` compare equal here and do not on Postgres, so
 *     for trailing-space variants the pre-filter stays less selective than
 *     Postgres's however new the table is.  The pin buys parity on case and
 *     accent, not on trailing whitespace — the NO PAD binary collations are
 *     vendor-split (`utf8mb4_nopad_bin` on MariaDB, `utf8mb4_0900_bin` on
 *     MySQL), so there was nothing portable to pin, and `MariaDbDialect`
 *     records the same divergence beside the DDL that causes it.
 *
 * ```ts
 * const journal = new MariaDbJournal(mariaDbOptions);
 * const query = new MariaDbQuery(journal);
 * ```
 */
export class MariaDbQuery extends RelationalQuery {
  constructor(mariaDb: MariaDbJournal) {
    super(mariaDb, 'MariaDbQuery');
  }
}
