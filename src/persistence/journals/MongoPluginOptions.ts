import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Serializer } from '../../serialization/Serializer.js';
import {
  readStoreBoolean,
  readStoreIdentifier,
  readStoreInt,
  readStoreString,
  storeLeaf,
} from '../StoreConfig.js';
import type { MongoClientLike } from './MongoClient.js';
import type { MongoJournalOptions, MongoJournalOptionsType } from './MongoJournalOptions.js';
import type {
  MongoSnapshotStoreOptions,
  MongoSnapshotStoreOptionsType,
} from '../snapshot-stores/MongoSnapshotStoreOptions.js';
import type {
  MongoDurableStateStoreOptions,
  MongoDurableStateStoreOptionsType,
} from '../durable-state-stores/MongoDurableStateStoreOptions.js';

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

/**
 * Read the MongoDB journal's block — `actor-ts.persistence.journal.mongodb` by
 * default, or whichever id the plug-in was registered under (#872).
 *
 * The readers live here, beside the plug-in's own options, rather than in each
 * store's `XOptions.ts`, for the reason `PostgresPluginOptions.ts` places
 * theirs the same way: the *plug-in* is what reads configuration.  A store
 * constructed directly stays constructor-only, which is what keeps
 * `new MongoJournal({...})` a pure function of its argument in a test.
 *
 * `client` and `serializer` are absent by construction — live objects have no
 * HOCON spelling and deliberately no leaf.  `clientOptions` is absent for the
 * other reason: free-form driver config with no enumerable leaf set and no
 * default, so it stays code-only rather than becoming a block whose contents
 * nothing validates.
 *
 * `url` uses the `""`-means-unset idiom while the three name leaves do not:
 * an empty connection string handed to `MongoClient` is a mistake the driver
 * reports far from its cause, whereas an empty collection name reaches
 * `assertMongoName`, which refuses it by name at construction.
 */
export function readMongoJournalOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.journal.mongodb.root,
): Partial<MongoJournalOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.journal.mongodb;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: { -readonly [K in keyof MongoJournalOptionsType]?: MongoJournalOptionsType[K] } = {};
  const url = readStoreString(config, at(keys.url));
  if (url !== undefined) out.url = url;
  const databaseName = readStoreIdentifier(config, at(keys.databaseName));
  if (databaseName !== undefined) out.databaseName = databaseName;
  const eventsCollection = readStoreIdentifier(config, at(keys.eventsCollection));
  if (eventsCollection !== undefined) out.eventsCollection = eventsCollection;
  const autoCreateIndexes = readStoreBoolean(config, at(keys.autoCreateIndexes));
  if (autoCreateIndexes !== undefined) out.autoCreateIndexes = autoCreateIndexes;
  return out;
}

/** Read the MongoDB snapshot store's block — see {@link readMongoJournalOptionsFromConfig}. */
export function readMongoSnapshotStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.snapshotStore.mongodb.root,
): Partial<MongoSnapshotStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.snapshotStore.mongodb;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof MongoSnapshotStoreOptionsType]?: MongoSnapshotStoreOptionsType[K]
  } = {};
  const url = readStoreString(config, at(keys.url));
  if (url !== undefined) out.url = url;
  const databaseName = readStoreIdentifier(config, at(keys.databaseName));
  if (databaseName !== undefined) out.databaseName = databaseName;
  const snapshotsCollection = readStoreIdentifier(config, at(keys.snapshotsCollection));
  if (snapshotsCollection !== undefined) out.snapshotsCollection = snapshotsCollection;
  const keepN = readStoreInt(config, at(keys.keepN));
  if (keepN !== undefined) out.keepN = keepN;
  const autoCreateIndexes = readStoreBoolean(config, at(keys.autoCreateIndexes));
  if (autoCreateIndexes !== undefined) out.autoCreateIndexes = autoCreateIndexes;
  return out;
}

/** Read the MongoDB durable-state store's block — see {@link readMongoJournalOptionsFromConfig}. */
export function readMongoDurableStateStoreOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.durableState.mongodb.root,
): Partial<MongoDurableStateStoreOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.durableState.mongodb;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: {
    -readonly [K in keyof MongoDurableStateStoreOptionsType]?: MongoDurableStateStoreOptionsType[K]
  } = {};
  const url = readStoreString(config, at(keys.url));
  if (url !== undefined) out.url = url;
  const databaseName = readStoreIdentifier(config, at(keys.databaseName));
  if (databaseName !== undefined) out.databaseName = databaseName;
  const collection = readStoreIdentifier(config, at(keys.collection));
  if (collection !== undefined) out.collection = collection;
  return out;
}
