import type { ActorSystem } from '../../ActorSystem.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { CassandraJournal } from './CassandraJournal.js';
import type { CassandraJournalOptionsType } from './CassandraJournalOptions.js';
import { CassandraSnapshotStore } from '../snapshot-stores/CassandraSnapshotStore.js';
import type { CassandraSnapshotStoreOptionsType } from '../snapshot-stores/CassandraSnapshotStoreOptions.js';
import {
  readCassandraJournalOptionsFromConfig,
  readCassandraSnapshotStoreOptionsFromConfig,
} from './CassandraPluginOptions.js';
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
 *
 * **Both blocks are readable configuration now** (#872).  The seed list, the
 * keyspace, the topology coordinates and the whole four-table schema have
 * leaves under the two ids above, so `registerCassandraPlugins(ext)` with no
 * options at all is a complete wiring when `application.conf` fills them in —
 * which is why `options` is optional here as it is for the other backends.
 * Precedence is the project-wide one: explicit options > HOCON > built-in
 * defaults, per field, with an unset field falling through rather than
 * shadowing.  The merge happens **inside each registered factory**, because a
 * factory is handed the `ActorSystem` and that is the only route to
 * `system.config`.
 *
 * There is deliberately no durable-state registration: the tree ships no
 * Cassandra durable-state store, so this backend has two axes where the others
 * have three.
 */
export function registerCassandraPlugins(
  ext: PersistenceExtension,
  options: RegisterCassandraPluginsOptions = {},
): void {
  const resolvedOptions = (options as RegisterCassandraPluginsOptionsType);
  // Merge the shared client (when set) onto each leaf so both plug-ins reuse
  // one connection tree; the shared serializer only fills in where a leaf is
  // silent (same semantics as the relational register helpers).
  const { client, serializer } = resolvedOptions;
  const journal = mergeLeafOptions<Partial<CassandraJournalOptionsType>>(resolvedOptions.journal, { client }, { serializer });
  const snapshotStore = mergeLeafOptions<Partial<CassandraSnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, { client }, { serializer });
  ext.registerJournal(
    CASSANDRA_JOURNAL_PLUGIN_ID,
    (system: ActorSystem) => new CassandraJournal(mergeOptions<CassandraJournalOptionsType>(
      {},
      readCassandraJournalOptionsFromConfig(system.config, CASSANDRA_JOURNAL_PLUGIN_ID),
      journal,
    )),
  );
  ext.registerSnapshotStore(
    CASSANDRA_SNAPSHOT_PLUGIN_ID,
    (system: ActorSystem) => new CassandraSnapshotStore(mergeOptions<CassandraSnapshotStoreOptionsType>(
      {},
      readCassandraSnapshotStoreOptionsFromConfig(system.config, CASSANDRA_SNAPSHOT_PLUGIN_ID),
      snapshotStore,
    )),
  );
}
