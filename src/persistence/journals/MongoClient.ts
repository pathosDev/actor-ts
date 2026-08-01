import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';

/**
 * Minimal shapes of the `mongodb` driver API the MongoDB backends use.  Own
 * interfaces (no `@types`) so the framework stays dependency-free and tests can
 * inject a fake that satisfies just these methods.
 *
 * A real `MongoClient` satisfies `MongoClientLike` structurally.
 *
 * **Driver version matters.** The peer range is pinned to `mongodb@^6` on
 * purpose: `mongodb@7`'s bundled `bson` calls
 * `v8.startupSnapshot.isBuildingSnapshot()` at module scope, which Bun does not
 * implement — so importing it throws `ERR_NOT_IMPLEMENTED` on Bun, the
 * project's primary runtime, before any of our code runs.  Version 6 imports
 * cleanly on Bun, Node and Deno alike.
 */

/** A BSON document, keyed by field name. */
export type MongoDocument = Record<string, unknown>;

/** Sort / index specification: field → ascending (1) or descending (-1). */
export type MongoSortSpec = Record<string, 1 | -1>;

export interface MongoCursorLike<TDocument> {
  sort(spec: MongoSortSpec): MongoCursorLike<TDocument>;
  limit(count: number): MongoCursorLike<TDocument>;
  skip(count: number): MongoCursorLike<TDocument>;
  toArray(): Promise<TDocument[]>;
}

export type MongoUpdateResult = {
  readonly matchedCount: number;
  readonly modifiedCount: number;
  readonly upsertedCount: number;
};

export type MongoDeleteResult = {
  readonly deletedCount: number;
};

export interface MongoCollectionLike<TDocument extends MongoDocument = MongoDocument> {
  /** With `ordered: true` the driver stops at the first failing document. */
  insertMany(documents: ReadonlyArray<TDocument>, options?: { ordered?: boolean }): Promise<unknown>;
  insertOne(document: TDocument): Promise<unknown>;
  find(filter: MongoDocument): MongoCursorLike<TDocument>;
  findOne(filter: MongoDocument): Promise<TDocument | null>;
  updateOne(
    filter: MongoDocument,
    update: MongoDocument,
    options?: { upsert?: boolean },
  ): Promise<MongoUpdateResult>;
  deleteMany(filter: MongoDocument): Promise<MongoDeleteResult>;
  deleteOne(filter: MongoDocument): Promise<MongoDeleteResult>;
  distinct(field: string): Promise<unknown[]>;
  createIndex(spec: MongoSortSpec, options?: { unique?: boolean; name?: string }): Promise<string>;
}

export interface MongoDatabaseLike {
  collection<TDocument extends MongoDocument = MongoDocument>(
    name: string,
  ): MongoCollectionLike<TDocument>;
}

export interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name?: string): MongoDatabaseLike;
  close(): Promise<void>;
}

/** What a MongoDB store holds open: the database handle plus the client that owns it. */
export type MongoResource = {
  readonly database: MongoDatabaseLike;
  readonly client: MongoClientLike;
};

type MongoModule = {
  MongoClient: new (url: string, options?: Record<string, unknown>) => MongoClientLike;
};

const mongoLazy: Lazy<Promise<MongoModule>> = Lazy.of(
  () => lazyImportModule<MongoModule>('mongodb', {
    context: 'The MongoDB persistence backends',
    installHint: 'npm install mongodb@^6',
  }),
);

/** Connection options shared by all three MongoDB stores. */
export type MongoConnection = {
  /**
   * Connection string, e.g. `mongodb://user:pass@host:27017` or
   * `mongodb+srv://cluster.example.mongodb.net`.  Required unless `client` is
   * supplied.
   */
  readonly url?: string;
  /**
   * Database name.  Default `actor_ts`.  A database in the URL path is only
   * used by the driver for auth, so the name is stated separately.
   */
  readonly databaseName?: string;
  /** Extra `MongoClient` options — `{ tls, authSource, maxPoolSize, … }`. */
  readonly clientOptions?: Record<string, unknown>;
  /**
   * Pre-built client — bypasses the lazy `mongodb` import entirely.  Use to
   * share ONE client across the journal, snapshot and durable-state stores (see
   * `registerMongoPlugins`), or to inject a fake in tests.  A `MongoClient` is
   * itself a connection pool, so sharing it is the normal case.
   */
  readonly client?: MongoClientLike;
};

/** Default database name when none is configured. */
export const DEFAULT_MONGO_DATABASE = 'actor_ts';

/** Build (or pass through) the client and database handle for a store. */
export async function buildMongoResource(connection: MongoConnection): Promise<MongoResource> {
  const databaseName = connection.databaseName ?? DEFAULT_MONGO_DATABASE;
  if (connection.client) {
    return { client: connection.client, database: connection.client.db(databaseName) };
  }
  if (connection.url === undefined) {
    throw new Error('MongoDB persistence requires either `url` or a pre-built `client`.');
  }
  const mongo = await mongoLazy.get();
  const client = new mongo.MongoClient(connection.url, connection.clientOptions);
  // `connect()` is what opens the sockets, so a store's first operation fails
  // loudly rather than hanging on a bad URL.
  await client.connect();
  return { client, database: client.db(databaseName) };
}

/**
 * MongoDB duplicate-key error — server code **11000**.
 *
 * This is the MongoDB analogue of SQLSTATE `23505`, and it is what makes the
 * journal's optimistic concurrency sound: the unique compound index on
 * `(persistenceId, sequenceNr)` rejects a racing writer, and this predicate
 * turns that rejection into a `JournalConcurrencyError`.
 *
 * A failed `insertMany` arrives as a bulk-write error whose per-document
 * `writeErrors` carry the code, so those are checked too.
 */
export function isMongoDuplicateKeyError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    writeErrors?: ReadonlyArray<{ code?: unknown; err?: { code?: unknown } }>;
  };
  if (candidate.code === 11000) return true;
  if (Array.isArray(candidate.writeErrors)) {
    for (const writeError of candidate.writeErrors) {
      if (writeError?.code === 11000 || writeError?.err?.code === 11000) return true;
    }
  }
  // Last resort for drivers or proxies that forward only the message text.
  return typeof candidate.message === 'string' && /\bE11000\b/.test(candidate.message);
}

/** Test hook — reset the cached lazy `mongodb` import. */
export function resetMongoModuleCache(): void {
  mongoLazy.reset();
}
