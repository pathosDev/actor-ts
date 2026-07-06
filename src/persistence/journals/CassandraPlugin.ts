import type { ActorSystem } from '../../ActorSystem.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { PersistenceExtension } from '../PersistenceExtension.js';
import {
  CassandraJournal,
  CassandraJournalOptions,
} from './CassandraJournal.js';
import {
  CassandraSnapshotStore,
  CassandraSnapshotStoreOptions,
} from '../snapshot-stores/CassandraSnapshotStore.js';
import type { CassandraClientLike } from './CassandraClient.js';

/** Canonical plug-in IDs for the Cassandra journal and snapshot store. */
export const CASSANDRA_JOURNAL_PLUGIN_ID = 'actor-ts.persistence.journal.cassandra';
export const CASSANDRA_SNAPSHOT_PLUGIN_ID = 'actor-ts.persistence.snapshot-store.cassandra';

export interface RegisterCassandraPluginsSettings {
  /**
   * Shared CQL client used by the journal AND the snapshot store.  When
   * provided, both plug-ins reuse the same connection pool (one TCP
   * connection tree per cluster node).  When omitted, each plug-in
   * constructs its own client.
   */
  readonly client?: CassandraClientLike;
  /** Journal-specific overrides. */
  readonly journal: CassandraJournalOptions;
  /** Snapshot-store-specific overrides.  Usually shares keyspace with the journal. */
  readonly snapshotStore: CassandraSnapshotStoreOptions;
}

/**
 * Fluent builder for {@link RegisterCassandraPluginsSettings}.  Each store
 * takes its own leaf builder; the shared {@link CassandraClientLike} is
 * threaded onto both leaves at registration time so a single connection
 * tree serves the journal and snapshot store:
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
  withJournal(journal: CassandraJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options builder. */
  withSnapshotStore(snapshotStore: CassandraSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }
}

/**
 * One-shot registration of both the Cassandra/Scylla journal and the
 * matching snapshot store against the running `PersistenceExtension`.
 * After this call set
 *   `actor-ts.persistence.journal.plugin = "actor-ts.persistence.journal.cassandra"`
 *   `actor-ts.persistence.snapshot-store.plugin = "actor-ts.persistence.snapshot-store.cassandra"`
 * either via HOCON or a `{ config: { ... } }` override to make them active.
 */
export function registerCassandraPlugins(
  ext: PersistenceExtension,
  options: RegisterCassandraPluginsOptions,
): void {
  const s = options.build();
  const journalBuilder = s.journal ?? CassandraJournalOptions.create();
  const snapshotBuilder = s.snapshotStore ?? CassandraSnapshotStoreOptions.create();
  // Thread the shared client onto both leaves so they reuse one connection tree.
  if (s.client) {
    journalBuilder.withClient(s.client);
    snapshotBuilder.withClient(s.client);
  }
  ext.registerJournal(
    CASSANDRA_JOURNAL_PLUGIN_ID,
    (_system: ActorSystem) => new CassandraJournal(journalBuilder),
  );
  ext.registerSnapshotStore(
    CASSANDRA_SNAPSHOT_PLUGIN_ID,
    (_system: ActorSystem) => new CassandraSnapshotStore(snapshotBuilder),
  );
}
