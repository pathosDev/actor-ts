import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { CassandraClientLike, CassandraConnection } from './CassandraClient.js';

export interface CassandraJournalOptionsType extends CassandraConnection {
  /** Table name for events.  Default: `events`. */
  readonly eventsTable?: string;
  /** Table tracking the highest sequence number per pid.  Default: `metadata`. */
  readonly metadataTable?: string;
  /** Lookup table for `persistenceIds()`.  Default: `all_persistence_ids`. */
  readonly allIdsTable?: string;
  /** Tag-index side table populated when `useTagIndex` is set.  Default: `events_by_tag`. */
  readonly tagIndexTable?: string;
  /**
   * Rows per partition before rolling over to a new one.  Keeps Cassandra
   * partitions bounded.  Default: 500_000 — a good balance between write
   * amplification and read-scan cost for long-lived streams.
   */
  readonly partitionSize?: number;
  /** Auto-create the events/metadata/all-ids tables on first connect. */
  readonly autoCreateTables?: boolean;
  /**
   * Opt in to maintaining an `events_by_tag` side table for indexed
   * `eventsByTag` queries (#44).  When set, every `append` writes one
   * extra row per `(event, tag)` pair to the side table inside the same
   * batch as the primary `events` insert; `CassandraQuery.currentEventsBy
   * Tag` then walks a single tag-partition instead of scanning the
   * whole journal client-side.
   *
   * Off by default to keep existing schemas compatible — operators
   * opting in must run the side-table DDL on their cluster (the journal
   * issues `CREATE TABLE IF NOT EXISTS` when `autoCreateTables` is also
   * true; otherwise the DDL in {@link CassandraClient.tagIndexDdl} can
   * be applied manually).
   *
   * **Caveat:** `delete(toSeq)` does NOT propagate to the side table —
   * deleting from `events_by_tag` would require either a secondary
   * index on `persistence_id` or pre-reading the event's tags (extra
   * round-trips on the hot path).  Operators with delete-heavy
   * workloads should rely on Cassandra TTLs or accept stale tag
   * entries (queries dedupe via the primary key, so they're harmless
   * — just storage overhead).
   */
  readonly useTagIndex?: boolean;
  /**
   * Inject a pre-built client instead of letting the journal instantiate
   * `cassandra-driver` itself — useful for tests and when the host already
   * owns the client lifecycle.
   */
  readonly client?: CassandraClientLike;
}

/**
 * Fluent builder for {@link CassandraJournalOptionsType}:
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
export class CassandraJournalOptionsBuilder extends OptionsBuilder<CassandraJournalOptionsType> {
  /** Start a fresh builder.  Equivalent to `new CassandraJournalOptionsBuilder()`. */
  static create(): CassandraJournalOptionsBuilder {
    return new CassandraJournalOptionsBuilder();
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
  withReplication(replication: NonNullable<CassandraJournalOptionsType['replication']>): this {
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

/** Validates resolved {@link CassandraJournalOptionsType} settings. */
export class CassandraJournalOptionsValidator extends OptionsValidator<CassandraJournalOptionsType> {
  constructor() {
    super('CassandraJournalOptions');
  }
  protected rules(_s: Partial<CassandraJournalOptionsType>): void {
    this.port('port'); // real Cassandra CQL port (default 9042)
    this.positiveInt('partitionSize');
  }
}

/**
 * Accepted input for any Cassandra-journal constructor: the fluent
 * {@link CassandraJournalOptionsBuilder} OR a plain {@link CassandraJournalOptionsType} object.
 */
export type CassandraJournalOptions = CassandraJournalOptionsBuilder | Partial<CassandraJournalOptionsType>;
/** Value alias so `CassandraJournalOptions.create()` / `new CassandraJournalOptions()` resolve to the builder. */
export const CassandraJournalOptions = CassandraJournalOptionsBuilder;
