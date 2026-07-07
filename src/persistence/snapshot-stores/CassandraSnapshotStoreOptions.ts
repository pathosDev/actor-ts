import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { CassandraClientLike } from '../journals/CassandraClient.js';
import type { CassandraSnapshotStoreSettings } from './CassandraSnapshotStore.js';

/**
 * Fluent builder for {@link CassandraSnapshotStoreSettings}:
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
export class CassandraSnapshotStoreOptions extends OptionsBuilder<CassandraSnapshotStoreSettings> {
  /** Start a fresh builder.  Equivalent to `new CassandraSnapshotStoreOptions()`. */
  static create(): CassandraSnapshotStoreOptions {
    return new CassandraSnapshotStoreOptions();
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

  /** Replication settings used by autoCreateKeyspace.  Ignored otherwise. */
  withReplication(replication: NonNullable<CassandraSnapshotStoreSettings['replication']>): this {
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
