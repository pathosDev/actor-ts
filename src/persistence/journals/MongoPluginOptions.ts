import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Serializer } from '../../serialization/Serializer.js';
import type { MongoClientLike } from './MongoClient.js';
import type { MongoJournalOptions } from './MongoJournalOptions.js';
import type { MongoSnapshotStoreOptions } from '../snapshot-stores/MongoSnapshotStoreOptions.js';
import type { MongoDurableStateStoreOptions } from '../durable-state-stores/MongoDurableStateStoreOptions.js';

export type RegisterMongoPluginsOptionsType = {
  /**
   * Shared client injected into all three stores — the usual case, since a
   * `MongoClient` is a connection pool in its own right and they target the same
   * deployment.  When omitted, each store lazily builds its own from its `url`.
   */
  readonly client?: MongoClientLike;
  /** Connection string applied to every store that does not set its own. */
  readonly url?: string;
  /** Database name applied to every store that does not set its own. */
  readonly databaseName?: string;
  /** `MongoClient` options applied to every store that does not set its own. */
  readonly clientOptions?: Record<string, unknown>;
  /** Shared payload serializer applied to every store that does not set its own. */
  readonly serializer?: Serializer;
  /** Journal-specific options (collection name, autoCreateIndexes). */
  readonly journal?: MongoJournalOptions;
  /** Snapshot-store-specific options (collection name, keepN). */
  readonly snapshotStore?: MongoSnapshotStoreOptions;
  /** Durable-state-store-specific options (collection name). */
  readonly durableStateStore?: MongoDurableStateStoreOptions;
};

/**
 * Fluent builder for {@link RegisterMongoPluginsOptionsType}:
 *
 *     const pluginOptions = RegisterMongoPluginsOptions.create()
 *       .withUrl('mongodb://localhost:27017')
 *       .withDatabaseName('app')
 *       .withSnapshotStore(MongoSnapshotStoreOptions.create().withKeepN(5));
 *     const handles = registerMongoPlugins(persistence, pluginOptions);
 *
 * The shared connection fields are merged onto each store's options by
 * `registerMongoPlugins`, so a leaf carries only its store-specific fields.
 * Each leaf setter accepts EITHER the leaf builder OR a plain object.
 */
export class RegisterMongoPluginsOptionsBuilder extends OptionsBuilder<RegisterMongoPluginsOptionsType> {
  /** Start a fresh builder.  Equivalent to `new RegisterMongoPluginsOptionsBuilder()`. */
  static create(): RegisterMongoPluginsOptionsBuilder {
    return new RegisterMongoPluginsOptionsBuilder();
  }

  /** Shared client injected into all three stores. */
  withClient(client: MongoClientLike): this {
    return this.set('client', client);
  }

  /** Shared payload serializer applied to every store that does not set its own. */
  withSerializer(serializer: Serializer): this {
    return this.set('serializer', serializer);
  }

  /** Connection string applied to every store that does not set its own. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Database name applied to every store that does not set its own. */
  withDatabaseName(databaseName: string): this {
    return this.set('databaseName', databaseName);
  }

  /** `MongoClient` options applied to every store that does not set its own. */
  withClientOptions(clientOptions: Record<string, unknown>): this {
    return this.set('clientOptions', clientOptions);
  }

  /** Journal-specific options (collection name, autoCreateIndexes). */
  withJournal(journal: MongoJournalOptions): this {
    return this.set('journal', journal);
  }

  /** Snapshot-store-specific options (collection name, keepN). */
  withSnapshotStore(snapshotStore: MongoSnapshotStoreOptions): this {
    return this.set('snapshotStore', snapshotStore);
  }

  /** Durable-state-store-specific options (collection name). */
  withDurableStateStore(durableStateStore: MongoDurableStateStoreOptions): this {
    return this.set('durableStateStore', durableStateStore);
  }
}

/**
 * Accepted input for `registerMongoPlugins`: the fluent
 * {@link RegisterMongoPluginsOptionsBuilder} OR a plain
 * {@link RegisterMongoPluginsOptionsType} object.
 */
export type RegisterMongoPluginsOptions =
  | RegisterMongoPluginsOptionsBuilder
  | Partial<RegisterMongoPluginsOptionsType>;
/** Value alias so `RegisterMongoPluginsOptions.create()` resolves to the builder. */
export const RegisterMongoPluginsOptions = RegisterMongoPluginsOptionsBuilder;
