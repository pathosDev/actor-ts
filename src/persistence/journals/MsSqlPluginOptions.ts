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
import type { MsSqlPoolLike } from './MsSqlClient.js';
import type { MsSqlJournalOptions, MsSqlJournalOptionsType } from './MsSqlJournalOptions.js';
import type {
  MsSqlSnapshotStoreOptions,
  MsSqlSnapshotStoreOptionsType,
} from '../snapshot-stores/MsSqlSnapshotStoreOptions.js';
import type {
  MsSqlDurableStateStoreOptions,
  MsSqlDurableStateStoreOptionsType,
} from '../durable-state-stores/MsSqlDurableStateStoreOptions.js';

export type RegisterMsSqlPluginsOptionsType = {
  /**
   * Shared connection pool injected into all three stores.  When provided, the
   * journal + snapshot + durable-state stores reuse ONE pool (the usual case —
   * they target the same database).  When omitted, each store lazily builds its
   * own pool from its `url` / `poolConfig`.
   */
  readonly pool?: MsSqlPoolLike;
  /** Connection string applied to every store that does not set its own. */
  readonly url?: string;
  /** `mssql` config object applied to every store that does not set its own. */
  readonly poolConfig?: Record<string, unknown>;
  /** Shared payload serializer applied to every store that does not set its own. */
  readonly serializer?: Serializer;
  /** Journal-specific options (table names, autoCreate). */
  readonly journal?: MsSqlJournalOptions;
  /** Snapshot-store-specific options (table name, keepN). */
  readonly snapshotStore?: MsSqlSnapshotStoreOptions;
  /** Durable-state-store-specific options (table name). */
  readonly durableStateStore?: MsSqlDurableStateStoreOptions;
};

/**
 * Fluent builder for {@link RegisterMsSqlPluginsOptionsType}:
 *
 *     const pluginOptions = RegisterMsSqlPluginsOptions.create()
 *       .withPoolConfig({ server: 'localhost', database: 'app', user: 'sa', password: '…' })
 *       .withSnapshotStore(MsSqlSnapshotStoreOptions.create().withKeepN(5));
 *     const handles = registerMsSqlPlugins(persistence, pluginOptions);
 *
 * The shared connection fields are merged onto each store's options by
 * `registerMsSqlPlugins`, so a leaf carries only its store-specific fields.
 * Each leaf setter accepts EITHER the leaf builder OR a plain object.
 */
export class RegisterMsSqlPluginsOptionsBuilder extends OptionsBuilder<RegisterMsSqlPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterMsSqlPluginsOptionsBuilder()`. */
  static create(): RegisterMsSqlPluginsOptionsBuilder {
    return new RegisterMsSqlPluginsOptionsBuilder();
  }

  /** Shared connection pool injected into all three stores. */
  withPool(pool: MsSqlPoolLike): this {
    return this.set('pool', pool);
  }

  /** Connection string applied to every store that does not set its own. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** `mssql` config object applied to every store that does not set its own. */
  withPoolConfig(poolConfig: Record<string, unknown>): this {
    return this.set('poolConfig', poolConfig);
  }

  /** Shared payload serializer applied to every store that does not set its own. */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer', serializer);
  }

  /** Journal-specific options (table names, autoCreate). */
  withJournal(journal: MsSqlJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options (table name, keepN). */
  withSnapshotStore(snapshotStore: MsSqlSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options (table name). */
  withDurableStateStore(durableStateStore: MsSqlDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for `registerMsSqlPlugins`: the fluent
 * {@link RegisterMsSqlPluginsOptionsBuilder} OR a plain
 * {@link RegisterMsSqlPluginsOptionsType} object.
 */
export type RegisterMsSqlPluginsOptions =
  | RegisterMsSqlPluginsOptionsBuilder
  | Partial<RegisterMsSqlPluginsOptionsType>;
/** Value alias so `RegisterMsSqlPluginsOptions.create()` resolves to the builder. */
export const RegisterMsSqlPluginsOptions = RegisterMsSqlPluginsOptionsBuilder;

/**
 * Read the SQL Server journal's block — `actor-ts.persistence.journal.mssql` by
 * default, or whichever id the plug-in was registered under (#872).  Same shape
 * and same reasoning as `readPostgresJournalOptionsFromConfig`.
 *
 * `poolConfig` has no leaf, which matters more here than for the other
 * backends: `buildMsSqlPool` needs `poolConfig`, `url` or a pre-built pool, so
 * a purely config-driven SQL Server store is reached through `url` — the
 * `Server=…;Database=…` form or the `mssql://` one, both of which this leaf
 * accepts.
 */
export function readMsSqlJournalOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.journal.mssql.root,
): Partial<MsSqlJournalOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.journal.mssql;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: { -readonly [K in keyof MsSqlJournalOptionsType]?: MsSqlJournalOptionsType[K] } = {};
  const url = readStoreString(config, at(keys.url));
  if (url !== undefined) out.url = url;
  const eventsTable = readStoreIdentifier(config, at(keys.eventsTable));
  if (eventsTable !== undefined) out.eventsTable = eventsTable;
  const tagsTable = readStoreIdentifier(config, at(keys.tagsTable));
  if (tagsTable !== undefined) out.tagsTable = tagsTable;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}

/** Read the SQL Server snapshot store's block — see {@link readMsSqlJournalOptionsFromConfig}. */
export function readMsSqlSnapshotStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.snapshotStore.mssql.root,
): Partial<MsSqlSnapshotStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.snapshotStore.mssql;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof MsSqlSnapshotStoreOptionsType]?: MsSqlSnapshotStoreOptionsType[K]
  } = {};
  const url = readStoreString(config, at(keys.url));
  if (url !== undefined) out.url = url;
  const snapshotsTable = readStoreIdentifier(config, at(keys.snapshotsTable));
  if (snapshotsTable !== undefined) out.snapshotsTable = snapshotsTable;
  const keepN = readStoreInt(config, at(keys.keepN));
  if (keepN !== undefined) out.keepN = keepN;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}

/** Read the SQL Server durable-state store's block — see {@link readMsSqlJournalOptionsFromConfig}. */
export function readMsSqlDurableStateStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.durableState.mssql.root,
): Partial<MsSqlDurableStateStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.durableState.mssql;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof MsSqlDurableStateStoreOptionsType]?: MsSqlDurableStateStoreOptionsType[K]
  } = {};
  const url = readStoreString(config, at(keys.url));
  if (url !== undefined) out.url = url;
  const table = readStoreIdentifier(config, at(keys.table));
  if (table !== undefined) out.table = table;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}
