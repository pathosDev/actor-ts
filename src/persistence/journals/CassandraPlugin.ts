import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { CassandraJournal } from './CassandraJournal.js';
import type { CassandraJournalOptions } from './CassandraJournalOptions.js';
import type { CassandraJournalSettings } from './CassandraJournal.js';
import { CassandraSnapshotStore } from '../snapshot-stores/CassandraSnapshotStore.js';
import type { CassandraSnapshotStoreOptions } from '../snapshot-stores/CassandraSnapshotStoreOptions.js';
import type { CassandraSnapshotStoreSettings } from '../snapshot-stores/CassandraSnapshotStore.js';
import type { CassandraClientLike } from './CassandraClient.js';
import type { RegisterCassandraPluginsOptions } from './CassandraPluginOptions.js';

/** Canonical plug-in IDs for the Cassandra journal and snapshot store. */
export const CASSANDRA_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.cassandra';
export const CASSANDRA_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.cassandra';

export interface RegisterCassandraPluginsSettings {
  /**
   * Shared CQL client used by the journal AND the snapshot store.  When
   * provided, both plug-ins reuse the same connection pool (one TCP
   * connection tree per cluster node).  When omitted, each plug-in
   * constructs its own client.
   */
  readonly client?: CassandraClientLike;
  /** Journal-specific overrides. */
  readonly journal: CassandraJournalOptions | Partial<CassandraJournalSettings>;
  /** Snapshot-store-specific overrides.  Usually shares keyspace with the journal. */
  readonly snapshotStore: CassandraSnapshotStoreOptions | Partial<CassandraSnapshotStoreSettings>;
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
  options: RegisterCassandraPluginsOptions | Partial<RegisterCassandraPluginsSettings>,
): void {
  const s = (options as Partial<RegisterCassandraPluginsSettings>);
  // Resolve each leaf to a plain object and merge the shared client (when
  // set) onto it, so both plug-ins reuse one connection tree.
  const journal = { ...((s.journal ?? {}) as Partial<CassandraJournalSettings>), ...(s.client ? { client: s.client } : {}) };
  const snapshotStore = { ...((s.snapshotStore ?? {}) as Partial<CassandraSnapshotStoreSettings>), ...(s.client ? { client: s.client } : {}) };
  ext.registerJournal(
    CASSANDRA_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new CassandraJournal(journal),
  );
  ext.registerSnapshotStore(
    CASSANDRA_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new CassandraSnapshotStore(snapshotStore),
  );
}
