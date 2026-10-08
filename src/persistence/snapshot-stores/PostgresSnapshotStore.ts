import { postgresDialect } from '../relational/PostgresDialect.js';
import { RelationalSnapshotStore } from '../relational/RelationalSnapshotStore.js';
import { adaptPgPool, buildPgPool } from '../journals/PostgresClient.js';
import {
  PostgresSnapshotStoreOptionsValidator,
  type PostgresSnapshotStoreOptions,
  type PostgresSnapshotStoreOptionsType,
} from './PostgresSnapshotStoreOptions.js';

/**
 * SnapshotStore backed by PostgreSQL (`pg`).  Behaviour lives in
 * `RelationalSnapshotStore`; this class supplies the Postgres dialect
 * (`ON CONFLICT … DO UPDATE` upsert, `LIMIT`-in-subquery prune) and the pool.
 */
export class PostgresSnapshotStore extends RelationalSnapshotStore {
  constructor(options: PostgresSnapshotStoreOptions = {}) {
    const resolvedOptions = (options as PostgresSnapshotStoreOptionsType);
    new PostgresSnapshotStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'PostgresSnapshotStore',
      dialect: postgresDialect,
      snapshotsTable: resolvedOptions.snapshotsTable,
      keepN: resolvedOptions.keepN,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      ownsPool: resolvedOptions.pool === undefined,
      openPool: async () => adaptPgPool(await buildPgPool(resolvedOptions)),
    });
  }
}
