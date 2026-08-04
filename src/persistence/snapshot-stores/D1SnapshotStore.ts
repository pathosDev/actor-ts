import { sqliteDialect } from '../relational/SqliteDialect.js';
import { RelationalSnapshotStore } from '../relational/RelationalSnapshotStore.js';
import { adaptD1Client, buildD1Client } from '../journals/D1Client.js';
import {
  D1SnapshotStoreOptionsValidator,
  type D1SnapshotStoreOptions,
  type D1SnapshotStoreOptionsType,
} from './D1SnapshotStoreOptions.js';

/**
 * SnapshotStore backed by Cloudflare D1.  Behaviour lives in
 * `RelationalSnapshotStore` and the SQL is `sqliteDialect`'s, so the table is
 * schema-compatible with the local SQLite and libSQL snapshot stores.
 */
export class D1SnapshotStore extends RelationalSnapshotStore {
  constructor(options: D1SnapshotStoreOptions = {}) {
    const resolvedOptions = (options as D1SnapshotStoreOptionsType);
    new D1SnapshotStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'D1SnapshotStore',
      dialect: sqliteDialect,
      snapshotsTable: resolvedOptions.snapshotsTable,
      keepN: resolvedOptions.keepN,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      ownsPool: resolvedOptions.client === undefined,
      openPool: async () => adaptD1Client(buildD1Client(resolvedOptions)),
    });
  }
}
