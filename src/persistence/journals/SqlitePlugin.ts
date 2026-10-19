import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import { OptionsError } from '../../util/OptionsValidator.js';
import {
  readPersistencePluginIdsFromConfig,
  type PersistenceExtension,
  type PersistencePluginIds,
} from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { SqliteDurableStateStore } from '../durable-state-stores/SqliteDurableStateStore.js';
import {
  SqliteDurableStateStoreOptionsValidator,
  type SqliteDurableStateStoreOptionsType,
} from '../durable-state-stores/SqliteDurableStateStoreOptions.js';
import { SqliteSnapshotStore } from '../snapshot-stores/SqliteSnapshotStore.js';
import {
  SqliteSnapshotStoreOptionsValidator,
  type SqliteSnapshotStoreOptionsType,
} from '../snapshot-stores/SqliteSnapshotStoreOptions.js';
import { SqliteJournal } from './SqliteJournal.js';
import { SqliteJournalOptionsValidator, type SqliteJournalOptionsType } from './SqliteJournalOptions.js';
import {
  readSqliteDurableStateStoreOptionsFromConfig,
  readSqliteJournalOptionsFromConfig,
  readSqliteSnapshotStoreOptionsFromConfig,
} from './SqlitePluginOptions.js';
import type {
  RegisterSqlitePluginsOptions,
  RegisterSqlitePluginsOptionsType,
} from './SqlitePluginOptions.js';

/** Canonical plug-in IDs for the SQLite journal, snapshot, and durable-state stores. */
export const SQLITE_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.sqlite';
export const SQLITE_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.sqlite';
export const SQLITE_DURABLE_STATE_PLUGIN_ID = 'actor-ts.persistence.durable-state.sqlite';

/**
 * One-shot registration of the SQLite journal, snapshot store and
 * durable-state store with a `PersistenceExtension` (#872).
 *
 * Pass it to `ActorSystemOptions.withPersistence({ plugins })` as
 * `(persistence) => registerSqlitePlugins(persistence)`: a plug-in runs inside
 * `ActorSystem.create`, so the stores the configuration selects are
 * registered before the system opens them at startup (#1473).  A selected
 * store registered after `create` fails the startup instead.
 *
 * SQLite was the one shipped backend with **no registration story at all** —
 * no plug-in file, no plug-in ids — while
 * `docs/…/reference/configuration.mdx` and `examples/chat/application.conf`
 * both named `actor-ts.persistence.journal.sqlite` as a plugin id.  That id
 * resolved to nothing; the example survived only because it bypassed the
 * selector with `setJournal()`.  After this call the id is real.
 *
 * After registering, activate the stores via HOCON (or a `{ config: { … } }`
 * override):
 *
 *   `actor-ts.persistence.journal.plugin       = "actor-ts.persistence.journal.sqlite"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.sqlite"`
 *   `actor-ts.persistence.durable-state.plugin  = "actor-ts.persistence.durable-state.sqlite"`
 *
 * **Everything else can come from configuration.**  `options` is optional,
 * because `path`, the table names, `wal`, `keep-n`, `auto-create-tables` and
 * the busy timeout all have leaves under the three blocks:
 *
 *   `registerSqlitePlugins(ext);   // path, tables, retention … from HOCON`
 *
 * Precedence is the project-wide one — explicit options > HOCON > built-in
 * defaults, per field, with an unset field falling through rather than
 * shadowing.  A selected store's options are merged here, from `ext.config` —
 * the system's own configuration, which nothing layers over once
 * `ActorSystem.create` has built it — so they can be checked before anything
 * opens, and its factory constructs from that merge.  Every other store's
 * options are merged inside its factory, which runs only for a store something
 * resolves: a block the configuration does not select is never read, so a
 * malformed leaf in it cannot fail the system — the property the other
 * plug-ins keep by merging there too.
 *
 * A `serializer` supplied here reaches all three stores, and a `database`
 * reaches the durable-state store only: the journal and the snapshot store
 * open their own handle (#491).  `path` is a shared *default* rather than an
 * override — a leaf that names its own keeps it, which is the same split
 * `mergeLeafOptions` documents for the other relational plug-ins.
 *
 * **A selected store that names no database is refused here** (#1492).  For
 * every axis whose selector names one of these ids, the store's options
 * validator runs over the merge, so a setting it refuses fails the
 * registration rather than the store's first resolution.  A path it refuses —
 * absent, empty or a remote URL — makes this call throw an `OptionsError` that
 * names the key, the code route and `":memory:"`, the explicit in-memory
 * database.  Inside `ActorSystem.create` that is `create` throwing, before
 * anything opens.
 * Keyed on the selection because only a selected store is ever built: the
 * registry resolves a factory for the id a selector names, so an unselected
 * root never becomes a store, and requiring a path for one would make every
 * application that selects only some of the three name a database it never
 * opens.  A store constructed directly still meets the same rule in its
 * constructor.
 *
 * It returns nothing: the durable-state store is a registered factory like
 * the other two, reached through `ext.durableStateStore` (or simply by leaving
 * `DurableStateOptions.store` unset) rather than handed back as an instance.
 */
