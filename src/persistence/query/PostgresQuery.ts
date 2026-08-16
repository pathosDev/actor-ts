import type { PostgresJournal } from '../journals/PostgresJournal.js';
import { RelationalQuery } from './RelationalQuery.js';

/**
 * Query over a {@link PostgresJournal} — the read side of the `events_tags`
 * index that journal has always maintained (#391).
 *
 * The behaviour lives in `RelationalQuery`, and there is nothing Postgres-shaped
 * left for this class to supply: the placeholder syntax comes from the dialect
 * the journal already carries, and the statements are the dialect-neutral ones.
 * What it adds is the name — errors report `PostgresQuery`, so a log line
 * without a stack still says which backend failed, exactly as
 * `PostgresJournal` does for the write side.
 *
 * Pair it with the journal it reads; a query over one journal and a projection
 * over another is the one wiring mistake the type system cannot catch:
 *
 * ```ts
 * const journal = new PostgresJournal(postgresOptions);
 * const query = new PostgresQuery(journal);
 * ```
 */
export class PostgresQuery extends RelationalQuery {
  constructor(postgres: PostgresJournal) {
    super(postgres, 'PostgresQuery');
  }
}
