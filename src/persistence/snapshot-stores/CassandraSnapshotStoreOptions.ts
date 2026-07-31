import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { CassandraClientLike, CassandraConnection } from '../journals/CassandraClient.js';

export interface CassandraSnapshotStoreOptionsType extends CassandraConnection {
  /** Table name; default `snapshots`. */
  readonly snapshotsTable?: string;
  /** Maximum number of snapshots kept per pid.  `<= 0` = keep all.  Default: 3. */
  readonly keepN?: number;
  /** Auto-create the snapshots table on first connect. */
  readonly autoCreateTables?: boolean;
  /** Pre-built client — bypass internal construction (share with journal). */
  readonly client?: CassandraClientLike;
}

/**
 * Fluent builder for {@link CassandraSnapshotStoreOptionsType}:
 *
 *     new CassandraSnapshotStore(
 *       CassandraSnapshotStoreOptions.create()
 *         .withContactPoints(['10.0.0.1'])
 *         .withKeyspace('app')
 *         .withKeepN(5),
 *     )
 *
 * Carries `withX` methods for the shared {@link CassandraConnection}
 * fields too — the connection mixin is not built on its own.
 */
export class CassandraSnapshotStoreOptionsBuilder extends OptionsBuilder<CassandraSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new CassandraSnapshotStoreOptionsBuilder()`. */
  static create(): CassandraSnapshotStoreOptionsBuilder {
    return new CassandraSnapshotStoreOptionsBuilder();
  }

  /* --- shared CassandraConnection fields --- */

  /** Node(s) to seed the cluster topology from. */
  withContactPoints(contactPoints: ReadonlyArray<string>): this {
    return this.set('contactPoints', contactPoints);
  }

  /** Local DC — required for DCAwareRoundRobinPolicy.  Defaults to `datacenter1`. */
  withLocalDataCenter(localDataCenter: string): this {
    return this.set('localDataCenter', localDataCenter);
  }

  /** Keyspace to `USE` after connect.  Must already exist, or pass `withAutoCreateKeyspace(true)`. */
  withKeyspace(keyspace: string): this {
    return this.set('keyspace', keyspace);
  }

  /** Username/password for PLAIN auth. */
  withCredentials(username: string, password: string): this {
    return this.set('credentials', { username, password });
  }

  /** Port — defaults to 9042. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** If true, create the keyspace on startup (simple strategy, rf=1). */
  withAutoCreateKeyspace(autoCreateKeyspace = true): this {
    return this.set('autoCreateKeyspace', autoCreateKeyspace);
  }

  /** Replication options used by autoCreateKeyspace.  Ignored otherwise. */
  withReplication(replication: NonNullable<CassandraSnapshotStoreOptionsType['replication']>): this {
    return this.set('replication', replication);
  }

  /** CQL consistency level for all reads and writes.  Default `LOCAL_QUORUM` (6). */
  withConsistency(consistency: number): this {
    return this.set('consistency', consistency);
  }

  /* --- snapshot-store-specific fields --- */

  /** Table name; default `snapshots`. */
  withSnapshotsTable(snapshotsTable: string): this {
    return this.set('snapshotsTable', snapshotsTable);
  }

  /** Maximum number of snapshots kept per pid.  `<= 0` = keep all.  Default: 3. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }

  /** Auto-create the snapshots table on first connect. */
  withAutoCreateTables(autoCreateTables = true): this {
    return this.set('autoCreateTables', autoCreateTables);
  }

  /** Pre-built client — bypass internal construction (share with journal). */
  withClient(client: CassandraClientLike): this {
    return this.set('client', client);
  }
}

/**
 * Accepted input for the Cassandra snapshot-store constructor: the fluent
 * {@link CassandraSnapshotStoreOptionsBuilder} OR a plain {@link CassandraSnapshotStoreOptionsType} object.
 */
export type CassandraSnapshotStoreOptions = CassandraSnapshotStoreOptionsBuilder | Partial<CassandraSnapshotStoreOptionsType>;
/** Value alias so `CassandraSnapshotStoreOptions.create()` / `new CassandraSnapshotStoreOptions()` resolve to the builder. */
export const CassandraSnapshotStoreOptions = CassandraSnapshotStoreOptionsBuilder;
