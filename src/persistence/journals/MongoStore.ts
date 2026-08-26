import { STORAGE_IDENTITY_TABLE } from '../Constants.js';
import { LazyStore, type LazyStoreConfig } from '../LazyStore.js';
import type { StorageLocality } from '../StorageLocality.js';
import type { MongoDatabaseLike, MongoResource } from './MongoClient.js';

/** Wiring every MongoDB store needs, independent of which contract it implements. */
export interface MongoStoreConfig extends Omit<LazyStoreConfig<MongoResource>, 'ownsResource' | 'openResource'> {
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
}

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
  /** A MongoDB server/cluster any node can reach — `'shared'` for the whole family (#1356). */
  readonly storageLocality: StorageLocality = 'shared';
  private mintedStorageIdentity: string | null = null;
  private readonly autoCreateIndexes: boolean;

  /**
   * Identity of the database — per database, not per store: the three stores
   * over one database read the same document in the `storage_identity`
   * collection, which is the point (#1358).  `$setOnInsert` + `upsert` is the
   * claim; losing it to a sibling store is the expected path.
   */
  async storageIdentity(): Promise<string> {
    if (this.mintedStorageIdentity !== null) return this.mintedStorageIdentity;
    const resource = await this.ensureOpen();
    const collection = resource.database.collection(STORAGE_IDENTITY_TABLE);
    await collection.updateOne(
      { _id: 'storage-identity' },
      { $setOnInsert: { identity: crypto.randomUUID() } },
      { upsert: true },
    );
    const document = await collection.findOne({ _id: 'storage-identity' });
    const identity = (document as { identity?: unknown } | null)?.identity;
    if (typeof identity !== 'string' || identity.length === 0) {
      this.fail('storageIdentity', new Error('identity document missing after upsert'));
    }
    this.mintedStorageIdentity = identity;
    return identity;
  }

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
