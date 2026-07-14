import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { CassandraClientLike } from './CassandraClient.js';
import type { CassandraJournalOptions } from './CassandraJournalOptions.js';
import type { CassandraSnapshotStoreOptions } from '../snapshot-stores/CassandraSnapshotStoreOptions.js';

export interface RegisterCassandraPluginsOptionsType {
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
 * Fluent builder for {@link RegisterCassandraPluginsOptionsType}.  Each store
 * takes its own leaf builder (or a plain object of its options); the
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
export class RegisterCassandraPluginsOptionsBuilder extends OptionsBuilder<RegisterCassandraPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterCassandraPluginsOptionsBuilder()`. */
  static create(): RegisterCassandraPluginsOptionsBuilder {
    return new RegisterCassandraPluginsOptionsBuilder();
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
 * Accepted input for {@link registerCassandraPlugins}: the fluent
 * {@link RegisterCassandraPluginsOptionsBuilder} OR a plain
 * {@link RegisterCassandraPluginsOptionsType} object.
 */
export type RegisterCassandraPluginsOptions =
  | RegisterCassandraPluginsOptionsBuilder
  | Partial<RegisterCassandraPluginsOptionsType>;
/** Value alias so `RegisterCassandraPluginsOptions.create()` / `new RegisterCassandraPluginsOptions()` resolve to the builder. */
export const RegisterCassandraPluginsOptions = RegisterCassandraPluginsOptionsBuilder;
