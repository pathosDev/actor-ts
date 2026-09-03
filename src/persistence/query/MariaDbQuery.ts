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
 * **One MariaDB-specific caveat, and only on a legacy schema.**  The dialect
 * now declares the indexed `tag` column `COLLATE utf8mb4_bin` (#707), so the
 * index is as selective here as on Postgres.  A table created before that —
 * `CREATE TABLE IF NOT EXISTS` never revisits one — still carries the
 * server's case-insensitive default, and its index hands back rows for tags
 * differing only in case; `RelationalQuery`'s JS refinement discards them, so
 * the answers stay right and only the pre-filter is wasteful.  The journal
 * page carries the `ALTER TABLE` that closes it.
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
