import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { D1DurableStateStore } from '../durable-state-stores/D1DurableStateStore.js';
import type { D1DurableStateStoreOptionsType } from '../durable-state-stores/D1DurableStateStoreOptions.js';
import { D1SnapshotStore } from '../snapshot-stores/D1SnapshotStore.js';
import type { D1SnapshotStoreOptionsType } from '../snapshot-stores/D1SnapshotStoreOptions.js';
import { D1Journal } from './D1Journal.js';
import type { D1JournalOptionsType } from './D1JournalOptions.js';
import type { RegisterD1PluginsOptions, RegisterD1PluginsOptionsType } from './D1PluginOptions.js';

/** Canonical plug-in IDs for the Cloudflare D1 journal, snapshot, and durable-state stores. */
export const D1_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.cloudflare-d1';
export const D1_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.cloudflare-d1';
export const D1_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.cloudflare-d1';

export interface D1PluginHandles {
  /**
   * The DurableState store instance.  `PersistenceExtension` carries no
   * DurableState registry (same as every other plugin), so callers who want
   * DurableState read it from the return value and pass it into their
   * `DurableStateActor` options.
   */
  readonly durableStateStore: D1DurableStateStore;
}

/**
 * One-shot registration of the Cloudflare D1 journal + snapshot store against the
 * running `PersistenceExtension`, returning a ready-to-use DurableState store
 * handle.  Mirrors `registerLibSqlPlugins`.
 *
 * After this call, activate the journal + snapshot store via:
 *   `actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.cloudflare-d1"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.cloudflare-d1"`
 * either via HOCON or a `{ config: { … } }` override.
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
  const { client, accountId, databaseId, apiToken, baseUrl } = resolvedOptions;
  // A shared transport overrides a leaf's own; shared credentials only fill in
  // where the leaf is silent.
  const shared = { client };
  const connection = { accountId, databaseId, apiToken, baseUrl };

  const journal = mergeLeafOptions<Partial<D1JournalOptionsType>>(resolvedOptions.journal, shared, connection);
  const snapshotStore = mergeLeafOptions<Partial<D1SnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, shared, connection);
  const durableState = mergeLeafOptions<Partial<D1DurableStateStoreOptionsType>>(resolvedOptions.durableStateStore, shared, connection);

  ext.registerJournal(
    D1_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new D1Journal(journal),
  );
  ext.registerSnapshotStore(
    D1_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new D1SnapshotStore(snapshotStore),
  );
  const durableStateStore = new D1DurableStateStore(durableState);
  return { durableStateStore };
}
