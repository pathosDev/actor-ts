import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { PgPoolLike } from './PostgresClient.js';
import type { RegisterPostgresPluginsSettings } from './PostgresPlugin.js';
import type { PostgresJournalOptions } from './PostgresJournalOptions.js';
import type { PostgresJournalSettings } from './PostgresJournal.js';
import type { PostgresSnapshotStoreOptions } from '../snapshot-stores/PostgresSnapshotStoreOptions.js';
import type { PostgresSnapshotStoreSettings } from '../snapshot-stores/PostgresSnapshotStore.js';
import type { PostgresDurableStateStoreOptions } from '../durable-state-stores/PostgresDurableStateStoreOptions.js';
import type { PostgresDurableStateStoreSettings } from '../durable-state-stores/PostgresDurableStateStore.js';

/**
 * Fluent builder for {@link RegisterPostgresPluginsSettings}:
 *
 *     registerPostgresPlugins(ext, RegisterPostgresPluginsOptions.create()
 *       .withPool(pool)
 *       .withJournal(PostgresJournalOptions.create().withEventsTable('journal'))
 *       .withSnapshotStore(PostgresSnapshotStoreOptions.create().withKeepN(5)))
 *
 * The shared `withPool(...)` is merged onto each store's resolved settings
 * by {@link registerPostgresPlugins}, so a leaf builder carries only its
 * store-specific fields.  Each leaf setter accepts EITHER the leaf builder
 * OR a plain partial of the leaf's settings.
 */
export class RegisterPostgresPluginsOptions extends OptionsBuilder<RegisterPostgresPluginsSettings> {
  /** Start a fresh builder.  Equivalent to `new RegisterPostgresPluginsOptions()`. */
  static create(): RegisterPostgresPluginsOptions {
    return new RegisterPostgresPluginsOptions();
  }

  /** Shared connection pool injected into all three stores. */
  withPool(pool: PgPoolLike): this {
    return this.set('pool', pool);
  }

  /** Journal-specific options (table names, autoCreate, and connection if no shared pool). */
  withJournal(journal: PostgresJournalOptions | Partial<PostgresJournalSettings>): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options. */
  withSnapshotStore(snapshotStore: PostgresSnapshotStoreOptions | Partial<PostgresSnapshotStoreSettings>): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options.  Defaults to a fresh builder (uses the shared pool). */
  withDurableStateStore(durableStateStore: PostgresDurableStateStoreOptions | Partial<PostgresDurableStateStoreSettings>): this {
    return this.set('durableStateStore', durableStateStore);
  }
}
