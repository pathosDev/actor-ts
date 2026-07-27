import { sqliteDialect } from '../relational/SqliteDialect.js';
import { RelationalDurableStateStore } from '../relational/RelationalDurableStateStore.js';
import { adaptLibSqlClient, buildLibSqlClient } from '../journals/LibSqlClient.js';
import {
  LibSqlDurableStateStoreOptionsValidator,
  type LibSqlDurableStateStoreOptions,
  type LibSqlDurableStateStoreOptionsType,
} from './LibSqlDurableStateStoreOptions.js';

/**
 * DurableStateStore backed by libSQL / Turso — and the first durable-state
 * store in the SQLite family, since the local `SqliteJournal` backend still
 * ships journal + snapshot only.
 *
 * Behaviour lives in `RelationalDurableStateStore`; this class supplies the
 * SQLite dialect, whose revision-0 insert carries `ON CONFLICT DO NOTHING` so a
 * collision reads back as zero affected rows.
 */
export class LibSqlDurableStateStore extends RelationalDurableStateStore {
  constructor(options: LibSqlDurableStateStoreOptions = {}) {
    const resolvedOptions = (options as LibSqlDurableStateStoreOptionsType);
    new LibSqlDurableStateStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'LibSqlDurableStateStore',
      dialect: sqliteDialect,
      table: resolvedOptions.table,
      autoCreateTables: resolvedOptions.autoCreateTables,
      ownsPool: resolvedOptions.client === undefined,
      openPool: async () => adaptLibSqlClient(await buildLibSqlClient(resolvedOptions)),
    });
  }
}
