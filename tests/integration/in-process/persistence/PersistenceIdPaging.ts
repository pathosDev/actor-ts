/**
 * Shared by the five SQL fakes (`FakePgPool`, `FakeMariaDbPool`,
 * `FakeMsSqlPool`, `FakeD1Client`, `FakeLibSqlClient`) so the paginated
 * `persistence_id` statement behaves the same in all of them.
 *
 * It exists because the *unpaginated* branch those fakes already had matches
 * `^SELECT DISTINCT persistence_id FROM` — which the paginated statement also
 * starts with.  Left alone, every fake would have answered a page request with
 * the entire id list and every paging test would have passed for the wrong
 * reason.  Recognising the extra clauses here is what turns that silent
 * agreement into a real assertion.
 *
 * Only the clauses `RelationalJournal.persistenceIdPageSql` actually emits are
 * understood: an `ORDER BY persistence_id ASC`, an optional `WHERE
 * persistence_id > <placeholder>` cursor, and the dialect's row cap in either
 * spelling (`LIMIT n` for Postgres/MariaDB/SQLite, `FETCH NEXT n ROWS ONLY`
 * for T-SQL).  Anything else is left as the full list, so the pre-existing
 * `persistenceIds()` statement keeps its old behaviour untouched.
 */

/**
 * Apply the paging clauses of `sql` to an already-deduplicated `ids` list.
 *
 * `parameters` carries the cursor when the statement has one — it is the only
 * bound value in the statement, the row cap being interpolated into the text
 * by `SqlDialect.rowLimit`.
 */
export function pagePersistenceIds(
  sql: string,
  ids: ReadonlyArray<string>,
  parameters: ReadonlyArray<unknown>,
): string[] {
  if (!/ORDER BY persistence_id ASC/i.test(sql)) return [...ids];
  let paged = [...ids].sort();
  if (/WHERE persistence_id >/i.test(sql)) {
    const cursor = String(parameters[0]);
    paged = paged.filter((persistenceId) => persistenceId > cursor);
  }
  const limit = /\bLIMIT (\d+)/i.exec(sql) ?? /FETCH NEXT (\d+) ROWS/i.exec(sql);
  return limit === null ? paged : paged.slice(0, Number(limit[1]));
}
