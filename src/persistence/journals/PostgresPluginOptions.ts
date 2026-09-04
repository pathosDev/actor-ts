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
import type { PgPoolLike } from './PostgresClient.js';
import type { PostgresJournalOptions, PostgresJournalOptionsType } from './PostgresJournalOptions.js';
import type {
  PostgresSnapshotStoreOptions,
  PostgresSnapshotStoreOptionsType,
} from '../snapshot-stores/PostgresSnapshotStoreOptions.js';
import type {
  PostgresDurableStateStoreOptions,
  PostgresDurableStateStoreOptionsType,
} from '../durable-state-stores/PostgresDurableStateStoreOptions.js';

export type RegisterPostgresPluginsOptionsType = {
  /**
   * Shared connection pool injected into all three stores.  When provided,
   * the journal + snapshot + durable-state stores reuse ONE pool (the
   * usual case — they target the same database).  When omitted, each store
   * lazily builds its own pool from its `url` / `poolConfig`.
   */
  readonly pool?: PgPoolLike;
  /** Shared payload serializer injected into all three stores (a leaf's own `serializer` wins). */
  readonly serializer?: Serializer;
  /** Journal-specific options (table names, autoCreate, and connection if no shared `pool`). */
  readonly journal?: PostgresJournalOptions;
  /** Snapshot-store-specific options. */
  readonly snapshotStore?: PostgresSnapshotStoreOptions;
  /** Durable-state-store-specific options.  Defaults to a fresh builder (uses the shared `pool`). */
  readonly durableStateStore?: PostgresDurableStateStoreOptions;
};

/**
 * Fluent builder for {@link RegisterPostgresPluginsOptionsType}:
 *
 *     registerPostgresPlugins(ext, RegisterPostgresPluginsOptions.create()
 *       .withPool(pool)
 *       .withJournal(PostgresJournalOptions.create().withEventsTable('journal'))
 *       .withSnapshotStore(PostgresSnapshotStoreOptions.create().withKeepN(5)))
 *
 * The shared `withPool(...)` is merged onto each store's resolved options
 * by {@link registerPostgresPlugins}, so a leaf builder carries only its
 * store-specific fields.  Each leaf setter accepts EITHER the leaf builder
 * OR a plain object of the leaf's options.
 */
export class RegisterPostgresPluginsOptionsBuilder extends OptionsBuilder<RegisterPostgresPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterPostgresPluginsOptionsBuilder()`. */
  static create(): RegisterPostgresPluginsOptionsBuilder {
    return new RegisterPostgresPluginsOptionsBuilder();
  }

  /** Shared connection pool injected into all three stores. */
  withPool(pool: PgPoolLike): this {
    return this.set('pool', pool);
  }

  /** Shared payload serializer injected into all three stores (a leaf's own `serializer` wins). */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer', serializer);
  }

  /** Journal-specific options (table names, autoCreate, and connection if no shared pool). */
  withJournal(journal: PostgresJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options. */
  withSnapshotStore(snapshotStore: PostgresSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options.  Defaults to a fresh builder (uses the shared pool). */
  withDurableStateStore(durableStateStore: PostgresDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for {@link registerPostgresPlugins}: the fluent
 * {@link RegisterPostgresPluginsOptionsBuilder} OR a plain
 * {@link RegisterPostgresPluginsOptionsType} object.
 */
export type RegisterPostgresPluginsOptions =
  | RegisterPostgresPluginsOptionsBuilder
  | Partial<RegisterPostgresPluginsOptionsType>;
/** Value alias so `RegisterPostgresPluginsOptions.create()` / `new RegisterPostgresPluginsOptions()` resolve to the builder. */
export const RegisterPostgresPluginsOptions = RegisterPostgresPluginsOptionsBuilder;

/**
 * Read the Postgres journal's block — `actor-ts.persistence.journal.postgres`
 * by default, or whichever id the plug-in was registered under (#872).
 *
 * The readers live here, beside the plug-in's own options, rather than in each
 * store's `XOptions.ts`, for the reason `SqlitePluginOptions.ts` and
 * `ObjectStoragePluginOptions.ts` place theirs the same way: the *plug-in* is
 * what reads configuration.  A store constructed directly stays
 * constructor-only, which is what keeps `new PostgresJournal({...})` a pure
 * function of its argument in a test.
 *
 * `pool` and `serializer` are absent by construction — they are live objects,
 * so a config file cannot express one and there is no leaf to forget to
 * filter.  `poolConfig` is absent for a different reason: it is a free-form
 * driver config with no enumerable leaf set and no default, so it stays
 * code-only rather than becoming a block whose contents nothing validates.
 */
export function readPostgresJournalOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.journal.postgres.root,
): Partial<PostgresJournalOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.journal.postgres;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: { -readonly [K in keyof PostgresJournalOptionsType]?: PostgresJournalOptionsType[K] } = {};
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

/** Read the Postgres snapshot store's block — see {@link readPostgresJournalOptionsFromConfig}. */
export function readPostgresSnapshotStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.snapshotStore.postgres.root,
): Partial<PostgresSnapshotStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.snapshotStore.postgres;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof PostgresSnapshotStoreOptionsType]?: PostgresSnapshotStoreOptionsType[K]
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

/** Read the Postgres durable-state store's block — see {@link readPostgresJournalOptionsFromConfig}. */
export function readPostgresDurableStateStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.durableState.postgres.root,
): Partial<PostgresDurableStateStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.durableState.postgres;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof PostgresDurableStateStoreOptionsType]?: PostgresDurableStateStoreOptionsType[K]
  } = {};
  const url = readStoreString(config, at(keys.url));
  if (url !== undefined) out.url = url;
  const table = readStoreIdentifier(config, at(keys.table));
  if (table !== undefined) out.table = table;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  return out;
}
