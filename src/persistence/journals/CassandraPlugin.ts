import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import {
  CassandraJournal,
  type CassandraJournalOptions,
} from './CassandraJournal.js';
import {
  CassandraSnapshotStore,
  type CassandraSnapshotStoreOptions,
} from '../snapshot-stores/CassandraSnapshotStore.js';
import type { CassandraClientLike } from './CassandraClient.js';

/** Canonical plug-in IDs for the Cassandra journal and snapshot store. */
export const CASSANDRA_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.cassandra';
export const CASSANDRA_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.cassandra';

export interface RegisterCassandraPluginsOptions {
  /**
   * Shared CQL client used by the journal AND the snapshot store.  When
   * provided, both plug-ins reuse the same connection pool (one TCP
   * connection tree per cluster node).  When omitted, each plug-in
   * constructs its own client.
   */
  readonly client?: CassandraClientLike;
  /** Journal-specific overrides. */
  readonly journal: Omit<CassandraJournalOptions, 'client'>;
  /** Snapshot-store-specific overrides.  Usually shares keyspace with the journal. */
  readonly snapshotStore: Omit<CassandraSnapshotStoreOptions, 'client'>;
}

/**
 * One-shot registration of both the Cassandra/Scylla journal and the
 * matching snapshot store against the running `PersistenceExtension`.
 * After this call set
 *   `actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.cassandra"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.cassandra"`
 * either via HOCON or a `{ config: { ... } }` override to make them active.
 */
export function registerCassandraPlugins(
  ext: PersistenceExtension,
  options: RegisterCassandraPluginsOptions,
): void {
  ext.registerJournal(
    CASSANDRA_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new CassandraJournal({ ...options.journal, client: options.client }),
  );
  ext.registerSnapshotStore(
    CASSANDRA_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new CassandraSnapshotStore({ ...options.snapshotStore, client: options.client }),
  );
}
