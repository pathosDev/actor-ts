import type { ActorSystem } from '../../ActorSystem.js';
import { Lazy } from '../../util/Lazy.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { PostgresJournal } from './PostgresJournal.js';
import type { PostgresJournalOptionsType } from './PostgresJournalOptions.js';
import { PostgresSnapshotStore } from '../snapshot-stores/PostgresSnapshotStore.js';
import type { PostgresSnapshotStoreOptionsType } from '../snapshot-stores/PostgresSnapshotStoreOptions.js';
import { PostgresDurableStateStore } from '../durable-state-stores/PostgresDurableStateStore.js';
import type { PostgresDurableStateStoreOptionsType } from '../durable-state-stores/PostgresDurableStateStoreOptions.js';
import {
  readPostgresDurableStateStoreOptionsFromConfig,
  readPostgresJournalOptionsFromConfig,
  readPostgresSnapshotStoreOptionsFromConfig,
} from './PostgresPluginOptions.js';
import type { RegisterPostgresPluginsOptions, RegisterPostgresPluginsOptionsType } from './PostgresPluginOptions.js';

/** Canonical plug-in IDs for the Postgres journal, snapshot, and durable-state stores. */
export const POSTGRES_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.postgres';
export const POSTGRES_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.postgres';
export const POSTGRES_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.postgres';

export type PostgresPluginHandles = {
  /**
   * The DurableState store instance, for a caller that wires
   * `DurableStateOptions.store` by hand rather than selecting the store with
   * `actor-ts.persistence.durable-state.plugin`.
   *
   * A **getter**, and built on first read rather than at registration (#872).
   * The store is now a registered factory like the other two, so it has a
   * block of its own to read — and reading it means waiting until somebody
   * actually asks for a store, which is also when the same instance is handed
   * to `ext.durableStateStore`.  Either route yields the one object; a caller
   * that never touches durable state builds none.
   */
  readonly durableStateStore: PostgresDurableStateStore;
};

/**
 * One-shot registration of the Postgres journal, snapshot store and
 * durable-state store against the running `PersistenceExtension`.  Mirrors
 * `registerMariaDbPlugins` / `registerObjectStoragePlugins`.
 *
 * After this call, activate the stores via:
 *   `actor-ts.persistence.journal.plugin        = "actor-ts.persistence.journal.postgres"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.postgres"`
 *   `actor-ts.persistence.durable-state.plugin  = "actor-ts.persistence.durable-state.postgres"`
 * either via HOCON or a `{ config: { … } }` override.
 *
 * **Everything except the live objects can come from configuration** (#872).
 * `url`, the table names and `auto-create-tables` all have leaves under the
 * three blocks named above, so `registerPostgresPlugins(ext)` with no options
 * at all is a complete wiring when `application.conf` fills them in.
 * Precedence is the project-wide one — explicit options > HOCON > built-in
 * defaults, per field, with an unset field falling through rather than
 * shadowing.  The merge happens **inside each registered factory**, because a
 * factory is handed the `ActorSystem` and that is the only route to
 * `system.config`.
 *
 * Pass `pool` to share a single connection pool across all three stores
 * (recommended when they target the same DB).  A shared pool is caller-owned:
 * no store ends it, so close it yourself at shutdown.
 */
export function registerPostgresPlugins(
  ext: PersistenceExtension,
  options: RegisterPostgresPluginsOptions = {},
): PostgresPluginHandles {
  const resolvedOptions = (options as RegisterPostgresPluginsOptionsType);

  const { pool, serializer } = resolvedOptions;
  const journal = mergeLeafOptions<Partial<PostgresJournalOptionsType>>(resolvedOptions.journal, { pool }, { serializer });
  const snapshotStore = mergeLeafOptions<Partial<PostgresSnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, { pool }, { serializer });
  const durableState = mergeLeafOptions<Partial<PostgresDurableStateStoreOptionsType>>(resolvedOptions.durableStateStore, { pool }, { serializer });

  ext.registerJournal(
    POSTGRES_JOURNAL_PLUGIN_ID,
    (system: ActorSystem) => new PostgresJournal(mergeOptions<PostgresJournalOptionsType>(
      {},
      readPostgresJournalOptionsFromConfig(system.config, POSTGRES_JOURNAL_PLUGIN_ID),
      journal,
    )),
  );
  ext.registerSnapshotStore(
    POSTGRES_SNAPSHOT_PLUGIN_ID,
    (system: ActorSystem) => new PostgresSnapshotStore(mergeOptions<PostgresSnapshotStoreOptionsType>(
      {},
      readPostgresSnapshotStoreOptionsFromConfig(system.config, POSTGRES_SNAPSHOT_PLUGIN_ID),
      snapshotStore,
    )),
  );
  // One instance, whichever way it is reached: the registry's factory and the
  // returned handle both resolve this lazy.  `ext.config` is the same resolved
  // configuration the factory's `system.config` is.
  const durableStateStoreLazy = Lazy.of(() => new PostgresDurableStateStore(
    mergeOptions<PostgresDurableStateStoreOptionsType>(
      {},
      readPostgresDurableStateStoreOptionsFromConfig(ext.config, POSTGRES_DURABLE_STATE_PLUGIN_ID),
      durableState,
    ),
  ));
  ext.registerDurableStateStore(POSTGRES_DURABLE_STATE_PLUGIN_ID, () => durableStateStoreLazy.get());
  return { get durableStateStore(): PostgresDurableStateStore { return durableStateStoreLazy.get(); } };
}
