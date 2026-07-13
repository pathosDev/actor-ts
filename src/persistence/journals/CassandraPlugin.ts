import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { CassandraJournal } from './CassandraJournal.js';
import type { CassandraJournalOptionsType } from './CassandraJournalOptions.js';
import { CassandraSnapshotStore } from '../snapshot-stores/CassandraSnapshotStore.js';
import type { CassandraSnapshotStoreOptionsType } from '../snapshot-stores/CassandraSnapshotStoreOptions.js';
import type { RegisterCassandraPluginsOptions, RegisterCassandraPluginsOptionsType } from './CassandraPluginOptions.js';

/** Canonical plug-in IDs for the Cassandra journal and snapshot store. */
export const CASSANDRA_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.cassandra';
export const CASSANDRA_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.cassandra';

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
  const resolvedOptions = (options as RegisterCassandraPluginsOptionsType);
  // Resolve each leaf to a plain object and merge the shared client (when
  // set) onto it, so both plug-ins reuse one connection tree.
  const journal = { ...((resolvedOptions.journal ?? {}) as Partial<CassandraJournalOptionsType>), ...(resolvedOptions.client ? { client: resolvedOptions.client } : {}) };
  const snapshotStore = { ...((resolvedOptions.snapshotStore ?? {}) as Partial<CassandraSnapshotStoreOptionsType>), ...(resolvedOptions.client ? { client: resolvedOptions.client } : {}) };
  ext.registerJournal(
    CASSANDRA_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new CassandraJournal(journal),
  );
  ext.registerSnapshotStore(
    CASSANDRA_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new CassandraSnapshotStore(snapshotStore),
  );
}
