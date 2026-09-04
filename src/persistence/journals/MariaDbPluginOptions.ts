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
import type { MariaDbPoolLike } from './MariaDbClient.js';
import type { MariaDbJournalOptions, MariaDbJournalOptionsType } from './MariaDbJournalOptions.js';
import type {
  MariaDbSnapshotStoreOptions,
  MariaDbSnapshotStoreOptionsType,
} from '../snapshot-stores/MariaDbSnapshotStoreOptions.js';
import type {
  MariaDbDurableStateStoreOptions,
  MariaDbDurableStateStoreOptionsType,
} from '../durable-state-stores/MariaDbDurableStateStoreOptions.js';

export type RegisterMariaDbPluginsOptionsType = {
  /**
   * Shared connection pool injected into all three stores.  When provided,
   * the journal + snapshot + durable-state stores reuse ONE pool.  When
   * omitted, each store lazily builds its own from its `url` / `poolConfig`.
   */
  readonly pool?: MariaDbPoolLike;
  /** Shared payload serializer injected into all three stores (a leaf's own `serializer` wins). */
  readonly serializer?: Serializer;
  /** Journal builder — its `pool` is overridden by the shared `pool` when set. */
  readonly journal?: MariaDbJournalOptions;
  /** Snapshot-store builder — its `pool` is overridden by the shared `pool` when set. */
  readonly snapshotStore?: MariaDbSnapshotStoreOptions;
  /** Durable-state-store builder — its `pool` is overridden by the shared `pool` when set. */
  readonly durableStateStore?: MariaDbDurableStateStoreOptions;
};

/**
 * Fluent builder for {@link RegisterMariaDbPluginsOptionsType}:
 *
 *     registerMariaDbPlugins(ext, RegisterMariaDbPluginsOptions.create()
 *       .withPool(sharedPool)
 *       .withJournal(MariaDbJournalOptions.create().withEventsTable('journal')))
 *
 * Each per-store field is the store's own leaf builder (or a plain object
 * of its options); the shared `pool` (when set via `withPool`) is merged
 * onto every store's resolved options at registration time, so a leaf
 * need not repeat the connection.
 */
export class RegisterMariaDbPluginsOptionsBuilder extends OptionsBuilder<RegisterMariaDbPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterMariaDbPluginsOptionsBuilder()`. */
  static create(): RegisterMariaDbPluginsOptionsBuilder {
    return new RegisterMariaDbPluginsOptionsBuilder();
  }

  /** Shared connection pool reused by all three stores (overrides each leaf's own pool). */
  withPool(pool: MariaDbPoolLike): this {
    return this.set('pool', pool);
  }

  /** Shared payload serializer injected into all three stores (a leaf's own `serializer` wins). */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer', serializer);
  }

  /** Journal builder — table names / autoCreate (connection filled from the shared pool). */
  withJournal(journal: MariaDbJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store builder — table name / keepN (connection filled from the shared pool). */
  withSnapshotStore(snapshotStore: MariaDbSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store builder — table name (connection filled from the shared pool). */
  withDurableStateStore(durableStateStore: MariaDbDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for {@link registerMariaDbPlugins}: the fluent
 * {@link RegisterMariaDbPluginsOptionsBuilder} OR a plain
 * {@link RegisterMariaDbPluginsOptionsType} object.
 */
export type RegisterMariaDbPluginsOptions =
  | RegisterMariaDbPluginsOptionsBuilder
  | Partial<RegisterMariaDbPluginsOptionsType>;
/** Value alias so `RegisterMariaDbPluginsOptions.create()` / `new RegisterMariaDbPluginsOptions()` resolve to the builder. */
export const RegisterMariaDbPluginsOptions = RegisterMariaDbPluginsOptionsBuilder;

/**
 * Read the MariaDB journal's block — `actor-ts.persistence.journal.mariadb` by
 * default, or whichever id the plug-in was registered under (#872).  Same shape
 * and same reasoning as `readPostgresJournalOptionsFromConfig`.
 */
export function readMariaDbJournalOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.journal.mariadb.root,
): Partial<MariaDbJournalOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.journal.mariadb;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: { -readonly [K in keyof MariaDbJournalOptionsType]?: MariaDbJournalOptionsType[K] } = {};
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

/** Read the MariaDB snapshot store's block — see {@link readMariaDbJournalOptionsFromConfig}. */
export function readMariaDbSnapshotStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.snapshotStore.mariadb.root,
): Partial<MariaDbSnapshotStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.snapshotStore.mariadb;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof MariaDbSnapshotStoreOptionsType]?: MariaDbSnapshotStoreOptionsType[K]
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

/** Read the MariaDB durable-state store's block — see {@link readMariaDbJournalOptionsFromConfig}. */
export function readMariaDbDurableStateStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.durableState.mariadb.root,
): Partial<MariaDbDurableStateStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.durableState.mariadb;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof MariaDbDurableStateStoreOptionsType]?: MariaDbDurableStateStoreOptionsType[K]
  } = {};
  const url = readStoreString(config, at(keys.url));
  if (url !== undefined) out.url = url;
  const table = readStoreIdentifier(config, at(keys.table));
  if (table !== undefined) out.table = table;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}
