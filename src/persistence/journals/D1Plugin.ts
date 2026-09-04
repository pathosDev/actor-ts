import type { ActorSystem } from '../../ActorSystem.js';
import { Lazy } from '../../util/Lazy.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { D1DurableStateStore } from '../durable-state-stores/D1DurableStateStore.js';
import type { D1DurableStateStoreOptionsType } from '../durable-state-stores/D1DurableStateStoreOptions.js';
import { D1SnapshotStore } from '../snapshot-stores/D1SnapshotStore.js';
import type { D1SnapshotStoreOptionsType } from '../snapshot-stores/D1SnapshotStoreOptions.js';
import { D1Journal } from './D1Journal.js';
import type { D1JournalOptionsType } from './D1JournalOptions.js';
import {
  readD1DurableStateStoreOptionsFromConfig,
  readD1JournalOptionsFromConfig,
  readD1SnapshotStoreOptionsFromConfig,
} from './D1PluginOptions.js';
import type { RegisterD1PluginsOptions, RegisterD1PluginsOptionsType } from './D1PluginOptions.js';

/** Canonical plug-in IDs for the Cloudflare D1 journal, snapshot, and durable-state stores. */
export const D1_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.cloudflare-d1';
export const D1_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.cloudflare-d1';
export const D1_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.cloudflare-d1';

export type D1PluginHandles = {
  /**
   * The DurableState store instance, for a caller that wires
   * `DurableStateOptions.store` by hand rather than selecting the store with
   * `actor-ts.persistence.durable-state.plugin`.  A getter, built on first
   * read — see `PostgresPluginHandles` for why (#872).
   */
  readonly durableStateStore: D1DurableStateStore;
};

/**
 * One-shot registration of the Cloudflare D1 journal, snapshot store and
 * durable-state store against the running `PersistenceExtension`.  Mirrors
 * `registerLibSqlPlugins`.
 *
 * After this call, activate the stores via:
 *   `actor-ts.persistence.journal.plugin        = "actor-ts.persistence.journal.cloudflare-d1"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.cloudflare-d1"`
 *   `actor-ts.persistence.durable-state.plugin  = "actor-ts.persistence.durable-state.cloudflare-d1"`
 * either via HOCON or a `{ config: { … } }` override.
 *
 * `account-id`, `database-id`, `api-token`, `base-url`, the table names and
 * `auto-create-tables` all have leaves under those three blocks (#872), so
 * `registerD1Plugins(ext)` with no options is a complete wiring when
 * `application.conf` fills them in — put the token in the environment and
 * substitute it (`api-token = ${?CLOUDFLARE_API_TOKEN}`).
 *
 * Pass `client` to share one transport across all three stores.  With a shared
 * transport no store owns it, so none closes it — though for D1 that costs
 * nothing either way, since `fetch` holds no handle to release.
 */
export function registerD1Plugins(
  ext: PersistenceExtension,
  options: RegisterD1PluginsOptions = {},
): D1PluginHandles {
  const resolvedOptions = (options as RegisterD1PluginsOptionsType);
  const { client, accountId, databaseId, apiToken, baseUrl, serializer } = resolvedOptions;
  // A shared transport overrides a leaf's own; shared credentials and the
  // serializer only fill in where the leaf is silent.
  const shared = { client };
  const connection = { accountId, databaseId, apiToken, baseUrl, serializer };

  const journal = mergeLeafOptions<Partial<D1JournalOptionsType>>(resolvedOptions.journal, shared, connection);
  const snapshotStore = mergeLeafOptions<Partial<D1SnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, shared, connection);
  const durableState = mergeLeafOptions<Partial<D1DurableStateStoreOptionsType>>(resolvedOptions.durableStateStore, shared, connection);

  ext.registerJournal(
    D1_JOURNAL_PLUGIN_ID,
    (system: ActorSystem) => new D1Journal(mergeOptions<D1JournalOptionsType>(
      {},
      readD1JournalOptionsFromConfig(system.config, D1_JOURNAL_PLUGIN_ID),
      journal,
    )),
  );
  ext.registerSnapshotStore(
    D1_SNAPSHOT_PLUGIN_ID,
    (system: ActorSystem) => new D1SnapshotStore(mergeOptions<D1SnapshotStoreOptionsType>(
      {},
      readD1SnapshotStoreOptionsFromConfig(system.config, D1_SNAPSHOT_PLUGIN_ID),
      snapshotStore,
    )),
  );
  const durableStateStoreLazy = Lazy.of(() => new D1DurableStateStore(
    mergeOptions<D1DurableStateStoreOptionsType>(
      {},
      readD1DurableStateStoreOptionsFromConfig(ext.config, D1_DURABLE_STATE_PLUGIN_ID),
      durableState,
    ),
  ));
  ext.registerDurableStateStore(D1_DURABLE_STATE_PLUGIN_ID, () => durableStateStoreLazy.get());
  return { get durableStateStore(): D1DurableStateStore { return durableStateStoreLazy.get(); } };
}
