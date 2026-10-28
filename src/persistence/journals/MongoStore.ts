import { DEFAULT_MONGO_AUTO_CREATE_INDEXES, STORAGE_IDENTITY_TABLE } from '../Constants.js';
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
  /** Open the client and database handle.  Called lazily, on first use or `start()`, and again after a failed attempt (#1473). */
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
    this.autoCreateIndexes = config.autoCreateIndexes ?? DEFAULT_MONGO_AUTO_CREATE_INDEXES;
  }

  /** Create this store's indexes.  `createIndex` is idempotent, so re-running is free. */
  protected abstract createIndexes(database: MongoDatabaseLike): Promise<void>;

  /**
   * The open's proof that the deployment is there, then the indexes (#1473).
   *
   * `start()` promises that a deployment the node cannot reach fails the
   * startup rather than the first persisted message.  Index creation cannot
   * carry that promise: it is off for an operator-managed schema, and the
   * durable-state store has no index to create at all.  Nor can the client:
   * a pre-built one is handed over unopened as often as not, and the driver
   * connects it lazily, at its first command.  So every open sends one
   * `{ ping: 1 }`, first, and its failure fails the open, naming this store.
   * A ping needs no privilege, reads nothing and creates nothing.
   *
   * One command per open, not per operation: `LazyStore` runs `prepare` once
   * per successful open inside its memoized init, and runs it again only
   * after a failed attempt.
   */
  protected async prepare(resource: MongoResource): Promise<void> {
    await this.ping(resource.database);
    if (!this.autoCreateIndexes) return;
    await this.createIndexes(resource.database);
  }

  /** See {@link MongoStore.prepare}.  A database handle without `command` — a stand-in, never the driver's — is not pinged. */
  private async ping(database: MongoDatabaseLike): Promise<void> {
    if (database.command === undefined) return;
    try {
      await database.command({ ping: 1 });
    } catch (e) {
      this.fail('open', e);
    }
  }

  protected async release(resource: MongoResource): Promise<void> {
    await resource.client.close();
  }
}
