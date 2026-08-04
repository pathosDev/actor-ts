import { msSqlDialect } from '../relational/MsSqlDialect.js';
import { RelationalJournal } from '../relational/RelationalJournal.js';
import { adaptMsSqlPool, buildMsSqlPool } from './MsSqlClient.js';
import {
  MsSqlJournalOptionsValidator,
  type MsSqlJournalOptions,
  type MsSqlJournalOptionsType,
} from './MsSqlJournalOptions.js';

/**
 * Journal backed by Microsoft SQL Server via the `mssql` (tedious) driver.
 *
 * Behaviour lives in `RelationalJournal`; this class supplies the T-SQL dialect
 * (`@pN` named parameters, `MERGE` upserts, `OFFSET … FETCH NEXT` row limiting,
 * error numbers 2627 / 2601) and the pool.
 *
 * `mssql`/tedious is pure JavaScript — no native binding — so it runs on Bun,
 * Node and Deno alike.
 *
 * Construction is lazy: the pool opens and the tables are created on the first
 * call.
 */
export class MsSqlJournal extends RelationalJournal {
  constructor(options: MsSqlJournalOptions = {}) {
    const resolvedOptions = (options as MsSqlJournalOptionsType);
    new MsSqlJournalOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'MsSqlJournal',
      dialect: msSqlDialect,
      eventsTable: resolvedOptions.eventsTable,
      tagsTable: resolvedOptions.tagsTable,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      ownsPool: resolvedOptions.pool === undefined,
      openPool: async () => adaptMsSqlPool(await buildMsSqlPool(resolvedOptions)),
    });
  }
}
