import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import { assertMongoName, assertMongoUrl } from '../journals/MongoJournalOptions.js';
import { MongoOptionsValidatorBase, type MongoClientLike, type MongoConnection } from '../journals/MongoClient.js';

export interface MongoSnapshotStoreOptionsType extends MongoConnection, StoreSerializerOptionsBase {
  /** Snapshots collection name.  Default: `snapshots`. */
  readonly snapshotsCollection?: string;
  /** How many snapshots to keep per persistence id.  Default: 3; `<= 0` keeps all. */
  readonly keepN?: number;
  /** Create the indexes on first use.  Default: true. */
  readonly autoCreateIndexes?: boolean;
}

/**
 * Fluent builder for {@link MongoSnapshotStoreOptionsType}:
 *
 *     new MongoSnapshotStore(MongoSnapshotStoreOptions.create()
 *       .withUrl('mongodb://localhost:27017')
 *       .withKeepN(5))
 */
export class MongoSnapshotStoreOptionsBuilder extends StoreSerializerOptionsBuilder<MongoSnapshotStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MongoSnapshotStoreOptionsBuilder()`. */
  static create(): MongoSnapshotStoreOptionsBuilder {
    return new MongoSnapshotStoreOptionsBuilder();
  }

  /** Connection string — `mongodb://…` or `mongodb+srv://…`. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Database name.  Default: `actor_ts`. */
  withDatabaseName(databaseName: string): this {
    return this.set('databaseName', databaseName);
  }

  /**
   * Extra `MongoClient` options — `{ authSource, readPreference, appName, … }` —
   * handed to the driver as they are.  The pool size, the two timeouts and a CA
   * have setters of their own, below.
   */
  withClientOptions(clientOptions: Record<string, unknown>): this {
    return this.set('clientOptions', clientOptions);
  }

  /** Pre-built client — bypasses the lazy `mongodb` import; share it across stores. */
  withClient(client: MongoClientLike): this {
    return this.set('client', client);
  }

  /** Most connections the client holds open to one server — the driver's `maxPoolSize`.  Unset: 100. */
  withMaxPoolSize(maxPoolSize: number): this {
    return this.set('maxPoolSize', maxPoolSize);
  }

  /** Fewest connections the client keeps open to one server — the driver's `minPoolSize`.  Unset: 0. */
  withMinPoolSize(minPoolSize: number): this {
    return this.set('minPoolSize', minPoolSize);
  }

  /** How long an operation waits for a usable server, in ms — `serverSelectionTimeoutMS`.  Unset: 30 000. */
  withServerSelectionTimeoutMs(serverSelectionTimeoutMs: number): this {
    return this.set('serverSelectionTimeoutMs', serverSelectionTimeoutMs);
  }

  /** Time allowed to open a connection, in ms — the driver's `connectTimeoutMS`.  Unset: 30 000. */
  withConnectTimeoutMs(connectTimeoutMs: number): this {
    return this.set('connectTimeoutMs', connectTimeoutMs);
  }

  /**
   * PEM file of the CA that signed the server's certificate, read when the
   * client opens and handed to the driver as `ca` — see `MongoConnection.caFile`.
   */
  withCaFile(caFile: string): this {
    return this.set('caFile', caFile);
  }

  /** Snapshots collection name.  Default: `snapshots`. */
  withSnapshotsCollection(snapshotsCollection: string): this {
    return this.set('snapshotsCollection', snapshotsCollection);
  }

  /** How many snapshots to keep per persistence id.  Default: 3; `<= 0` keeps all. */
  withKeepN(keepN: number): this {
    return this.set('keepN', keepN);
  }

  /** Create the indexes on first use.  Default: true. */
  withAutoCreateIndexes(autoCreateIndexes: boolean): this {
    return this.set('autoCreateIndexes', autoCreateIndexes);
  }
}

/**
 * Accepted input for any MongoDB snapshot-store constructor: the fluent
 * {@link MongoSnapshotStoreOptionsBuilder} OR a plain
 * {@link MongoSnapshotStoreOptionsType} object.
 */
export type MongoSnapshotStoreOptions =
  | MongoSnapshotStoreOptionsBuilder
  | Partial<MongoSnapshotStoreOptionsType>;
/** Value alias so `MongoSnapshotStoreOptions.create()` resolves to the builder. */
export const MongoSnapshotStoreOptions = MongoSnapshotStoreOptionsBuilder;

/**
 * `keepN` is checked as an integer rather than a positive one: zero and
 * negatives are the documented way to disable pruning, so only a fractional
 * value is a mistake.  The typed client fields are checked as every MongoDB
 * store checks them — see `MongoOptionsValidatorBase`.
 */
export class MongoSnapshotStoreOptionsValidator extends MongoOptionsValidatorBase<MongoSnapshotStoreOptionsType> {
  constructor() { super('MongoSnapshotStoreOptions'); }

  protected rules(s: Partial<MongoSnapshotStoreOptionsType>): void {
    assertMongoUrl('MongoSnapshotStoreOptions', s.url);
    assertMongoName('MongoSnapshotStoreOptions', 'databaseName', s.databaseName);
    assertMongoName('MongoSnapshotStoreOptions', 'snapshotsCollection', s.snapshotsCollection);
    if (s.keepN !== undefined && !Number.isInteger(s.keepN)) {
      this.fail('keepN', 'must be an integer (<= 0 disables pruning)', s.keepN);
    }
    this.checkClient(s);
  }
}
