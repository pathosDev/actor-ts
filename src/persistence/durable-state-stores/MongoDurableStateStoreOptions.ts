import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import { assertMongoName, assertMongoUrl } from '../journals/MongoJournalOptions.js';
import type { MongoClientLike, MongoConnection } from '../journals/MongoClient.js';

export interface MongoDurableStateStoreOptionsType extends MongoConnection {
  /** Durable-state collection name.  Default: `durable_state`. */
  readonly collection?: string;
}

/**
 * Fluent builder for {@link MongoDurableStateStoreOptionsType}:
 *
 *     new MongoDurableStateStore(MongoDurableStateStoreOptions.create()
 *       .withUrl('mongodb://localhost:27017'))
 */
export class MongoDurableStateStoreOptionsBuilder extends OptionsBuilder<MongoDurableStateStoreOptionsType> {
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

  /** Extra `MongoClient` options — `{ tls, authSource, maxPoolSize, … }`. */
  withClientOptions(clientOptions: Record<string, unknown>): this {
    return this.set('clientOptions', clientOptions);
  }

  /** Pre-built client — bypasses the lazy `mongodb` import; share it across stores. */
  withClient(client: MongoClientLike): this {
    return this.set('client', client);
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

/** Validates the connection fields and collection name. */
export class MongoDurableStateStoreOptionsValidator
  extends OptionsValidator<MongoDurableStateStoreOptionsType> {
  constructor() { super('MongoDurableStateStoreOptions'); }

  protected rules(s: Partial<MongoDurableStateStoreOptionsType>): void {
    assertMongoUrl('MongoDurableStateStoreOptions', s.url);
    assertMongoName('MongoDurableStateStoreOptions', 'databaseName', s.databaseName);
    assertMongoName('MongoDurableStateStoreOptions', 'collection', s.collection);
  }
}
