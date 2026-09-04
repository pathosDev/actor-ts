import type { ActorSystem } from '../../ActorSystem.js';
import { mergeOptions } from '../../util/OptionsMerge.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import { mergeLeafOptions } from '../relational/RelationalPlugin.js';
import { SqliteDurableStateStore } from '../durable-state-stores/SqliteDurableStateStore.js';
import type { SqliteDurableStateStoreOptionsType } from '../durable-state-stores/SqliteDurableStateStoreOptions.js';
import { SqliteSnapshotStore } from '../snapshot-stores/SqliteSnapshotStore.js';
import type { SqliteSnapshotStoreOptionsType } from '../snapshot-stores/SqliteSnapshotStoreOptions.js';
import { SqliteJournal } from './SqliteJournal.js';
import type { SqliteJournalOptionsType } from './SqliteJournalOptions.js';
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
 * durable-state store against the running `PersistenceExtension` (#872).
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
 * shadowing.  The merge happens **inside each registered factory**, not here:
 * a factory is handed the `ActorSystem`, which is the only route to
 * `system.config` (the extension keeps its system private), and reading at
 * registration time would freeze the settings before an `application.conf`
 * layered on top of them could apply.
 *
 * A `database` or `serializer` supplied here is shared by all three stores,
 * and `path` is a shared *default* rather than an override — a leaf that names
 * its own keeps it, which is the same split `mergeLeafOptions` documents for
 * the other relational plug-ins.
 *
 * Unlike its siblings this returns nothing.  The durable-state store is now a
 * registered factory like the other two, so it is reached through
 * `ext.durableStateStore` (or simply by leaving `DurableStateOptions.store`
 * unset) instead of being handed back as a constructed instance.
 */
export function registerSqlitePlugins(
  ext: PersistenceExtension,
  options: RegisterSqlitePluginsOptions = {},
): void {
  const resolvedOptions = (options as RegisterSqlitePluginsOptionsType);
  const { database, serializer, path } = resolvedOptions;
  const shared = { database, serializer };
  const sharedDefaults = { path };

  ext.registerJournal(SQLITE_JOURNAL_PLUGIN_ID, (system: ActorSystem) => new SqliteJournal(
    mergeOptions<SqliteJournalOptionsType>(
      {},
      readSqliteJournalOptionsFromConfig(system.config, SQLITE_JOURNAL_PLUGIN_ID),
      // The journal drives `SqliteDb` directly and has no `database` field, so
      // only the serializer is shared into it (#491 would change that).
      mergeLeafOptions<Partial<SqliteJournalOptionsType>>(
        resolvedOptions.journal, { serializer }, sharedDefaults,
      ),
    ),
  ));

  ext.registerSnapshotStore(SQLITE_SNAPSHOT_PLUGIN_ID, (system: ActorSystem) => new SqliteSnapshotStore(
    mergeOptions<SqliteSnapshotStoreOptionsType>(
      {},
      readSqliteSnapshotStoreOptionsFromConfig(system.config, SQLITE_SNAPSHOT_PLUGIN_ID),
      mergeLeafOptions<Partial<SqliteSnapshotStoreOptionsType>>(
        resolvedOptions.snapshotStore, { serializer }, sharedDefaults,
      ),
    ),
  ));

  ext.registerDurableStateStore(SQLITE_DURABLE_STATE_PLUGIN_ID, (system: ActorSystem) => new SqliteDurableStateStore(
    mergeOptions<SqliteDurableStateStoreOptionsType>(
      {},
      readSqliteDurableStateStoreOptionsFromConfig(system.config, SQLITE_DURABLE_STATE_PLUGIN_ID),
      mergeLeafOptions<Partial<SqliteDurableStateStoreOptionsType>>(
        resolvedOptions.durableStateStore, shared, sharedDefaults,
      ),
    ),
  ));
}
