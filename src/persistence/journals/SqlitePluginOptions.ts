import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Serializer } from '../../serialization/Serializer.js';
import type { SqliteDb } from '../../runtime/sqlite/index.js';
import {
  readStoreBoolean,
  readStoreDuration,
  readStoreIdentifier,
  readStoreInt,
  readStoreString,
  storeLeaf,
} from '../StoreConfig.js';
import type { SqliteJournalOptions, SqliteJournalOptionsType } from './SqliteJournalOptions.js';
import type {
  SqliteSnapshotStoreOptions,
  SqliteSnapshotStoreOptionsType,
} from '../snapshot-stores/SqliteSnapshotStoreOptions.js';
import type {
  SqliteDurableStateStoreOptions,
  SqliteDurableStateStoreOptionsType,
} from '../durable-state-stores/SqliteDurableStateStoreOptions.js';

export type RegisterSqlitePluginsOptionsType = {
  /**
   * Database file (or `':memory:'`) shared by all three stores.  A leaf that
   * names its own `path` keeps it — this is the convenience of not repeating
   * one path three times, not an override.
   *
   * Shared *by value*, not by handle: each store opens the file itself, which
   * is what SQLite's own locking is for.  To share one connection instead,
   * pass {@link database}.
   */
  readonly path?: string;
  /**
   * Pre-opened database injected into all three stores — one handle, one
   * connection, no cross-process lock contention between them.  Overrides a
   * leaf's own `database`, exactly as a shared pool does in the other
   * relational plug-ins, and with the same ownership rule: nothing here closes
   * a handle it did not open.
   *
   * Code-only.  A live object has no HOCON spelling, so no leaf reaches it.
   */
  readonly database?: SqliteDb;
  /** Shared payload serializer injected into all three stores (a leaf's own `serializer` wins). */
  readonly serializer?: Serializer;
  /** Journal-specific options — `path`, `eventsTable`, `wal`, `busyTimeoutMs`. */
  readonly journal?: SqliteJournalOptions;
  /** Snapshot-store-specific options — `path`, `snapshotsTable`, `keepN`, `busyTimeoutMs`. */
  readonly snapshotStore?: SqliteSnapshotStoreOptions;
  /** Durable-state-store-specific options — `path`, `table`, `autoCreateTables`. */
  readonly durableStateStore?: SqliteDurableStateStoreOptions;
};

/**
 * Fluent builder for {@link RegisterSqlitePluginsOptionsType}:
 *
 *     const sqliteOptions = RegisterSqlitePluginsOptions.create()
 *       .withPath('./app.db')
 *       .withSnapshotStore(SqliteSnapshotStoreOptions.create().withKeepN(5));
 *     registerSqlitePlugins(ext, sqliteOptions);
 *
 * The shared `withPath(...)` / `withDatabase(...)` are folded into each
 * store's resolved options by `registerSqlitePlugins`, so a leaf builder
 * carries only its store-specific fields.  Each leaf setter accepts EITHER the
 * leaf builder OR a plain object of that leaf's options.
 */
