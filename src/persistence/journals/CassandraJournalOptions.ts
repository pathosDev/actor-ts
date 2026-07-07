import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { CassandraClientLike } from './CassandraClient.js';
import type { CassandraJournalSettings } from './CassandraJournal.js';

/**
 * Fluent builder for {@link CassandraJournalSettings}:
 *
 *     new CassandraJournal(
 *       CassandraJournalOptions.create()
 *         .withContactPoints(['10.0.0.1'])
 *         .withKeyspace('app')
 *         .withUseTagIndex(true),
 *     )
 *
 * Carries `withX` methods for the shared {@link CassandraConnection}
 * fields too — the connection mixin is not built on its own; each
 * concrete store exposes its connection surface directly.
 */
export class CassandraJournalOptions extends OptionsBuilder<CassandraJournalSettings> {
  /** Start a fresh builder.  Equivalent to `new CassandraJournalOptions()`. */
  static create(): CassandraJournalOptions {
    return new CassandraJournalOptions();
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
  withReplication(replication: NonNullable<CassandraJournalSettings['replication']>): this {
    return this.set('replication', replication);
  }

  /** CQL consistency level for all reads and writes.  Default `LOCAL_QUORUM` (6). */
  withConsistency(consistency: number): this {
    return this.set('consistency', consistency);
  }

  /* --- journal-specific fields --- */

  /** Table name for events.  Default: `events`. */
  withEventsTable(eventsTable: string): this {
    return this.set('eventsTable', eventsTable);
  }

  /** Table tracking the highest sequence number per pid.  Default: `metadata`. */
  withMetadataTable(metadataTable: string): this {
    return this.set('metadataTable', metadataTable);
  }

  /** Lookup table for `persistenceIds()`.  Default: `all_persistence_ids`. */
  withAllIdsTable(allIdsTable: string): this {
    return this.set('allIdsTable', allIdsTable);
  }

  /** Tag-index side table populated when `useTagIndex` is set.  Default: `events_by_tag`. */
  withTagIndexTable(tagIndexTable: string): this {
    return this.set('tagIndexTable', tagIndexTable);
  }

  /** Rows per partition before rolling over to a new one.  Default: 500_000. */
  withPartitionSize(partitionSize: number): this {
    return this.set('partitionSize', partitionSize);
  }

  /** Auto-create the events/metadata/all-ids tables on first connect. */
  withAutoCreateTables(autoCreateTables = true): this {
    return this.set('autoCreateTables', autoCreateTables);
  }

  /** Opt in to maintaining an `events_by_tag` side table for indexed `eventsByTag` queries (#44). */
  withUseTagIndex(useTagIndex = true): this {
    return this.set('useTagIndex', useTagIndex);
  }

  /** Inject a pre-built client instead of letting the journal instantiate `cassandra-driver` itself. */
  withClient(client: CassandraClientLike): this {
    return this.set('client', client);
  }
}
