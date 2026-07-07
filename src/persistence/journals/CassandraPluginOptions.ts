import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { CassandraClientLike } from './CassandraClient.js';
import type { RegisterCassandraPluginsSettings } from './CassandraPlugin.js';
import type { CassandraJournalOptions } from './CassandraJournalOptions.js';
import type { CassandraJournalSettings } from './CassandraJournal.js';
import type { CassandraSnapshotStoreOptions } from '../snapshot-stores/CassandraSnapshotStoreOptions.js';
import type { CassandraSnapshotStoreSettings } from '../snapshot-stores/CassandraSnapshotStore.js';

/**
 * Fluent builder for {@link RegisterCassandraPluginsSettings}.  Each store
 * takes its own leaf builder (or a plain partial of its settings); the
 * shared {@link CassandraClientLike} is merged onto both leaves at
 * registration time so a single connection tree serves the journal and
 * snapshot store:
 *
 *     registerCassandraPlugins(
 *       ext,
 *       RegisterCassandraPluginsOptions.create()
 *         .withClient(client)
 *         .withJournal(CassandraJournalOptions.create().withContactPoints(['fake']).withKeyspace('app'))
 *         .withSnapshotStore(CassandraSnapshotStoreOptions.create().withContactPoints(['fake']).withKeyspace('app')),
 *     )
 */
export class RegisterCassandraPluginsOptions extends OptionsBuilder<RegisterCassandraPluginsSettings> {
  /** Start a fresh builder.  Equivalent to `new RegisterCassandraPluginsOptions()`. */
  static create(): RegisterCassandraPluginsOptions {
    return new RegisterCassandraPluginsOptions();
  }

  /** Shared CQL client reused by both plug-ins.  When omitted, each constructs its own. */
  withClient(client: CassandraClientLike): this {
    return this.set('client', client);
  }

  /** Journal-specific options builder. */
  withJournal(journal: CassandraJournalOptions | Partial<CassandraJournalSettings>): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options builder. */
  withSnapshotStore(snapshotStore: CassandraSnapshotStoreOptions | Partial<CassandraSnapshotStoreSettings>): this {
    return this.set('snapshotStore', snapshotStore);
  }
}
