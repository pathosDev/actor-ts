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
 * **One MariaDB-specific caveat, and it is a performance one.**  The dialect
 * declares the indexed `tag` column as a bare `VARCHAR(255)`, which picks up
 * the server's default collation — case-insensitive on a stock install (#707).
 * The index therefore hands back rows for tags that differ only in case, and
 * `RelationalQuery`'s JS refinement discards them.  The answers are right; the
 * pre-filter is just less selective than on Postgres until #707 lands.
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
