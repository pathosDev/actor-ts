import type { ActorSystem } from '../../ActorSystem.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { DynamoDbDurableStateStore } from '../durable-state-stores/DynamoDbDurableStateStore.js';
import type { DynamoDbDurableStateStoreOptionsType } from '../durable-state-stores/DynamoDbDurableStateStoreOptions.js';
import { DynamoDbSnapshotStore } from '../snapshot-stores/DynamoDbSnapshotStore.js';
import type { DynamoDbSnapshotStoreOptionsType } from '../snapshot-stores/DynamoDbSnapshotStoreOptions.js';
import { DynamoDbJournal } from './DynamoDbJournal.js';
import type { DynamoDbJournalOptionsType } from './DynamoDbJournalOptions.js';
import type {
  RegisterDynamoDbPluginsOptions,
  RegisterDynamoDbPluginsOptionsType,
} from './DynamoDbPluginOptions.js';

/** Canonical plug-in IDs for the DynamoDB journal, snapshot, and durable-state stores. */
export const DYNAMODB_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.dynamodb';
export const DYNAMODB_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.dynamodb';
export const DYNAMODB_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.dynamodb';

export type DynamoDbPluginHandles = {
  /**
   * The DurableState store instance.  `PersistenceExtension` carries no
   * DurableState registry (same as every other plugin), so callers who want
   * DurableState read it from the return value and pass it into their
   * `DurableStateActor` options.
   */
  readonly durableStateStore: DynamoDbDurableStateStore;
};

/**
 * One-shot registration of the DynamoDB journal + snapshot store against the
 * running `PersistenceExtension`, returning a ready-to-use DurableState store
 * handle.  Mirrors `registerPostgresPlugins` / `registerMongoPlugins`.
 *
 * After this call, activate the journal + snapshot store via:
 *   `actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.dynamodb"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.dynamodb"`
 * either via HOCON or a `{ config: { … } }` override.
 *
 * Pass `operations` to share one client across all three stores — one
 * `DynamoDBClient` pools connections for every table, so sharing is the normal
 * case.  With a shared façade no store owns it, so none closes it: close it
 * yourself when the system shuts down.  Passing `region` / `endpoint` instead
 * lets each store build its own client and close it on `close()`.
 */
export function registerDynamoDbPlugins(
  ext: PersistenceExtension,
  options: RegisterDynamoDbPluginsOptions = {},
): DynamoDbPluginHandles {
  const resolvedOptions = (options as RegisterDynamoDbPluginsOptionsType);
  const { operations, region, endpoint, clientConfig } = resolvedOptions;
  // A shared façade overrides a leaf's own; shared connection details only fill
  // in where the leaf is silent.
  const shared = { operations };
  const connection = { region, endpoint, clientConfig };

  const journal = mergeLeafOptions<Partial<DynamoDbJournalOptionsType>>(resolvedOptions.journal, shared, connection);
  const snapshotStore = mergeLeafOptions<Partial<DynamoDbSnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, shared, connection);
  const durableState = mergeLeafOptions<Partial<DynamoDbDurableStateStoreOptionsType>>(resolvedOptions.durableStateStore, shared, connection);

  ext.registerJournal(
    DYNAMODB_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new DynamoDbJournal(journal),
  );
  ext.registerSnapshotStore(
    DYNAMODB_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new DynamoDbSnapshotStore(snapshotStore),
  );
  const durableStateStore = new DynamoDbDurableStateStore(durableState);
  return { durableStateStore };
}
