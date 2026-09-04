import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Serializer } from '../../serialization/Serializer.js';
import {
  readStoreBoolean,
  readStoreIdentifier,
  readStoreInt,
  readStoreString,
  storeLeaf,
} from '../StoreConfig.js';
import type { D1ClientLike } from './D1Client.js';
import type { D1JournalOptions, D1JournalOptionsType } from './D1JournalOptions.js';
import type {
  D1SnapshotStoreOptions,
  D1SnapshotStoreOptionsType,
} from '../snapshot-stores/D1SnapshotStoreOptions.js';
import type {
  D1DurableStateStoreOptions,
  D1DurableStateStoreOptionsType,
} from '../durable-state-stores/D1DurableStateStoreOptions.js';

export type RegisterD1PluginsOptionsType = {
  /**
   * Shared transport injected into all three stores — the usual case, since they
   * address the same database and `fetch` pools connections underneath.
   */
  readonly client?: D1ClientLike;
  /** Cloudflare account id applied to every store that does not set its own. */
  readonly accountId?: string;
  /** D1 database id applied to every store that does not set its own. */
  readonly databaseId?: string;
  /** API token applied to every store that does not set its own. */
  readonly apiToken?: string;
  /** API base URL applied to every store that does not set its own. */
  readonly baseUrl?: string;
  /** Shared payload serializer applied to every store that does not set its own. */
  readonly serializer?: Serializer;
  /** Journal-specific options (table names, autoCreate). */
  readonly journal?: D1JournalOptions;
  /** Snapshot-store-specific options (table name, keepN). */
  readonly snapshotStore?: D1SnapshotStoreOptions;
  /** Durable-state-store-specific options (table name). */
  readonly durableStateStore?: D1DurableStateStoreOptions;
};

/**
 * Fluent builder for {@link RegisterD1PluginsOptionsType}:
 *
 *     const pluginOptions = RegisterD1PluginsOptions.create()
 *       .withAccountId(process.env.CLOUDFLARE_ACCOUNT_ID)
 *       .withDatabaseId(process.env.D1_DATABASE_ID)
 *       .withApiToken(process.env.CLOUDFLARE_API_TOKEN);
 *     const handles = registerD1Plugins(persistence, pluginOptions);
 *
 * The shared connection fields are merged onto each store's options by
 * `registerD1Plugins`, so a leaf carries only its store-specific fields.
 */
