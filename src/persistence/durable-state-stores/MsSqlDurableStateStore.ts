import { msSqlDialect } from '../relational/MsSqlDialect.js';
import { RelationalDurableStateStore } from '../relational/RelationalDurableStateStore.js';
import { adaptMsSqlPool, buildMsSqlPool } from '../journals/MsSqlClient.js';
import {
  MsSqlDurableStateStoreOptionsValidator,
  type MsSqlDurableStateStoreOptions,
  type MsSqlDurableStateStoreOptionsType,
} from './MsSqlDurableStateStoreOptions.js';

/**
 * DurableStateStore backed by Microsoft SQL Server (`mssql`).
 *
 * Behaviour lives in `RelationalDurableStateStore`; this class supplies the
 * T-SQL dialect, whose revision-0 insert is an unguarded `INSERT`, so a
 * collision arrives as error 2627 rather than zero affected rows.  T-SQL has no
 * `ON CONFLICT DO NOTHING`, and both alternatives (`MERGE`, `INSERT … WHERE NOT
 * EXISTS`) would still have to handle the same race — letting the primary key
 * report it is shorter and correct under concurrency.
 */
export class MsSqlDurableStateStore extends RelationalDurableStateStore {
  constructor(options: MsSqlDurableStateStoreOptions = {}) {
    const resolvedOptions = (options as MsSqlDurableStateStoreOptionsType);
    new MsSqlDurableStateStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'MsSqlDurableStateStore',
      dialect: msSqlDialect,
      table: resolvedOptions.table,
      autoCreateTables: resolvedOptions.autoCreateTables,
      ownsPool: resolvedOptions.pool === undefined,
      openPool: async () => adaptMsSqlPool(await buildMsSqlPool(resolvedOptions)),
    });
  }
}
