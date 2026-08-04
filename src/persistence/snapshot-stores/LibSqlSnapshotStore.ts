import { sqliteDialect } from '../relational/SqliteDialect.js';
import { RelationalSnapshotStore } from '../relational/RelationalSnapshotStore.js';
import { adaptLibSqlClient, buildLibSqlClient } from '../journals/LibSqlClient.js';
import {
  LibSqlSnapshotStoreOptionsValidator,
  type LibSqlSnapshotStoreOptions,
  type LibSqlSnapshotStoreOptionsType,
} from './LibSqlSnapshotStoreOptions.js';

/**
 * SnapshotStore backed by libSQL / Turso.  Behaviour lives in
 * `RelationalSnapshotStore`; this class supplies the SQLite dialect and the
 * client.  Schema-compatible with `SqliteSnapshotStore`.
 */
export class LibSqlSnapshotStore extends RelationalSnapshotStore {
  constructor(options: LibSqlSnapshotStoreOptions = {}) {
    const resolvedOptions = (options as LibSqlSnapshotStoreOptionsType);
    new LibSqlSnapshotStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'LibSqlSnapshotStore',
      dialect: sqliteDialect,
      snapshotsTable: resolvedOptions.snapshotsTable,
      keepN: resolvedOptions.keepN,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      ownsPool: resolvedOptions.client === undefined,
      openPool: async () => adaptLibSqlClient(await buildLibSqlClient(resolvedOptions)),
    });
  }
}
