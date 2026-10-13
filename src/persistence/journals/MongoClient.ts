import { MAX_TIMER_DELAY_MS } from '../../util/Constants.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import {
  mongoCaFileConflicts,
  mongoUrlKeysNaming,
  readCaFile,
  type MongoTypedOption,
} from './ConnectionStringInspection.js';

/**
 * Minimal shapes of the `mongodb` driver API the MongoDB backends use.  Own
 * interfaces (no `@types`) so the framework stays dependency-free and tests can
 * inject a fake that satisfies just these methods.
 *
 * A real `MongoClient` satisfies `MongoClientLike` structurally.
 *
 * **Driver version matters, and it now depends on the Bun in use.**
 * `mongodb@7`'s bundled `bson` calls
 * `v8.startupSnapshot.isBuildingSnapshot()` at module scope.  Bun did not
 * implement that API until 1.4, so on the version range `engines` still
 * admits — Bun >= 1.3.0 — importing v7 can throw `ERR_NOT_IMPLEMENTED` before
 * any of our code runs.  Measured on 2026-09-10: v7 throws exactly that on
 * Bun 1.3.0 and imports cleanly on 1.4.2, while v6 imports cleanly on both.
 *
 * Hence the peer range `^6 || ^7` rather than a bump: v7 is supported and is
 * what the live suite exercises, but a consumer sitting on the Bun floor has
 * to stay on v6.  The docs say so on the MongoDB page.
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
  /**
   * Extra `MongoClient` options — `{ authSource, readPreference, appName, … }`
   * — handed to the driver as they are.  The driver's whole option surface,
   * so it stays code-only; the pool size, the two timeouts and a CA have typed
   * fields of their own, below, and one of those set here as well is refused
   * rather than left to a precedence nobody would guess.
   */
  readonly clientOptions?: Record<string, unknown>;
  /**
   * Pre-built client — bypasses the lazy `mongodb` import entirely.  Use to
   * share ONE client across the journal, snapshot and durable-state stores (see
   * `registerMongoPlugins`), or to inject a fake in tests.  A `MongoClient` is
   * itself a connection pool, so sharing it is the normal case.
   */
  readonly client?: MongoClientLike;
  /**
   * Most connections the client holds open to one server — the driver's
   * `maxPoolSize`.  Unset leaves the driver's default, 100 in mongodb 6 and 7.
   * HOCON: `max-pool-size`.
   *
   * This and the four fields after it are the settings an operator tunes,
   * typed so they can come from configuration and be checked when the store is
   * built; `clientOptions` stays the code-only long tail.  Each reaches the
   * driver only when set, under the driver's own name.  Setting one beside the
   * same option in `clientOptions` or in the url's query is refused: the
   * driver reads all three case-insensitively, keeps the object's value and
   * drops the url's without a word.  A pre-built `client` bypasses all five,
   * as it bypasses `url`.
   */
  readonly maxPoolSize?: number;
  /**
   * Fewest connections the client keeps open to one server — the driver's
   * `minPoolSize`.  Unset leaves the driver's 0, so nothing is opened ahead of
   * use.  At most `maxPoolSize` when both are set.  HOCON: `min-pool-size`.
   */
  readonly minPoolSize?: number;
  /**
   * How long an operation waits for a server it can use, in milliseconds —
   * the driver's `serverSelectionTimeoutMS`.  Unset leaves the driver's
   * 30 000.  HOCON: `server-selection-timeout`.
   */
  readonly serverSelectionTimeoutMs?: number;
  /**
   * How long opening a connection may take, in milliseconds — the driver's
   * `connectTimeoutMS`.  Unset leaves the driver's 30 000.  HOCON:
   * `connect-timeout`.
   */
  readonly connectTimeoutMs?: number;
  /**
   * Path of a PEM file holding the CA that signed the server's certificate.
   * The store reads it when the client opens and hands its contents to the
   * driver as `ca`, with `tls` switched on, so the server is verified against
   * that CA — the way to reach a deployment behind a private CA without
   * switching verification off.  A path rather than the certificate, so
   * configuration never carries PEM bytes.  HOCON: `ca-file`.
   *
   * Refused beside anything that names another CA or leaves this one unused:
   * a `tlsCAFile` in the url or in `clientOptions` (the driver would drop it
   * for the `ca` without a word), a `ca` in `clientOptions`, a `tls` or `ssl`
   * set to `false` in either, and a `tlsInsecure` or
   * `tlsAllowInvalidCertificates` there that switches verification off.
   */
  readonly caFile?: string;
};