export class RegisterD1PluginsOptionsBuilder extends OptionsBuilder<RegisterD1PluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterD1PluginsOptionsBuilder()`. */
  static create(): RegisterD1PluginsOptionsBuilder {
    return new RegisterD1PluginsOptionsBuilder();
  }

  /** Shared transport injected into all three stores. */
  withClient(client: D1ClientLike): this {
    return this.set('client', client);
  }

  /** Shared payload serializer applied to every store that does not set its own. */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer', serializer);
  }

  /** Cloudflare account id applied to every store that does not set its own. */
  withAccountId(accountId: string): this {
    return this.set('accountId', accountId);
  }

  /** D1 database id applied to every store that does not set its own. */
  withDatabaseId(databaseId: string): this {
    return this.set('databaseId', databaseId);
  }

  /** API token applied to every store that does not set its own. */
  withApiToken(apiToken: string): this {
    return this.set('apiToken', apiToken);
  }

  /** API base URL applied to every store that does not set its own. */
  withBaseUrl(baseUrl: string): this {
    return this.set('baseUrl', baseUrl);
  }

  /** Journal-specific options (table names, autoCreate). */
  withJournal(journal: D1JournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options (table name, keepN). */
  withSnapshotStore(snapshotStore: D1SnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options (table name). */
  withDurableStateStore(durableStateStore: D1DurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for `registerD1Plugins`: the fluent
 * {@link RegisterD1PluginsOptionsBuilder} OR a plain
 * {@link RegisterD1PluginsOptionsType} object.
 */
export type RegisterD1PluginsOptions =
  | RegisterD1PluginsOptionsBuilder
  | Partial<RegisterD1PluginsOptionsType>;
/** Value alias so `RegisterD1PluginsOptions.create()` resolves to the builder. */
export const RegisterD1PluginsOptions = RegisterD1PluginsOptionsBuilder;

/**
 * Read the Cloudflare D1 journal's block —
 * `actor-ts.persistence.journal.cloudflare-d1` by default, or whichever id the
 * plug-in was registered under (#872).  Same shape and same reasoning as
 * `readPostgresJournalOptionsFromConfig`.
 *
 * D1 is reached by three coordinates rather than a URL, and `api-token` is a
 * credential with a leaf for the reason libSQL's `auth-token` has one: it is a
 * *string* the operator supplies, the leaf ships empty, and the documented
 * route is `api-token = ${?CLOUDFLARE_API_TOKEN}`.  `""` reads as unset, so the
 * placeholder never becomes a bearer token.
 *
 * `timeout` and `max-response-bytes` have no leaf yet — they are transport
 * tuning rather than reachability, and the block is already the widest of the
 * five.
 */
export function readD1JournalOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.journal.cloudflareD1.root,
): Partial<D1JournalOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.journal.cloudflareD1;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: { -readonly [K in keyof D1JournalOptionsType]?: D1JournalOptionsType[K] } = {};
  const accountId = readStoreString(config, at(keys.accountId));
  if (accountId !== undefined) out.accountId = accountId;
  const databaseId = readStoreString(config, at(keys.databaseId));
  if (databaseId !== undefined) out.databaseId = databaseId;
  const apiToken = readStoreString(config, at(keys.apiToken));
  if (apiToken !== undefined) out.apiToken = apiToken;
  const baseUrl = readStoreString(config, at(keys.baseUrl));
  if (baseUrl !== undefined) out.baseUrl = baseUrl;
  const eventsTable = readStoreIdentifier(config, at(keys.eventsTable));
  if (eventsTable !== undefined) out.eventsTable = eventsTable;
  const tagsTable = readStoreIdentifier(config, at(keys.tagsTable));
  if (tagsTable !== undefined) out.tagsTable = tagsTable;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}

/** Read the D1 snapshot store's block — see {@link readD1JournalOptionsFromConfig}. */
export function readD1SnapshotStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.snapshotStore.cloudflareD1.root,
): Partial<D1SnapshotStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.snapshotStore.cloudflareD1;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof D1SnapshotStoreOptionsType]?: D1SnapshotStoreOptionsType[K]
  } = {};
  const accountId = readStoreString(config, at(keys.accountId));
  if (accountId !== undefined) out.accountId = accountId;
  const databaseId = readStoreString(config, at(keys.databaseId));
  if (databaseId !== undefined) out.databaseId = databaseId;
  const apiToken = readStoreString(config, at(keys.apiToken));
  if (apiToken !== undefined) out.apiToken = apiToken;
  const baseUrl = readStoreString(config, at(keys.baseUrl));
  if (baseUrl !== undefined) out.baseUrl = baseUrl;
  const snapshotsTable = readStoreIdentifier(config, at(keys.snapshotsTable));
  if (snapshotsTable !== undefined) out.snapshotsTable = snapshotsTable;
  const keepN = readStoreInt(config, at(keys.keepN));
  if (keepN !== undefined) out.keepN = keepN;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}

/** Read the D1 durable-state store's block — see {@link readD1JournalOptionsFromConfig}. */
export function readD1DurableStateStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.durableState.cloudflareD1.root,
): Partial<D1DurableStateStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.durableState.cloudflareD1;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof D1DurableStateStoreOptionsType]?: D1DurableStateStoreOptionsType[K]
  } = {};
  const accountId = readStoreString(config, at(keys.accountId));
  if (accountId !== undefined) out.accountId = accountId;
  const databaseId = readStoreString(config, at(keys.databaseId));
  if (databaseId !== undefined) out.databaseId = databaseId;
  const apiToken = readStoreString(config, at(keys.apiToken));
  if (apiToken !== undefined) out.apiToken = apiToken;
  const baseUrl = readStoreString(config, at(keys.baseUrl));
  if (baseUrl !== undefined) out.baseUrl = baseUrl;
  const table = readStoreIdentifier(config, at(keys.table));
  if (table !== undefined) out.table = table;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}
