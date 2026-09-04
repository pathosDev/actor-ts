import type { ActorSystem } from '../../ActorSystem.js';
import { Lazy } from '../../util/Lazy.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { DynamoDbDurableStateStore } from '../durable-state-stores/DynamoDbDurableStateStore.js';
import type { DynamoDbDurableStateStoreOptionsType } from '../durable-state-stores/DynamoDbDurableStateStoreOptions.js';
import { DynamoDbSnapshotStore } from '../snapshot-stores/DynamoDbSnapshotStore.js';
import type { DynamoDbSnapshotStoreOptionsType } from '../snapshot-stores/DynamoDbSnapshotStoreOptions.js';
import { DynamoDbJournal } from './DynamoDbJournal.js';
import type { DynamoDbJournalOptionsType } from './DynamoDbJournalOptions.js';
import {
  readDynamoDbDurableStateStoreOptionsFromConfig,
  readDynamoDbJournalOptionsFromConfig,
  readDynamoDbSnapshotStoreOptionsFromConfig,
} from './DynamoDbPluginOptions.js';
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
   * The DurableState store instance, for a caller that wires
   * `DurableStateOptions.store` by hand rather than selecting the store with
   * `actor-ts.persistence.durable-state.plugin`.
   *
   * A **getter**, and built on first read rather than at registration (#872) —
   * see `PostgresPluginHandles` for the full reasoning.  Either route yields
   * the one object; a caller that never touches durable state builds none.
   */
  readonly durableStateStore: DynamoDbDurableStateStore;
};

/**
 * One-shot registration of the DynamoDB journal, snapshot store and
 * durable-state store against the running `PersistenceExtension`.  Mirrors
 * `registerPostgresPlugins` / `registerMongoPlugins`.
 *
 * After this call, activate the stores via:
 *   `actor-ts.persistence.journal.plugin        = "actor-ts.persistence.journal.dynamodb"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.dynamodb"`
 *   `actor-ts.persistence.durable-state.plugin  = "actor-ts.persistence.durable-state.dynamodb"`
 * either via HOCON or a `{ config: { … } }` override.
 *
 * **The reachability half can come from configuration** (#872): `region`,
 * `endpoint` and the table names have leaves under the three blocks named
 * above, so `registerDynamoDbPlugins(ext)` with no options at all is a complete
 * wiring when `application.conf` fills them in.  Table *provisioning* —
 * billing mode, capacity, the create-on-first-use switch — stays code-only for
 * now.  Precedence is the project-wide one: explicit options > HOCON >
 * built-in defaults, per field, with an unset field falling through rather than
 * shadowing.
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
  const { operations, region, endpoint, clientConfig, serializer } = resolvedOptions;
  // A shared façade overrides a leaf's own; shared connection details and the
  // serializer only fill in where the leaf is silent.
  const shared = { operations };
  const connection = { region, endpoint, clientConfig, serializer };

  const journal = mergeLeafOptions<Partial<DynamoDbJournalOptionsType>>(resolvedOptions.journal, shared, connection);
  const snapshotStore = mergeLeafOptions<Partial<DynamoDbSnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, shared, connection);
  const durableState = mergeLeafOptions<Partial<DynamoDbDurableStateStoreOptionsType>>(resolvedOptions.durableStateStore, shared, connection);

  ext.registerJournal(
    DYNAMODB_JOURNAL_PLUGIN_ID,
    (system: ActorSystem) => new DynamoDbJournal(mergeOptions<DynamoDbJournalOptionsType>(
      {},
      readDynamoDbJournalOptionsFromConfig(system.config, DYNAMODB_JOURNAL_PLUGIN_ID),
      journal,
    )),
  );
  ext.registerSnapshotStore(
    DYNAMODB_SNAPSHOT_PLUGIN_ID,
    (system: ActorSystem) => new DynamoDbSnapshotStore(mergeOptions<DynamoDbSnapshotStoreOptionsType>(
      {},
      readDynamoDbSnapshotStoreOptionsFromConfig(system.config, DYNAMODB_SNAPSHOT_PLUGIN_ID),
      snapshotStore,
    )),
  );
  // One instance, whichever way it is reached — see `registerPostgresPlugins`.
  const durableStateStoreLazy = Lazy.of(() => new DynamoDbDurableStateStore(
    mergeOptions<DynamoDbDurableStateStoreOptionsType>(
      {},
      readDynamoDbDurableStateStoreOptionsFromConfig(ext.config, DYNAMODB_DURABLE_STATE_PLUGIN_ID),
      durableState,
    ),
  ));
  ext.registerDurableStateStore(DYNAMODB_DURABLE_STATE_PLUGIN_ID, () => durableStateStoreLazy.get());
  return { get durableStateStore(): DynamoDbDurableStateStore { return durableStateStoreLazy.get(); } };
}
