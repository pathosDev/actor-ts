import { LazyStore, type LazyStoreConfig } from '../LazyStore.js';
import type { MongoDatabaseLike, MongoResource } from './MongoClient.js';

/** Wiring every MongoDB store needs, independent of which contract it implements. */
export type MongoStoreConfig = Omit<LazyStoreConfig<MongoResource>, 'ownsResource' | 'openResource'> & {
  /** Create this store's indexes on first use.  Default `true`. */
  readonly autoCreateIndexes?: boolean;
  /**
   * Whether this store opened the client itself.  An injected client — shared
   * across the journal, snapshot and durable-state stores by
   * `registerMongoPlugins`, or a fake in tests — is owned by the caller, and
   * closing it here would tear it out from under the siblings.
   */
  readonly ownsClient: boolean;
  /** Open the client and database handle.  Called once, lazily, on first use. */
  openClient(): Promise<MongoResource>;
};

/**
 * The MongoDB half of the store lifecycle: `LazyStore` handles lazy connection,
 * one-shot preparation and ownership-aware teardown, and this layer supplies
 * index creation as the preparation step.
 *
 * Index creation is not cosmetic here the way `CREATE INDEX` often is.  The
 * journal's unique compound index on `(persistenceId, sequenceNr)` *is* the
 * optimistic-concurrency backstop — without it a racing writer silently
 * overwrites, exactly the failure the relational backends get for free from a
 * primary key.  `autoCreateIndexes: false` therefore means "I have created them
 * myself", not "I don't need them", and the docs say so.
 */
export abstract class MongoStore extends LazyStore<MongoResource> {
  private readonly autoCreateIndexes: boolean;

  protected constructor(config: MongoStoreConfig) {
    super({
      storeName: config.storeName,
      ownsResource: config.ownsClient,
      openResource: () => config.openClient(),
    });
    this.autoCreateIndexes = config.autoCreateIndexes ?? true;
  }

  /** Create this store's indexes.  `createIndex` is idempotent, so re-running is free. */
  protected abstract createIndexes(database: MongoDatabaseLike): Promise<void>;

  protected async prepare(resource: MongoResource): Promise<void> {
    if (!this.autoCreateIndexes) return;
    await this.createIndexes(resource.database);
  }

  protected async release(resource: MongoResource): Promise<void> {
    await resource.client.close();
  }
}