export function registerSqlitePlugins(
  ext: PersistenceExtension,
  options: RegisterSqlitePluginsOptions = {},
): void {
  const resolvedOptions = (options as RegisterSqlitePluginsOptionsType);
  const { database, serializer, path } = resolvedOptions;
  const sharedDefaults = { path };

  const mergeJournalOptions = (): SqliteJournalOptionsType => mergeOptions<SqliteJournalOptionsType>(
    {},
    readSqliteJournalOptionsFromConfig(ext.config, SQLITE_JOURNAL_PLUGIN_ID),
    // The journal drives `SqliteDb` directly and has no `database` field, so
    // only the serializer is shared into it (#491 would change that).
    mergeLeafOptions<Partial<SqliteJournalOptionsType>>(resolvedOptions.journal, { serializer }, sharedDefaults),
  );
  const mergeSnapshotStoreOptions = (): SqliteSnapshotStoreOptionsType => mergeOptions<SqliteSnapshotStoreOptionsType>(
    {},
    readSqliteSnapshotStoreOptionsFromConfig(ext.config, SQLITE_SNAPSHOT_PLUGIN_ID),
    mergeLeafOptions<Partial<SqliteSnapshotStoreOptionsType>>(resolvedOptions.snapshotStore, { serializer }, sharedDefaults),
  );
  const mergeDurableStateStoreOptions = (): SqliteDurableStateStoreOptionsType =>
    mergeOptions<SqliteDurableStateStoreOptionsType>(
      {},
      readSqliteDurableStateStoreOptionsFromConfig(ext.config, SQLITE_DURABLE_STATE_PLUGIN_ID),
      mergeLeafOptions<Partial<SqliteDurableStateStoreOptionsType>>(
        resolvedOptions.durableStateStore, { database, serializer }, sharedDefaults,
      ),
    );

  // A selected root is merged now, so its validator can refuse it before
  // anything opens.  Any other root is merged inside its factory, which runs
  // only for a store something resolves, so its block is never read.
  const selection = selectionOf(ext.config);
  const journalOptions = selection?.journal === SQLITE_JOURNAL_PLUGIN_ID ? mergeJournalOptions() : undefined;
  const snapshotStoreOptions = selection?.snapshotStore === SQLITE_SNAPSHOT_PLUGIN_ID
    ? mergeSnapshotStoreOptions()
    : undefined;
  const durableStateStoreOptions = selection?.durableState === SQLITE_DURABLE_STATE_PLUGIN_ID
    ? mergeDurableStateStoreOptions()
    : undefined;

  if (journalOptions !== undefined) {
    refuseUnusablePath(
      SQLITE_JOURNAL_PLUGIN_ID, ConfigKeys.persistence.journal.sqlite.path, 'SqliteJournalOptions', 'journal',
      () => new SqliteJournalOptionsValidator().validate(journalOptions),
    );
  }
  if (snapshotStoreOptions !== undefined) {
    refuseUnusablePath(
      SQLITE_SNAPSHOT_PLUGIN_ID, ConfigKeys.persistence.snapshotStore.sqlite.path, 'SqliteSnapshotStoreOptions',
      'snapshot store', () => new SqliteSnapshotStoreOptionsValidator().validate(snapshotStoreOptions),
    );
  }
  if (durableStateStoreOptions !== undefined) {
    refuseUnusablePath(
      SQLITE_DURABLE_STATE_PLUGIN_ID, ConfigKeys.persistence.durableState.sqlite.path,
      'SqliteDurableStateStoreOptions', null,
      () => new SqliteDurableStateStoreOptionsValidator().validate(durableStateStoreOptions),
    );
  }

  ext.registerJournal(SQLITE_JOURNAL_PLUGIN_ID, () => new SqliteJournal(journalOptions ?? mergeJournalOptions()));
  ext.registerSnapshotStore(
    SQLITE_SNAPSHOT_PLUGIN_ID,
    () => new SqliteSnapshotStore(snapshotStoreOptions ?? mergeSnapshotStoreOptions()),
  );
  ext.registerDurableStateStore(
    SQLITE_DURABLE_STATE_PLUGIN_ID,
    () => new SqliteDurableStateStore(durableStateStoreOptions ?? mergeDurableStateStoreOptions()),
  );
}

/**
 * The plugin ids the three selectors name, or `undefined` when one of them
 * holds no id at all.  That mistake is not this plug-in's to report: the
 * registry refuses the same selector with the same error when it resolves the
 * axis, so failing here would only move an unrelated mistake to a different
 * place depending on which backends happen to be registered.
 */
function selectionOf(config: Config): PersistencePluginIds | undefined {
  try {
    return readPersistencePluginIdsFromConfig(config);
  } catch {
    return undefined;
  }
}

/**
 * Run a selected store's validator over its merged options, and rethrow a
 * refusal of its `path` as one that says where a path comes from: the block's
 * key, the code route, and `":memory:"` for an in-memory database.
 *
 * `ownHandleStore` names a store that a shared `database` does not reach, so
 * the message can say so instead of leaving a caller who passed one to wonder
 * why it did not count; `null` for the durable-state store, which takes one.
 */
function refuseUnusablePath(
  pluginId: string,
  pathKey: string,
  leafOptions: string,
  ownHandleStore: string | null,
  validate: () => void,
): void {
  try {
    validate();
  } catch (error) {
    if (!(error instanceof OptionsError) || error.field !== 'path') throw error;
    const handle = ownHandleStore === null
      ? ''
      : ` A database passed in code does not reach the SQLite ${ownHandleStore}, which opens its own (#491).`;
    throw new OptionsError(
      `registerSqlitePlugins: the selected plugin '${pluginId}' has no usable path (${error.message}). `
        + `Set ${pathKey}, or pass a path in code through RegisterSqlitePluginsOptions.withPath or `
        + `${leafOptions}.withPath; path = ":memory:" is the explicit in-memory database.${handle}`,
      error.options,
      error.field,
      error.value,
    );
  }
}
