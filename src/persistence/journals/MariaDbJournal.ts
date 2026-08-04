import { mariaDbDialect } from '../relational/MariaDbDialect.js';
import { RelationalJournal } from '../relational/RelationalJournal.js';
import { adaptMariaDbPool, buildMariaDbPool } from './MariaDbClient.js';
import type { MariaDbJournalOptions, MariaDbJournalOptionsType } from './MariaDbJournalOptions.js';

/**
 * Journal backed by MariaDB / MySQL via the `mariadb` connector (which speaks
 * both).
 *
 * The behaviour lives in `RelationalJournal`; this class supplies the MariaDB
 * dialect (`?` placeholders, `INSERT IGNORE` tag dedup, `ER_DUP_ENTRY` as the
 * concurrency backstop, `LONGTEXT`/`BIGINT` columns) and the pool.
 */
export class MariaDbJournal extends RelationalJournal {
  constructor(options: MariaDbJournalOptions = {}) {
    const resolvedOptions = (options as MariaDbJournalOptionsType);
    super({
      storeName: 'MariaDbJournal',
      dialect: mariaDbDialect,
      eventsTable: resolvedOptions.eventsTable,
      tagsTable: resolvedOptions.tagsTable,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      ownsPool: resolvedOptions.pool === undefined,
      openPool: async () => adaptMariaDbPool(await buildMariaDbPool(resolvedOptions)),
    });
  }
}