/** Default database name when none is configured. */
export const DEFAULT_MONGO_DATABASE = 'actor_ts';

/** The typed numeric fields of {@link MongoConnection}. */
type MongoTypedField = 'maxPoolSize' | 'minPoolSize' | 'serverSelectionTimeoutMs' | 'connectTimeoutMs';

/** Each typed numeric field, the leaf it is read from, and the driver option it becomes. */
const MONGO_TYPED_OPTIONS: ReadonlyArray<readonly [MongoTypedField, string, MongoTypedOption]> = [
  ['maxPoolSize', 'max-pool-size', 'maxPoolSize'],
  ['minPoolSize', 'min-pool-size', 'minPoolSize'],
  ['serverSelectionTimeoutMs', 'server-selection-timeout', 'serverSelectionTimeoutMS'],
  ['connectTimeoutMs', 'connect-timeout', 'connectTimeoutMS'],
];

/**
 * The client rules the three MongoDB stores share.  Each store's validator
 * extends this and calls {@link checkClient} from its `rules`, so the journal,
 * the snapshot store and the durable-state store refuse the same
 * combinations; it sits beside {@link MongoConnection} because that is the
 * shape it checks.
 *
 * A setting may be made in one place.  The driver reads `clientOptions` and
 * the url's query alike, case-insensitively, and where both carry an option
 * it keeps the object's value and drops the url's without a word (mongodb 7.6
 * connection_string.js:252-263, 436-466; 6.21 the same) — so a typed field
 * beside the same option in either is refused rather than given a
 * precedence, and found the way the driver finds it.  A CA file is refused
 * beside anything that names another CA or leaves it unused.  The two
 * timeouts are bounded above by {@link MAX_TIMER_DELAY_MS}: the driver arms
 * server selection as a timer and the connect timeout on the socket, and a
 * timer asked for longer fires at once.
 */
export abstract class MongoOptionsValidatorBase<T extends MongoConnection> extends OptionsValidator<T> {
  protected checkClient(s: Partial<T>): void {
    this.positiveInt('maxPoolSize' as never);
    this.nonNegativeInt('minPoolSize' as never);
    if (s.minPoolSize !== undefined && s.maxPoolSize !== undefined && s.minPoolSize > s.maxPoolSize) {
      this.fail(
        'minPoolSize',
        `(the min-pool-size leaf) must not exceed maxPoolSize (${s.maxPoolSize}): the driver refuses such a pool, `
        + 'but only once it connects',
        s.minPoolSize,
      );
    }
    this.timerDelay('serverSelectionTimeoutMs', s.serverSelectionTimeoutMs);
    this.timerDelay('connectTimeoutMs', s.connectTimeoutMs);
    this.nonEmptyString('caFile' as never);

    const clientOptions: Readonly<Record<string, unknown>> = s.clientOptions ?? {};
    for (const [field, leaf, option] of MONGO_TYPED_OPTIONS) {
      if (s[field] === undefined) continue;
      const inClientOptions = clientOptionKey(clientOptions, option);
      if (inClientOptions !== undefined) {
        this.fail(
          field,
          `(the ${leaf} leaf) and clientOptions.${inClientOptions} both set the driver's ${option} — set it in one place`,
        );
      }
      const inUrl = s.url === undefined ? [] : mongoUrlKeysNaming(s.url, option);
      if (inUrl.length > 0) {
        this.fail(
          field,
          `(the ${leaf} leaf) and the url's ${inUrl.join(', ')} both set the driver's ${option}, and the driver `
          + 'would keep the field and drop the url\'s without a word — set it in one place',
        );
      }
    }

    if (s.caFile !== undefined) {
      const inUrl = s.url === undefined ? [] : mongoCaFileConflicts(s.url);
      if (inUrl.length > 0) {
        this.fail(
          'caFile',
          `(the ca-file leaf) is set beside the url's ${inUrl.join(', ')}, which names another CA or leaves this `
          + 'one unused — set TLS in one place',
        );
      }
      this.checkCaFileAgainstClientOptions(clientOptions);
    }
  }

