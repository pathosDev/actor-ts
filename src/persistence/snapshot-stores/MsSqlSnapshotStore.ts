import { msSqlDialect } from '../relational/MsSqlDialect.js';
import { RelationalSnapshotStore } from '../relational/RelationalSnapshotStore.js';
import { adaptMsSqlPool, buildMsSqlPool } from '../journals/MsSqlClient.js';
import {
  MsSqlSnapshotStoreOptionsValidator,
  type MsSqlSnapshotStoreOptions,
  type MsSqlSnapshotStoreOptionsType,
} from './MsSqlSnapshotStoreOptions.js';

/**
 * SnapshotStore backed by Microsoft SQL Server (`mssql`).  Behaviour lives in
 * `RelationalSnapshotStore`; this class supplies the T-SQL dialect, whose
 * snapshot upsert is a `MERGE … WITH (HOLDLOCK)` and whose `keepN` prune uses
 * `TOP (@p2)` inside the subquery.
 */
export class MsSqlSnapshotStore extends RelationalSnapshotStore {
  constructor(options: MsSqlSnapshotStoreOptions = {}) {
    const resolvedOptions = (options as MsSqlSnapshotStoreOptionsType);
    new MsSqlSnapshotStoreOptionsValidator().validate(resolvedOptions);
    super({
      storeName: 'MsSqlSnapshotStore',
      dialect: msSqlDialect,
      snapshotsTable: resolvedOptions.snapshotsTable,
      keepN: resolvedOptions.keepN,
      autoCreateTables: resolvedOptions.autoCreateTables,
      serializer: resolvedOptions.serializer,
      ownsPool: resolvedOptions.pool === undefined,
      openPool: async () => adaptMsSqlPool(await buildMsSqlPool(resolvedOptions)),
    });
  }
}
