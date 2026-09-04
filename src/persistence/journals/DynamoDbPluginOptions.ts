import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Serializer } from '../../serialization/Serializer.js';
import { readStoreIdentifier, readStoreInt, readStoreString, storeLeaf } from '../StoreConfig.js';
import type { DynamoDbOperations } from './DynamoDbClient.js';
import type { DynamoDbJournalOptions, DynamoDbJournalOptionsType } from './DynamoDbJournalOptions.js';
import type {
  DynamoDbSnapshotStoreOptions,
  DynamoDbSnapshotStoreOptionsType,
} from '../snapshot-stores/DynamoDbSnapshotStoreOptions.js';
import type {
  DynamoDbDurableStateStoreOptions,
  DynamoDbDurableStateStoreOptionsType,
} from '../durable-state-stores/DynamoDbDurableStateStoreOptions.js';

export type RegisterDynamoDbPluginsOptionsType = {
  /**
   * Shared operations façade injected into all three stores — the usual case,
   * since one `DynamoDBClient` pools connections for every table.  When omitted,
   * each store lazily builds its own from `region` / `endpoint`.
   */
  readonly operations?: DynamoDbOperations;
  /** AWS region applied to every store that does not set its own. */
  readonly region?: string;
  /** Endpoint override applied to every store that does not set its own. */
  readonly endpoint?: string;
  /** `DynamoDBClient` config applied to every store that does not set its own. */
  readonly clientConfig?: Record<string, unknown>;
  /** Shared payload serializer applied to every store that does not set its own. */
  readonly serializer?: Serializer;
  /** Journal-specific options (table name). */
  readonly journal?: DynamoDbJournalOptions;
  /** Snapshot-store-specific options (table name, keepN). */
  readonly snapshotStore?: DynamoDbSnapshotStoreOptions;
  /** Durable-state-store-specific options (table name). */
  readonly durableStateStore?: DynamoDbDurableStateStoreOptions;
};

/**
 * Fluent builder for {@link RegisterDynamoDbPluginsOptionsType}:
 *
 *     const pluginOptions = RegisterDynamoDbPluginsOptions.create()
 *       .withRegion('eu-central-1')
 *       .withSnapshotStore(DynamoDbSnapshotStoreOptions.create().withKeepN(5));
 *     const handles = registerDynamoDbPlugins(persistence, pluginOptions);
 *
 * The shared connection fields are merged onto each store's options by
 * `registerDynamoDbPlugins`, so a leaf carries only its store-specific fields.
 * Each leaf setter accepts EITHER the leaf builder OR a plain object.
 */