  /**
   * `buildMongoResource` lays the CA, with `tls` on, over `clientOptions`;
   * anything there that names another CA or leaves this one unused would
   * contradict `caFile` and is refused instead of overridden.  A `tls` or
   * `ssl` of `true` agrees with it and stays.
   */
  private checkCaFileAgainstClientOptions(clientOptions: Readonly<Record<string, unknown>>): void {
    const conflicts: string[] = [];
    for (const option of ['ca', 'tlsCAFile']) {
      const key = clientOptionKey(clientOptions, option);
      if (key !== undefined) conflicts.push(`clientOptions.${key} names a CA already`);
    }
    for (const option of ['tls', 'ssl']) {
      const key = clientOptionKey(clientOptions, option);
      if (key !== undefined && isFalse(clientOptions[key])) {
        conflicts.push(`clientOptions.${key} switches TLS off, which leaves the CA unused`);
      }
    }
    for (const option of ['tlsInsecure', 'tlsAllowInvalidCertificates']) {
      const key = clientOptionKey(clientOptions, option);
      if (key !== undefined && !isFalse(clientOptions[key])) {
        conflicts.push(`clientOptions.${key} switches certificate verification off, which leaves the CA unused`);
      }
    }
    if (conflicts.length > 0) {
      this.fail('caFile', `(the ca-file leaf) contradicts clientOptions: ${conflicts.join('; ')} — set TLS in one place`);
    }
  }

  private timerDelay(field: 'serverSelectionTimeoutMs' | 'connectTimeoutMs', value: number | undefined): void {
    this.positiveInt(field as never);
    if (value !== undefined && value > MAX_TIMER_DELAY_MS) {
      this.fail(field, `must be at most ${MAX_TIMER_DELAY_MS} ms: the driver arms it as a timer, and a longer one fires at once`, value);
    }
  }
}

/**
 * The key of `clientOptions` that sets `option`, as the object spells it, or
 * `undefined`.  Matched as the driver matches it — case-insensitively, and
 * only when the value is neither `null` nor `undefined`, which the driver
 * drops before it reads any option.
 */
function clientOptionKey(clientOptions: Readonly<Record<string, unknown>>, option: string): string | undefined {
  const wanted = option.toLowerCase();
  return Object.keys(clientOptions).find((key) => key.toLowerCase() === wanted
    && clientOptions[key] !== undefined && clientOptions[key] !== null);
}

/** `false`, or the string the driver reads as false. */
function isFalse(value: unknown): boolean {
  return value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false');
}

/**
 * The options `buildMongoResource` hands the driver: `clientOptions` exactly
 * as given when no typed field is set, and otherwise a copy with each typed
 * field laid over it under the driver's own name, only when set — so an unset
 * field leaves the driver's default in force rather than one this module
 * would have to keep in step with it, and the caller's object is never
 * written to.  Every store runs its validator before this, which refuses a
 * typed field beside the same option there, so laying one over overrides
 * nothing.
 */
function mongoClientOptionsOf(connection: MongoConnection, ca: string | undefined): Record<string, unknown> | undefined {
  const typed: Record<string, unknown> = {};
  for (const [field, , option] of MONGO_TYPED_OPTIONS) {
    const value = connection[field];
    if (value !== undefined) typed[option] = value;
  }
  if (ca !== undefined) {
    typed['tls'] = true;
    typed['ca'] = ca;
  }
  if (Object.keys(typed).length === 0) return connection.clientOptions;
  return { ...connection.clientOptions, ...typed };
}

/** Build (or pass through) the client and database handle for a store. */
export async function buildMongoResource(connection: MongoConnection): Promise<MongoResource> {
  const databaseName = connection.databaseName ?? DEFAULT_MONGO_DATABASE;
  if (connection.client) {
    return { client: connection.client, database: connection.client.db(databaseName) };
  }
  if (connection.url === undefined) {
    throw new Error('MongoDB persistence requires either `url` or a pre-built `client`.');
  }
  // Read when the client opens rather than at construction, so building a
  // store stays free of I/O; a failure names the field, the leaf and the path.
  const ca = connection.caFile === undefined ? undefined : await readCaFile(connection.caFile, 'MongoConnection');
  const mongo = await mongoLazy.get();
  const client = new mongo.MongoClient(connection.url, mongoClientOptionsOf(connection, ca));
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
