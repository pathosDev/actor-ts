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
import type { LibSqlClientLike } from './LibSqlClient.js';
import type { LibSqlJournalOptions, LibSqlJournalOptionsType } from './LibSqlJournalOptions.js';
import type {
  LibSqlSnapshotStoreOptions,
  LibSqlSnapshotStoreOptionsType,
} from '../snapshot-stores/LibSqlSnapshotStoreOptions.js';
import type {
  LibSqlDurableStateStoreOptions,
  LibSqlDurableStateStoreOptionsType,
} from '../durable-state-stores/LibSqlDurableStateStoreOptions.js';

export type RegisterLibSqlPluginsOptionsType = {
  /**
   * Shared client injected into all three stores — the usual case, since they
   * target the same database and a libSQL client is a connection *pool* in its
   * own right.  When omitted, each store lazily builds its own client from its
   * `url` / `authToken`.
   */
  readonly client?: LibSqlClientLike;
  /**
   * Database URL applied to every store that does not set its own.  Saves
   * repeating the connection three times when no shared `client` is passed.
   */
  readonly url?: string;
  /** Auth token applied to every store that does not set its own. */
  readonly authToken?: string;
  /** Shared payload serializer applied to every store that does not set its own. */
  readonly serializer?: Serializer;
  /** Journal-specific options (table names, autoCreate). */
  readonly journal?: LibSqlJournalOptions;
  /** Snapshot-store-specific options (table name, keepN). */
  readonly snapshotStore?: LibSqlSnapshotStoreOptions;
  /** Durable-state-store-specific options (table name). */
  readonly durableStateStore?: LibSqlDurableStateStoreOptions;
};

/**
 * Fluent builder for {@link RegisterLibSqlPluginsOptionsType}:
 *
 *     const pluginOptions = RegisterLibSqlPluginsOptions.create()
 *       .withUrl('libsql://my-db.turso.io')
 *       .withAuthToken(process.env.TURSO_AUTH_TOKEN)
 *       .withSnapshotStore(LibSqlSnapshotStoreOptions.create().withKeepN(5));
 *     const handles = registerLibSqlPlugins(persistence, pluginOptions);
 *
 * The shared connection fields are merged onto each store's options by
 * `registerLibSqlPlugins`, so a leaf carries only its store-specific fields.
 * Each leaf setter accepts EITHER the leaf builder OR a plain object.
 */
export class RegisterLibSqlPluginsOptionsBuilder extends OptionsBuilder<RegisterLibSqlPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterLibSqlPluginsOptionsBuilder()`. */
  static create(): RegisterLibSqlPluginsOptionsBuilder {
    return new RegisterLibSqlPluginsOptionsBuilder();
  }

  /** Shared client injected into all three stores. */
  withClient(client: LibSqlClientLike): this {
    return this.set('client', client);
  }

  /** Database URL applied to every store that does not set its own. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Auth token applied to every store that does not set its own. */
  withAuthToken(authToken: string): this {
    return this.set('authToken', authToken);
  }

  /** Shared payload serializer applied to every store that does not set its own. */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer', serializer);
  }

  /** Journal-specific options (table names, autoCreate). */
  withJournal(journal: LibSqlJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options (table name, keepN). */
  withSnapshotStore(snapshotStore: LibSqlSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options (table name). */
  withDurableStateStore(durableStateStore: LibSqlDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for `registerLibSqlPlugins`: the fluent
 * {@link RegisterLibSqlPluginsOptionsBuilder} OR a plain
 * {@link RegisterLibSqlPluginsOptionsType} object.
 */
export type RegisterLibSqlPluginsOptions =
  | RegisterLibSqlPluginsOptionsBuilder
  | Partial<RegisterLibSqlPluginsOptionsType>;
/** Value alias so `RegisterLibSqlPluginsOptions.create()` resolves to the builder. */
export const RegisterLibSqlPluginsOptions = RegisterLibSqlPluginsOptionsBuilder;

/**
 * Read the libSQL journal's block — `actor-ts.persistence.journal.libsql` by
 * default, or whichever id the plug-in was registered under (#872).  Same shape
 * and same reasoning as `readPostgresJournalOptionsFromConfig`.
 *
 * `auth-token` is a credential with a leaf, unlike the pre-built `client`,
 * because a token is a *string* an operator has to supply from somewhere: the
 * leaf ships empty and the documented route is a substitution
 * (`auth-token = ${?TURSO_AUTH_TOKEN}`), which is the same treatment
 * `logger.sinks.splunk.token` and `cache.redis.password` already get.  `""`
 * reads as unset, so the published placeholder never reaches `createClient`.
 */
export function readLibSqlJournalOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.journal.libsql.root,
): Partial<LibSqlJournalOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.journal.libsql;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: { -readonly [K in keyof LibSqlJournalOptionsType]?: LibSqlJournalOptionsType[K] } = {};
  const url = readStoreString(config, at(keys.url));
  if (url !== undefined) out.url = url;
  const authToken = readStoreString(config, at(keys.authToken));
  if (authToken !== undefined) out.authToken = authToken;
  const eventsTable = readStoreIdentifier(config, at(keys.eventsTable));
  if (eventsTable !== undefined) out.eventsTable = eventsTable;
  const tagsTable = readStoreIdentifier(config, at(keys.tagsTable));
  if (tagsTable !== undefined) out.tagsTable = tagsTable;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}

/** Read the libSQL snapshot store's block — see {@link readLibSqlJournalOptionsFromConfig}. */
export function readLibSqlSnapshotStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.snapshotStore.libsql.root,
): Partial<LibSqlSnapshotStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.snapshotStore.libsql;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof LibSqlSnapshotStoreOptionsType]?: LibSqlSnapshotStoreOptionsType[K]
  } = {};
  const url = readStoreString(config, at(keys.url));
  if (url !== undefined) out.url = url;
  const authToken = readStoreString(config, at(keys.authToken));
  if (authToken !== undefined) out.authToken = authToken;
  const snapshotsTable = readStoreIdentifier(config, at(keys.snapshotsTable));
  if (snapshotsTable !== undefined) out.snapshotsTable = snapshotsTable;
  const keepN = readStoreInt(config, at(keys.keepN));
  if (keepN !== undefined) out.keepN = keepN;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}

/** Read the libSQL durable-state store's block — see {@link readLibSqlJournalOptionsFromConfig}. */
export function readLibSqlDurableStateStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.durableState.libsql.root,
): Partial<LibSqlDurableStateStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.durableState.libsql;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof LibSqlDurableStateStoreOptionsType]?: LibSqlDurableStateStoreOptionsType[K]
  } = {};
  const url = readStoreString(config, at(keys.url));
  if (url !== undefined) out.url = url;
  const authToken = readStoreString(config, at(keys.authToken));
  if (authToken !== undefined) out.authToken = authToken;
  const table = readStoreIdentifier(config, at(keys.table));
  if (table !== undefined) out.table = table;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}
