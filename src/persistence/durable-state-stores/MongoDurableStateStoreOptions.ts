import { StoreSerializerOptionsBuilder, type StoreSerializerOptionsBase } from '../storage/StoreSerializerOptions.js';
import { assertMongoName, assertMongoUrl } from '../journals/MongoJournalOptions.js';
import { MongoOptionsValidatorBase, type MongoClientLike, type MongoConnection } from '../journals/MongoClient.js';

export interface MongoDurableStateStoreOptionsType extends MongoConnection, StoreSerializerOptionsBase {
  /** Durable-state collection name.  Default: `durable_state`. */
  readonly collection?: string;
}

/**
 * Fluent builder for {@link MongoDurableStateStoreOptionsType}:
 *
 *     new MongoDurableStateStore(MongoDurableStateStoreOptions.create()
 *       .withUrl('mongodb://localhost:27017'))
 */
export class MongoDurableStateStoreOptionsBuilder extends StoreSerializerOptionsBuilder<MongoDurableStateStoreOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MongoDurableStateStoreOptionsBuilder()`. */
  static create(): MongoDurableStateStoreOptionsBuilder {
    return new MongoDurableStateStoreOptionsBuilder();
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

  /** Durable-state collection name.  Default: `durable_state`. */
  withCollection(collection: string): this {
    return this.set('collection', collection);
  }
}

/**
 * Accepted input for any MongoDB durable-state constructor: the fluent
 * {@link MongoDurableStateStoreOptionsBuilder} OR a plain
 * {@link MongoDurableStateStoreOptionsType} object.
 */
export type MongoDurableStateStoreOptions =
  | MongoDurableStateStoreOptionsBuilder
  | Partial<MongoDurableStateStoreOptionsType>;
/** Value alias so `MongoDurableStateStoreOptions.create()` resolves to the builder. */
export const MongoDurableStateStoreOptions = MongoDurableStateStoreOptionsBuilder;

/**
 * Validates the connection fields and collection name, and the typed client
 * fields every MongoDB store shares — see `MongoOptionsValidatorBase`.
 */
export class MongoDurableStateStoreOptionsValidator
  extends MongoOptionsValidatorBase<MongoDurableStateStoreOptionsType> {
  constructor() { super('MongoDurableStateStoreOptions'); }

  protected rules(s: Partial<MongoDurableStateStoreOptionsType>): void {
    assertMongoUrl('MongoDurableStateStoreOptions', s.url);
    assertMongoName('MongoDurableStateStoreOptions', 'databaseName', s.databaseName);
    assertMongoName('MongoDurableStateStoreOptions', 'collection', s.collection);
    this.checkClient(s);
  }
}
