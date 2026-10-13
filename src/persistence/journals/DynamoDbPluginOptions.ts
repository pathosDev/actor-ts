import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Serializer } from '../../serialization/Serializer.js';
import {
  readStoreBoolean,
  readStoreDuration,
  readStoreEnum,
  readStoreIdentifier,
  readStoreInt,
  readStoreString,
  storeLeaf,
} from '../StoreConfig.js';
import type { DynamoDbOperations } from './DynamoDbClient.js';
import type { DynamoDbTableProvisioning } from './DynamoDbOptionsBase.js';
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
 * The `billing-mode` leaf's values — kebab-case, as every HOCON value is —
 * each mapped to the spelling `CreateTable` takes and `billingMode` holds.
 * The table is the reader's whole vocabulary: `PAY_PER_REQUEST` written in a
 * config file is refused with the key and these two words rather than read
 * verbatim (#1490).  `DocumentedDefaults.test.ts` pins the published value
 * through it to `DEFAULT_DYNAMODB_BILLING_MODE`, which keeps AWS's spelling
 * because it reaches the SDK as it is.
 */
export const DYNAMODB_BILLING_MODES = {
  'pay-per-request': 'PAY_PER_REQUEST',
  provisioned: 'PROVISIONED',
} as const satisfies Readonly<Record<string, NonNullable<DynamoDbTableProvisioning['billingMode']>>>;

/**
 * The five `ConfigKeys` paths the provisioning half is read through, named so
 * the one helper below serves all three roots.
 */
type DynamoDbProvisioningKeys = {
  readonly billingMode: string;
  readonly provisionedThroughputReadCapacityUnits: string;
  readonly provisionedThroughputWriteCapacityUnits: string;
  readonly tableReadyTimeout: string;
  readonly autoCreateTables: string;
};

/**
 * The provisioning half all three DynamoDB readers share — how a table the
 * store creates on first use is created (#1490).  `DynamoDbTableProvisioning`
 * is part of every DynamoDB option family, so the same leaves sit under each
 * root, and one helper keeps the three from drifting apart.
 *
 * The capacity pair is two integer leaves assembled here, and it ships as a
 * comment: published, it would be refused for every store under the default
 * `pay-per-request` mode, because `DynamoDbOptionsValidatorBase` refuses a
 * pair the mode would ignore — AWS ignores it silently.  A `provisioned` table
 * with no pair is created at 5 read and 5 write capacity units
 * (`DEFAULT_DYNAMODB_PROVISIONED_CAPACITY_UNITS`).  A pair with one half set
 * is passed on as the half it is, never completed with a default: the
 * validator then names the missing half, and the missing half is the mistake.
 */
function readDynamoDbProvisioningFromConfig(
  config: Config,
  at: (canonicalLeafPath: string) => string,
  keys: DynamoDbProvisioningKeys,
): Partial<DynamoDbTableProvisioning> {
  const out: { -readonly [K in keyof DynamoDbTableProvisioning]?: DynamoDbTableProvisioning[K] } = {};
  const billingMode = readStoreEnum(config, at(keys.billingMode), DYNAMODB_BILLING_MODES);
  if (billingMode !== undefined) out.billingMode = billingMode;
  const readCapacityUnits = readStoreInt(config, at(keys.provisionedThroughputReadCapacityUnits));
  const writeCapacityUnits = readStoreInt(config, at(keys.provisionedThroughputWriteCapacityUnits));
  if (readCapacityUnits !== undefined || writeCapacityUnits !== undefined) {
    const pair: { readCapacityUnits?: number; writeCapacityUnits?: number } = {};
    if (readCapacityUnits !== undefined) pair.readCapacityUnits = readCapacityUnits;
    if (writeCapacityUnits !== undefined) pair.writeCapacityUnits = writeCapacityUnits;
    // Typed as the whole pair the field declares, a half one included: the
    // validator is written over that case and names the absent half.
    out.provisionedThroughput = pair as NonNullable<DynamoDbTableProvisioning['provisionedThroughput']>;
  }
  const tableReadyTimeoutMs = readStoreDuration(config, at(keys.tableReadyTimeout));
  if (tableReadyTimeoutMs !== undefined) out.tableReadyTimeoutMs = tableReadyTimeoutMs;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}

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
 * The provisioning half — `billing-mode`, `table-ready-timeout`,
 * `auto-create-tables` and the comment-only `provisioned-throughput` pair — is
 * read by {@link readDynamoDbProvisioningFromConfig}, under all three roots.
 */
export function readDynamoDbJournalOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.journal.dynamodb.root,
): Partial<DynamoDbJournalOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.journal.dynamodb;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: { -readonly [K in keyof DynamoDbJournalOptionsType]?: DynamoDbJournalOptionsType[K] } = {
    ...readDynamoDbProvisioningFromConfig(config, at, keys),
  };
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
  } = { ...readDynamoDbProvisioningFromConfig(config, at, keys) };
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
  } = { ...readDynamoDbProvisioningFromConfig(config, at, keys) };
  const region = readStoreString(config, at(keys.region));
  if (region !== undefined) out.region = region;
  const endpoint = readStoreString(config, at(keys.endpoint));
  if (endpoint !== undefined) out.endpoint = endpoint;
  const table = readStoreIdentifier(config, at(keys.table));
  if (table !== undefined) out.table = table;
  return out;
}
