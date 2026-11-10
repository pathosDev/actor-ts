import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { Serializer } from '../../serialization/Serializer.js';
import {
  readStoreBoolean,
  readStoreDuration,
  readStoreIdentifier,
  readStoreInt,
  readStoreString,
  storeLeaf,
} from '../StoreConfig.js';
import { readStoreUrl } from './ConnectionStringInspection.js';
import type { MongoClientLike, MongoConnection } from './MongoClient.js';
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
  /** Pool size applied to every store that does not set its own — see `MongoConnection.maxPoolSize`. */
  readonly maxPoolSize?: number;
  /** Minimum pool size applied to every store that does not set its own — see `MongoConnection.minPoolSize`. */
  readonly minPoolSize?: number;
  /** Server-selection timeout in ms applied to every store that does not set its own — see `MongoConnection.serverSelectionTimeoutMs`. */
  readonly serverSelectionTimeoutMs?: number;
  /** Connect timeout in ms applied to every store that does not set its own — see `MongoConnection.connectTimeoutMs`. */
  readonly connectTimeoutMs?: number;
  /** CA file applied to every store that does not set its own — see `MongoConnection.caFile`. */
  readonly caFile?: string;
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

  /** Pool size applied to every store that does not set its own. */
  withMaxPoolSize(maxPoolSize: number): this {
    return this.set('maxPoolSize', maxPoolSize);
  }

  /** Minimum pool size applied to every store that does not set its own. */
  withMinPoolSize(minPoolSize: number): this {
    return this.set('minPoolSize', minPoolSize);
  }

  /** Server-selection timeout in ms applied to every store that does not set its own. */
  withServerSelectionTimeoutMs(serverSelectionTimeoutMs: number): this {
    return this.set('serverSelectionTimeoutMs', serverSelectionTimeoutMs);
  }

  /** Connect timeout in ms applied to every store that does not set its own. */
  withConnectTimeoutMs(connectTimeoutMs: number): this {
    return this.set('connectTimeoutMs', connectTimeoutMs);
  }

  /** CA file applied to every store that does not set its own. */
  withCaFile(caFile: string): this {
    return this.set('caFile', caFile);
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
 * HOCON spelling and deliberately no leaf.  `clientOptions` is absent for
 * another reason: it is the driver's whole option surface, free-form and
 * unvalidated, so it stays the code-only long tail.  What an operator does
 * tune on the client has typed leaves instead — `max-pool-size`,
 * `min-pool-size`, `server-selection-timeout`, `connect-timeout` and
 * `ca-file`, read by {@link readMongoClientSettings} and checked by the store's
 * validator when it is built (#1490).
 *
 * `url` uses the `""`-means-unset idiom while the three name leaves do not:
 * an empty connection string handed to `MongoClient` is a mistake the driver
 * reports far from its cause, whereas an empty collection name reaches
 * `assertMongoName`, which refuses it by name at construction.
 *
 * `url` is also inspected: `tlsInsecure`, `tlsAllowInvalidCertificates` or
 * `tlsAllowInvalidHostnames` set to anything but `false` is refused with a
 * `ConfigError` naming the leaf (#1490), and `withUrl(...)` in code is not
 * inspected.  A private CA needs no code here: the url names its file with
 * `tlsCAFile`, which the driver reads, or the block's `ca-file` leaf names it
 * beside the url, which the store reads — one or the other, never both.
 */
export function readMongoJournalOptionsFromConfig(
  config: Config,
  blockRoot: string = ConfigKeys.persistence.journal.mongodb.root,
): Partial<MongoJournalOptionsType> {
  if (!config.hasPath(blockRoot)) return {};
  const keys = ConfigKeys.persistence.journal.mongodb;
  const at = (canonicalLeafPath: string): string => storeLeaf(blockRoot, keys.root, canonicalLeafPath);
  const out: { -readonly [K in keyof MongoJournalOptionsType]?: MongoJournalOptionsType[K] } =
    readMongoClientSettings(config, at, keys);
  const url = readStoreUrl(config, at(keys.url), 'mongodb');
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
  } = readMongoClientSettings(config, at, keys);
  const url = readStoreUrl(config, at(keys.url), 'mongodb');
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
  } = readMongoClientSettings(config, at, keys);
  const url = readStoreUrl(config, at(keys.url), 'mongodb');
  if (url !== undefined) out.url = url;
  const databaseName = readStoreIdentifier(config, at(keys.databaseName));
  if (databaseName !== undefined) out.databaseName = databaseName;
  const collection = readStoreIdentifier(config, at(keys.collection));
  if (collection !== undefined) out.collection = collection;
  return out;
}

/** The client leaves every MongoDB block spells the same way, under its own root. */
type MongoClientKeys = {
  readonly maxPoolSize: string;
  readonly minPoolSize: string;
  readonly serverSelectionTimeout: string;
  readonly connectTimeout: string;
  readonly caFile: string;
};

/**
 * The client half the three MongoDB readers share.  One function rather than
 * three copies because the leaves are the same five under every root; each
 * reader passes its own `keys`, so a block is still read from its own root and
 * nowhere else.  The two durations are read as milliseconds, so
 * `connect-timeout = 5s` arrives as `connectTimeoutMs: 5000`.  `ca-file` is
 * read as the path it is: the store opens the file when the client opens.
 */
function readMongoClientSettings(
  config: Config,
  at: (canonicalLeafPath: string) => string,
  keys: MongoClientKeys,
): { -readonly [K in keyof MongoConnection]?: MongoConnection[K] } {
  const out: { -readonly [K in keyof MongoConnection]?: MongoConnection[K] } = {};
  const maxPoolSize = readStoreInt(config, at(keys.maxPoolSize));
  if (maxPoolSize !== undefined) out.maxPoolSize = maxPoolSize;
  const minPoolSize = readStoreInt(config, at(keys.minPoolSize));
  if (minPoolSize !== undefined) out.minPoolSize = minPoolSize;
  const serverSelectionTimeoutMs = readStoreDuration(config, at(keys.serverSelectionTimeout));
  if (serverSelectionTimeoutMs !== undefined) out.serverSelectionTimeoutMs = serverSelectionTimeoutMs;
  const connectTimeoutMs = readStoreDuration(config, at(keys.connectTimeout));
  if (connectTimeoutMs !== undefined) out.connectTimeoutMs = connectTimeoutMs;
  const caFile = readStoreString(config, at(keys.caFile));
  if (caFile !== undefined) out.caFile = caFile;
  return out;
}