export class RegisterDynamoDbPluginsOptionsBuilder
  extends OptionsBuilder<RegisterDynamoDbPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterDynamoDbPluginsOptionsBuilder()`. */
  static create(): RegisterDynamoDbPluginsOptionsBuilder {
    return new RegisterDynamoDbPluginsOptionsBuilder();
  }

  /** Shared operations façade injected into all three stores. */
  withOperations(operations: DynamoDbOperations): this {
    return this.set('operations', operations);
  }

  /** Shared payload serializer applied to every store that does not set its own. */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer', serializer);
  }

  /** AWS region applied to every store that does not set its own. */
  withRegion(region: string): this {
    return this.set('region', region);
  }

  /** Endpoint override applied to every store that does not set its own. */
  withEndpoint(endpoint: string): this {
    return this.set('endpoint', endpoint);
  }

  /** `DynamoDBClient` config applied to every store that does not set its own. */
  withClientConfig(clientConfig: Record<string, unknown>): this {
    return this.set('clientConfig', clientConfig);
  }

  /** Journal-specific options (table name). */
  withJournal(journal: DynamoDbJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options (table name, keepN). */
  withSnapshotStore(snapshotStore: DynamoDbSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options (table name). */
  withDurableStateStore(durableStateStore: DynamoDbDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for `registerDynamoDbPlugins`: the fluent
 * {@link RegisterDynamoDbPluginsOptionsBuilder} OR a plain
 * {@link RegisterDynamoDbPluginsOptionsType} object.
 */
export type RegisterDynamoDbPluginsOptions =
  | RegisterDynamoDbPluginsOptionsBuilder
  | Partial<RegisterDynamoDbPluginsOptionsType>;
/** Value alias so `RegisterDynamoDbPluginsOptions.create()` resolves to the builder. */
export const RegisterDynamoDbPluginsOptions = RegisterDynamoDbPluginsOptionsBuilder;

/**
 * Read the DynamoDB journal's block — `actor-ts.persistence.journal.dynamodb`
 * by default, or whichever id the plug-in was registered under (#872).
 *
 * Placed beside the plug-in's own options for the reason
 * `PostgresPluginOptions.ts` places its readers the same way: the *plug-in* is
 * what reads configuration, so a store constructed directly stays
 * constructor-only.
 *
 * `operations` and `serializer` are absent by construction — live objects have
 * no HOCON spelling.  `clientConfig` is absent as free-form driver config with
 * no enumerable leaf set, which is also where credentials live: omitted, the
 * SDK's own default chain supplies them, so a config file never has to.
 *
 * The provisioning half — `billingMode`, `provisionedThroughput`,
 * `tableReadyTimeoutMs`, `autoCreateTables` — has no leaf **yet**, not by
 * construction: it is table-creation policy rather than reachability, and the
 * block's job here is to make a configured store connect and address the right
 * table.
 */
export function readDynamoDbJournalOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.journal.dynamodb.root,
): Partial<DynamoDbJournalOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.journal.dynamodb;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: { -readonly [K in keyof DynamoDbJournalOptionsType]?: DynamoDbJournalOptionsType[K] } = {};
  const region = readStoreString(config, at(keys.region));
  if (region !== undefined) out.region = region;
  const endpoint = readStoreString(config, at(keys.endpoint));
  if (endpoint !== undefined) out.endpoint = endpoint;
  const eventsTable = readStoreIdentifier(config, at(keys.eventsTable));
  if (eventsTable !== undefined) out.eventsTable = eventsTable;
  return out;
}

/** Read the DynamoDB snapshot store's block — see {@link readDynamoDbJournalOptionsFromConfig}. */
export function readDynamoDbSnapshotStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.snapshotStore.dynamodb.root,
): Partial<DynamoDbSnapshotStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.snapshotStore.dynamodb;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof DynamoDbSnapshotStoreOptionsType]?: DynamoDbSnapshotStoreOptionsType[K]
  } = {};
  const region = readStoreString(config, at(keys.region));
  if (region !== undefined) out.region = region;
  const endpoint = readStoreString(config, at(keys.endpoint));
  if (endpoint !== undefined) out.endpoint = endpoint;
  const snapshotsTable = readStoreIdentifier(config, at(keys.snapshotsTable));
  if (snapshotsTable !== undefined) out.snapshotsTable = snapshotsTable;
  const keepN = readStoreInt(config, at(keys.keepN));
  if (keepN !== undefined) out.keepN = keepN;
  return out;
}

/** Read the DynamoDB durable-state store's block — see {@link readDynamoDbJournalOptionsFromConfig}. */
export function readDynamoDbDurableStateStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.durableState.dynamodb.root,
): Partial<DynamoDbDurableStateStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.durableState.dynamodb;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof DynamoDbDurableStateStoreOptionsType]?: DynamoDbDurableStateStoreOptionsType[K]
  } = {};
  const region = readStoreString(config, at(keys.region));
  if (region !== undefined) out.region = region;
  const endpoint = readStoreString(config, at(keys.endpoint));
  if (endpoint !== undefined) out.endpoint = endpoint;
  const table = readStoreIdentifier(config, at(keys.table));
  if (table !== undefined) out.table = table;
  return out;
}
