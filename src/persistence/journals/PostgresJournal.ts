import { postgresDialect } from '../relational/PostgresDialect.js';
import { RelationalJournal } from '../relational/RelationalJournal.js';
import { adaptPgPool, buildPgPool } from './PostgresClient.js';
import type { PostgresJournalOptions, PostgresJournalOptionsType } from './PostgresJournalOptions.js';

/**
 * Journal backed by PostgreSQL via the `pg` (node-postgres) driver.
 *
 * The behaviour lives in `RelationalJournal`; this class supplies the Postgres
 * dialect (`$n` placeholders, `ON CONFLICT`, SQLSTATE `23505`) and the pool.
 * Because the dialect matches on the SQLSTATE rather than message text, the
 * same store serves the Postgres-wire-compatible databases (CockroachDB,
 * YugabyteDB).
 *
 * Construction is lazy — the pool opens and the tables are created on the
 * first call.
 */
export class PostgresJournal extends RelationalJournal {
  constructor(options: PostgresJournalOptions = {}) {
    const resolvedOptions = (options as PostgresJournalOptionsType);
    super({
      storeName: 'PostgresJournal',
      dialect: postgresDialect,
      eventsTable: resolvedOptions.eventsTable,
      tagsTable: resolvedOptions.tagsTable,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      ownsPool: resolvedOptions.pool === undefined,
      openPool: async () => adaptPgPool(await buildPgPool(resolvedOptions)),
    });
  }
}
