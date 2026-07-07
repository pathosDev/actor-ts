import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { MariaDbPoolLike } from './MariaDbClient.js';
import type { RegisterMariaDbPluginsSettings } from './MariaDbPlugin.js';
import type { MariaDbJournalOptions } from './MariaDbJournalOptions.js';
import type { MariaDbJournalSettings } from './MariaDbJournal.js';
import type { MariaDbSnapshotStoreOptions } from '../snapshot-stores/MariaDbSnapshotStoreOptions.js';
import type { MariaDbSnapshotStoreSettings } from '../snapshot-stores/MariaDbSnapshotStore.js';
import type { MariaDbDurableStateStoreOptions } from '../durable-state-stores/MariaDbDurableStateStoreOptions.js';
import type { MariaDbDurableStateStoreSettings } from '../durable-state-stores/MariaDbDurableStateStore.js';

/**
 * Fluent builder for {@link RegisterMariaDbPluginsSettings}:
 *
 *     registerMariaDbPlugins(ext, RegisterMariaDbPluginsOptions.create()
 *       .withPool(sharedPool)
 *       .withJournal(MariaDbJournalOptions.create().withEventsTable('journal')))
 *
 * Each per-store field is the store's own leaf builder (or a plain partial
 * of its settings); the shared `pool` (when set via `withPool`) is merged
 * onto every store's resolved settings at registration time, so a leaf
 * need not repeat the connection.
 */
export class RegisterMariaDbPluginsOptions extends OptionsBuilder<RegisterMariaDbPluginsSettings> {
  /** Start a fresh builder.  Equivalent to `new RegisterMariaDbPluginsOptions()`. */
  static create(): RegisterMariaDbPluginsOptions {
    return new RegisterMariaDbPluginsOptions();
  }

  /** Shared connection pool reused by all three stores (overrides each leaf's own pool). */
  withPool(pool: MariaDbPoolLike): this {
    return this.set('pool', pool);
  }

  /** Journal builder — table names / autoCreate (connection filled from the shared pool). */
  withJournal(journal: MariaDbJournalOptions | Partial<MariaDbJournalSettings>): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store builder — table name / keepN (connection filled from the shared pool). */
  withSnapshotStore(snapshotStore: MariaDbSnapshotStoreOptions | Partial<MariaDbSnapshotStoreSettings>): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store builder — table name (connection filled from the shared pool). */
  withDurableStateStore(durableStateStore: MariaDbDurableStateStoreOptions | Partial<MariaDbDurableStateStoreSettings>): this {
    return this.set('durableStateStore', durableStateStore);
  }
}
