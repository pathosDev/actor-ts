import { mariaDbDialect } from '../relational/MariaDbDialect.js';
import { RelationalSnapshotStore } from '../relational/RelationalSnapshotStore.js';
import { adaptMariaDbPool, buildMariaDbPool } from '../journals/MariaDbClient.js';
import type { MariaDbSnapshotStoreOptions, MariaDbSnapshotStoreOptionsType } from './MariaDbSnapshotStoreOptions.js';

/**
 * SnapshotStore backed by MariaDB / MySQL (`mariadb`).  Behaviour lives in
 * `RelationalSnapshotStore`; this class supplies the MariaDB dialect
 * (`ON DUPLICATE KEY UPDATE` upsert and the derived-table `keepN` prune, which
 * MySQL/MariaDB require because they reject `LIMIT` inside a bare
 * `IN (SELECT …)` against the table being deleted from) and the pool.
 */
export class MariaDbSnapshotStore extends RelationalSnapshotStore {
  constructor(options: MariaDbSnapshotStoreOptions = {}) {
    const resolvedOptions = (options as MariaDbSnapshotStoreOptionsType);
    super({
      storeName: 'MariaDbSnapshotStore',
      dialect: mariaDbDialect,
      snapshotsTable: resolvedOptions.snapshotsTable,
      keepN: resolvedOptions.keepN,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      ownsPool: resolvedOptions.pool === undefined,
      openPool: async () => adaptMariaDbPool(await buildMariaDbPool(resolvedOptions)),
    });
  }
}