export class RegisterSqlitePluginsOptionsBuilder extends OptionsBuilder<RegisterSqlitePluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterSqlitePluginsOptionsBuilder()`. */
  static create(): RegisterSqlitePluginsOptionsBuilder {
    return new RegisterSqlitePluginsOptionsBuilder();
  }

  /** Database file (or `':memory:'`) shared by all three stores. */
  withPath(path: string): this {
    return this.set('path', path);
  }

  /** Pre-opened database shared by all three stores — one handle, one connection. */
  withDatabase(database: SqliteDb): this {
    return this.set('database', database);
  }

  /** Shared payload serializer injected into all three stores (a leaf's own `serializer` wins). */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer', serializer);
  }

  /** Journal-specific options. */
  withJournal(journal: SqliteJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options. */
  withSnapshotStore(snapshotStore: SqliteSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options. */
  withDurableStateStore(durableStateStore: SqliteDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for `registerSqlitePlugins`: the fluent
 * {@link RegisterSqlitePluginsOptionsBuilder} OR a plain
 * {@link RegisterSqlitePluginsOptionsType} object.
 */
export type RegisterSqlitePluginsOptions =
  | RegisterSqlitePluginsOptionsBuilder
  | Partial<RegisterSqlitePluginsOptionsType>;
/** Value alias so `RegisterSqlitePluginsOptions.create()` / `new RegisterSqlitePluginsOptions()` resolve to the builder. */
export const RegisterSqlitePluginsOptions = RegisterSqlitePluginsOptionsBuilder;

/**
 * Read the SQLite journal's block — `actor-ts.persistence.journal.sqlite` by
 * default, or whichever id the plug-in was registered under.
 *
 * The readers live here, beside the plug-in's own options, and not in each
 * store's `XOptions.ts`, for the reason `ObjectStoragePluginOptions.ts` places
 * `readObjectStoragePluginOptionsFromConfig` the same way: the *plug-in* is
 * what reads configuration.  A store constructed directly stays
 * constructor-only, which is what keeps `new SqliteJournal({...})` a pure
 * function of its argument in a test.
 *
 * `driver` and `database` are absent by construction — they are live objects,
 * so a config file cannot express one, and there is no leaf to forget to
 * filter.
 */
export function readSqliteJournalOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.journal.sqlite.root,
): Partial<SqliteJournalOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.journal.sqlite;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: { -readonly [K in keyof SqliteJournalOptionsType]?: SqliteJournalOptionsType[K] } = {};
  const path = readStoreString(config, at(keys.path));
  if (path !== undefined) out.path = path;
  const eventsTable = readStoreIdentifier(config, at(keys.eventsTable));
  if (eventsTable !== undefined) out.eventsTable = eventsTable;
  const wal = readStoreBoolean(config, at(keys.wal));
  if (wal !== undefined) out.wal = wal;
  const busyTimeoutMs = readStoreDuration(config, at(keys.busyTimeout));
  if (busyTimeoutMs !== undefined) out.busyTimeoutMs = busyTimeoutMs;
  return out;
}

/** Read the SQLite snapshot store's block — see {@link readSqliteJournalOptionsFromConfig}. */
export function readSqliteSnapshotStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.snapshotStore.sqlite.root,
): Partial<SqliteSnapshotStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.snapshotStore.sqlite;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof SqliteSnapshotStoreOptionsType]?: SqliteSnapshotStoreOptionsType[K]
  } = {};
  const path = readStoreString(config, at(keys.path));
  if (path !== undefined) out.path = path;
  const snapshotsTable = readStoreIdentifier(config, at(keys.snapshotsTable));
  if (snapshotsTable !== undefined) out.snapshotsTable = snapshotsTable;
  const keepN = readStoreInt(config, at(keys.keepN));
  if (keepN !== undefined) out.keepN = keepN;
  const busyTimeoutMs = readStoreDuration(config, at(keys.busyTimeout));
  if (busyTimeoutMs !== undefined) out.busyTimeoutMs = busyTimeoutMs;
  return out;
}

/** Read the SQLite durable-state store's block — see {@link readSqliteJournalOptionsFromConfig}. */
export function readSqliteDurableStateStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.durableState.sqlite.root,
): Partial<SqliteDurableStateStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.durableState.sqlite;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof SqliteDurableStateStoreOptionsType]?: SqliteDurableStateStoreOptionsType[K]
  } = {};
  const path = readStoreString(config, at(keys.path));
  if (path !== undefined) out.path = path;
  const table = readStoreIdentifier(config, at(keys.table));
  if (table !== undefined) out.table = table;
  const autoCreateTables = readStoreBoolean(config, at(keys.autoCreateTables));
  if (autoCreateTables !== undefined) out.autoCreateTables = autoCreateTables;
  const busyTimeoutMs = readStoreDuration(config, at(keys.busyTimeout));
  if (busyTimeoutMs !== undefined) out.busyTimeoutMs = busyTimeoutMs;
  return out;
}
