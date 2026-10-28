import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MAX_TIMER_DELAY_MS } from '../../../src/util/Constants.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  DYNAMODB_DURABLE_STATE_PLUGIN_ID,
  DYNAMODB_JOURNAL_PLUGIN_ID,
  DYNAMODB_SNAPSHOT_PLUGIN_ID,
  DynamoDbDurableStateStore,
  DynamoDbJournal,
  DynamoDbJournalOptions,
  DynamoDbSnapshotStore,
  MONGO_DURABLE_STATE_PLUGIN_ID,
  MONGO_JOURNAL_PLUGIN_ID,
  MONGO_SNAPSHOT_PLUGIN_ID,
  MongoDurableStateStore,
  MongoJournal,
  MongoJournalOptions,
  MongoSnapshotStore,
  PersistenceExtensionId,
  RegisterDynamoDbPluginsOptions,
  RegisterMongoPluginsOptions,
  registerDynamoDbPlugins,
  registerMongoPlugins,
} from '../../../src/persistence/index.js';
import {
  buildDynamoDbOperations,
  resetDynamoDbSdkCache,
  type DynamoDbConnection,
  type DynamoDbOperations,
} from '../../../src/persistence/journals/DynamoDbClient.js';
import {
  buildMongoResource,
  resetMongoModuleCache,
  type MongoClientLike,
  type MongoConnection,
} from '../../../src/persistence/journals/MongoClient.js';
import { mongoCaFileConflicts, mongoUrlKeysNaming } from '../../../src/persistence/journals/ConnectionStringInspection.js';

/**
 * What the MongoDB and DynamoDB stores hand their client driver, and what they
 * refuse to hand it (#1490).
 *
 * A store's client is configured from up to three places — its connection
 * (a MongoDB `url`, a DynamoDB `region`), a free-form object written in code
 * (`clientOptions`, `clientConfig`), and the typed client fields an operator
 * can also set from HOCON — and each driver merges the first two by a rule of
 * its own.  The MongoDB driver reads the url's query and `clientOptions` alike,
 * case-insensitively, and keeps the object's value, dropping the url's without
 * a word (mongodb 7.6 connection_string.js:252-263, 436-466; 6.21 the same);
 * the AWS SDK takes `clientConfig`'s own keys verbatim, and a `retryStrategy`
 * there makes `maxAttempts` and `retryMode` moot.  The typed fields reach the
 * driver under its own names and only when set; where a combination would
 * silently drop one side, the store refuses it at construction with an
 * `OptionsError` naming both sides, before anything connects.
 *
 * Neither driver is installed in this repository — their coverage against a
 * live server is the broker suites under `tests/integration/brokers/` — so each
 * is replaced here by a stand-in that records what it is handed.  The stores
 * import their driver lazily, on first use, so installing the stand-in before
 * that use is enough; `resetMongoModuleCache` and `resetDynamoDbSdkCache` drop
 * a cached import so every test resolves the stand-in afresh.
 */

/* -------------------------------- stand-ins -------------------------------- */

/** Every `(url, options)` a stand-in `MongoClient` was constructed with, in order. */
const mongoClientArguments: Array<{ readonly url: string; readonly options: Record<string, unknown> | undefined }> = [];

/** A collection as far as a store's start reaches into it: index creation. */
const standInCollection = {
  createIndex: async (): Promise<string> => 'index',
};

/** Every command a stand-in database was sent, in order — the open's ping among them. */
const mongoCommands: Array<Record<string, unknown>> = [];
/** Set to make every stand-in command reject with it: a deployment that refuses the ping. */
let mongoCommandRefusal: Error | null = null;
/** How many stand-in clients were closed. */
let mongoClientCloses = 0;

/** A database as far as a store's start reaches into it: its collections and the ping. */
const standInDatabase = {
  collection: () => standInCollection,
  command: async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
    mongoCommands.push(command);
    if (mongoCommandRefusal !== null) throw mongoCommandRefusal;
    return { ok: 1 };
  },
};

/** The mongodb driver's `MongoClient`, as far as a store reaches into it. */
class StandInMongoClient {
  constructor(url: string, options?: Record<string, unknown>) {
    mongoClientArguments.push({ url, options });
  }

  async connect(): Promise<this> {
    return this;
  }

  db(): typeof standInDatabase {
    return standInDatabase;
  }

  async close(): Promise<void> {
    mongoClientCloses++;
  }
}

/**
 * What a specifier resolved to before a stand-in replaced it — a plain copy,
 * because a module mock rewrites the namespace in place.  `undefined` when the
 * driver is not installed, which is the state of this repository.
 */
async function snapshotOf(specifier: string): Promise<Record<string, unknown> | undefined> {
  try {
    return { ...((await import(specifier)) as Record<string, unknown>) };
  } catch {
    return undefined;
  }
}

/** Every config a stand-in `DynamoDBClient` was constructed with, in order. */
const dynamoDbClientConfigs: Array<Record<string, unknown>> = [];
/** Every table a stand-in client was sent a `DescribeTable` for, in order. */
const dynamoDbDescribedTables: string[] = [];

/** The SDK's `DescribeTableCommand`: what a store's open sends with auto-create-tables off (#1473). */
class StandInDescribeTableCommand {
  constructor(readonly input: Record<string, unknown>) {}
}

/**
 * The AWS SDK's `DynamoDBClient`, as far as building the operations façade
 * reaches into it: the adapter constructs a command only when an operation
 * runs, and the only one these tests run is the `DescribeTable` a store's
 * open sends, which finds the table active.
 */
class StandInDynamoDbClient {
  constructor(config: Record<string, unknown>) {
    dynamoDbClientConfigs.push(config);
  }

  async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof StandInDescribeTableCommand) {
      dynamoDbDescribedTables.push(String(command.input['TableName']));
      return { Table: { TableStatus: 'ACTIVE' } };
    }
    return {};
  }

  destroy(): void {}
}

const realMongo = await snapshotOf('mongodb');
const realDynamoDb = await snapshotOf('@aws-sdk/client-dynamodb');
mock.module('mongodb', () => ({ MongoClient: StandInMongoClient }));
mock.module('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: StandInDynamoDbClient,
  DescribeTableCommand: StandInDescribeTableCommand,
}));

beforeEach(() => {
  mongoClientArguments.length = 0;
  mongoCommands.length = 0;
  mongoCommandRefusal = null;
  mongoClientCloses = 0;
  dynamoDbClientConfigs.length = 0;
  dynamoDbDescribedTables.length = 0;
  resetMongoModuleCache();
  resetDynamoDbSdkCache();
});

afterAll(() => {
  // A module mock is process-wide and outlives `mock.restore()`, so it is put
  // back by hand.  A driver that was never installed cannot be put back as
  // missing — bun evaluates a factory when it is registered, so one that throws
  // throws out of `mock.module` itself — and the nearest state is a module
  // whose entry point is gone, which a later store fails on at first use
  // instead of reaching this file's stand-in.
  mock.module('mongodb', () => realMongo ?? { MongoClient: undefined });
  mock.module('@aws-sdk/client-dynamodb', () => realDynamoDb ?? { DynamoDBClient: undefined });
  resetMongoModuleCache();
  resetDynamoDbSdkCache();
});

/* ------------------------------ scratch files ------------------------------ */

const scratch = mkdtempSync(join(tmpdir(), 'client-driver-leaves-'));
afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

/** A CA file in the shape a managed deployment publishes, with stand-in bytes. */
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIBstandin\n-----END CERTIFICATE-----\n';
const caPath = join(scratch, 'atlas-ca.pem');
writeFileSync(caPath, CA_PEM);
const notPemPath = join(scratch, 'not-a-certificate.txt');
writeFileSync(notPemPath, 'host=mongo.internal\n');
const missingPath = join(scratch, 'no-such-ca.pem');

/* --------------------------------- helpers --------------------------------- */

/** Build `construct()`, expecting an `OptionsError`, and return it. */
function refusal(construct: () => unknown): OptionsError {
  let caught: unknown;
  try {
    construct();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the options were accepted').toBeInstanceOf(OptionsError);
  return caught as OptionsError;
}

/** Await `operation`, expecting it to reject with an `OptionsError`, and return it. */
async function rejection(operation: () => Promise<unknown>): Promise<OptionsError> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the operation succeeded').toBeInstanceOf(OptionsError);
  return caught as OptionsError;
}

/** A store as these tests drive it: built, then opened — its first use. */
interface StartableStore {
  start(): Promise<void>;
}

type MongoStoreCase = {
  readonly name: string;
  readonly build: (options: MongoConnection) => StartableStore;
};

const mongoStores: MongoStoreCase[] = [
  { name: 'MongoJournal', build: (options) => new MongoJournal(options) },
  { name: 'MongoSnapshotStore', build: (options) => new MongoSnapshotStore(options) },
  { name: 'MongoDurableStateStore', build: (options) => new MongoDurableStateStore(options) },
];

const MONGO_URL = 'mongodb://mongo.internal:27017/app';

/** The four typed numeric fields, the leaf each is read from, and the option the driver reads. */
const MONGO_NUMERIC_FIELDS = [
  { field: 'maxPoolSize', leaf: 'max-pool-size', option: 'maxPoolSize', value: 20 },
  { field: 'minPoolSize', leaf: 'min-pool-size', option: 'minPoolSize', value: 2 },
  { field: 'serverSelectionTimeoutMs', leaf: 'server-selection-timeout', option: 'serverSelectionTimeoutMS', value: 5_000 },
  { field: 'connectTimeoutMs', leaf: 'connect-timeout', option: 'connectTimeoutMS', value: 3_000 },
] as const;

/* --------------------------------- MongoDB --------------------------------- */

describe('MongoDB: the typed client fields reach MongoClient under its own names', () => {
  test('nothing typed is set, so the driver is handed clientOptions exactly as before', async () => {
    await buildMongoResource({ url: MONGO_URL });
    await buildMongoResource({ url: MONGO_URL, clientOptions: { authSource: 'admin' } });

    expect(mongoClientArguments).toStrictEqual([
      { url: MONGO_URL, options: undefined },
      { url: MONGO_URL, options: { authSource: 'admin' } },
    ]);
  });

  test('each field set reaches the client as the option the driver reads', async () => {
    await buildMongoResource({
      url: MONGO_URL,
      maxPoolSize: 20,
      minPoolSize: 2,
      serverSelectionTimeoutMs: 5_000,
      connectTimeoutMs: 3_000,
      caFile: caPath,
    });

    // toStrictEqual, not toEqual: the latter ignores a key whose value is
    // undefined, so it would pass a builder that hands the driver
    // `maxPoolSize: undefined` — which the driver reads as unset today and a
    // stricter release need not.
    expect(mongoClientArguments).toStrictEqual([{
      url: MONGO_URL,
      options: {
        maxPoolSize: 20,
        minPoolSize: 2,
        serverSelectionTimeoutMS: 5_000,
        connectTimeoutMS: 3_000,
        tls: true,
        ca: CA_PEM,
      },
    }]);
  });

  test('one field set is one option, and the rest of clientOptions stays as written', async () => {
    const clientOptions = { appName: 'ledger', authSource: 'admin' };
    await buildMongoResource({ url: MONGO_URL, clientOptions, minPoolSize: 1 });

    expect(mongoClientArguments[0]!.options).toStrictEqual({ appName: 'ledger', authSource: 'admin', minPoolSize: 1 });
    // The caller's object is copied, never written to.
    expect(clientOptions).toStrictEqual({ appName: 'ledger', authSource: 'admin' });
  });

  test('a clientOptions key the driver reads as unset leaves the typed field in force', async () => {
    // The validator takes such a key beside the typed field, so the field has
    // to be laid over clientOptions rather than under it: the other way round,
    // `maxPoolSize: undefined` would reach the driver, which drops it, and the
    // typed 20 would be gone with it.
    await buildMongoResource({ url: MONGO_URL, maxPoolSize: 20, clientOptions: { maxPoolSize: undefined } });
    await buildMongoResource({ url: MONGO_URL, connectTimeoutMs: 3_000, clientOptions: { connectTimeoutMS: null } });

    expect(mongoClientArguments).toStrictEqual([
      { url: MONGO_URL, options: { maxPoolSize: 20 } },
      { url: MONGO_URL, options: { connectTimeoutMS: 3_000 } },
    ]);
  });

  test('tls: true in clientOptions stays, and the CA joins it', async () => {
    await buildMongoResource({ url: MONGO_URL, clientOptions: { tls: true }, caFile: caPath });

    expect(mongoClientArguments[0]!.options).toStrictEqual({ tls: true, ca: CA_PEM });
  });

  test('a pre-built client bypasses the typed fields, as it bypasses url', async () => {
    const client: MongoClientLike = new StandInMongoClient('mongodb://shared', undefined) as unknown as MongoClientLike;
    mongoClientArguments.length = 0;

    const resource = await buildMongoResource({ client, maxPoolSize: 5, caFile: missingPath });

    expect(resource.client).toBe(client);
    // Nothing was constructed and the CA file was not read: a missing one would have thrown.
    // A store never gets this far with a CA file beside a client — it refuses
    // the pair when it is built, below — so this is the open's own behaviour.
    expect(mongoClientArguments).toEqual([]);
  });
});

describe('MongoDB: ca-file is read by the framework when the client opens', () => {
  test.each(mongoStores)('$name builds without touching the file and fails first use naming it', async ({ build }) => {
    // Construction stays free of I/O; the store's first operation is what
    // opens the client, and that is where an unreadable file has to surface.
    const store = build({ url: MONGO_URL, caFile: missingPath });

    const error = await rejection(() => store.start());
    expect(error.field).toBe('caFile');
    expect(error.message).toContain('caFile');
    expect(error.message).toContain('ca-file');
    expect(error.message).toContain(missingPath);
    expect(mongoClientArguments).toEqual([]);
  });

  test('a file that holds no PEM certificate is refused, and its contents are not quoted', async () => {
    const error = await rejection(() => buildMongoResource({ url: MONGO_URL, caFile: notPemPath }));

    expect(error.message).toContain(notPemPath);
    expect(error.message).toContain('no PEM certificate');
    expect(error.message).not.toContain('mongo.internal');
    expect(mongoClientArguments).toEqual([]);
  });
});

describe('MongoDB: a store pings through the client it built when it opens (#1473)', () => {
  test.each(mongoStores)('$name sends one ping, and a second start() sends no other', async ({ build }) => {
    const store = build({ url: MONGO_URL });

    await store.start();
    await store.start();

    expect(mongoCommands).toEqual([{ ping: 1 }]);
  });

  test.each(mongoStores)('$name fails the open naming itself when the ping is refused, and closes the client it built', async ({ name, build }) => {
    mongoCommandRefusal = new Error('connect ECONNREFUSED 10.0.0.7:27017');
    const store = build({ url: MONGO_URL });

    const error = await store.start().then(() => undefined, (failure: unknown) => failure as Error);

    expect(error?.message ?? 'resolved').toBe(`${name}.open failed: connect ECONNREFUSED 10.0.0.7:27017`);
    // The client was the store's own, and a failed open holds nothing.
    expect(mongoClientCloses).toBe(1);
  });
});

describe('MongoDB: the typed fields are validated when a store is built', () => {
  test.each(mongoStores)('$name refuses a pool size that is not a positive integer', ({ build }) => {
    for (const maxPoolSize of [0, -1, 2.5, Number.NaN]) {
      expect(refusal(() => build({ url: MONGO_URL, maxPoolSize })).field).toBe('maxPoolSize');
    }
    expect(() => build({ url: MONGO_URL, maxPoolSize: 1 })).not.toThrow();
  });

  test.each(mongoStores)('$name refuses a minimum pool size that is not a whole number, and takes zero', ({ build }) => {
    for (const minPoolSize of [-1, 0.5, Number.NaN]) {
      expect(refusal(() => build({ url: MONGO_URL, minPoolSize })).field).toBe('minPoolSize');
    }
    // Zero is the driver's own default: no connection is kept open in advance.
    expect(() => build({ url: MONGO_URL, minPoolSize: 0 })).not.toThrow();
  });

  test.each(mongoStores)('$name refuses a minimum above the maximum, which the driver refuses only at connect', ({ build }) => {
    const error = refusal(() => build({ url: MONGO_URL, minPoolSize: 6, maxPoolSize: 5 }));

    expect(error.field).toBe('minPoolSize');
    expect(error.message).toContain('min-pool-size');
    expect(error.message).toContain('maxPoolSize');
    expect(() => build({ url: MONGO_URL, minPoolSize: 5, maxPoolSize: 5 })).not.toThrow();
  });

  test.each(mongoStores)('$name refuses a timeout that is not a positive integer of milliseconds', ({ build }) => {
    for (const field of ['serverSelectionTimeoutMs', 'connectTimeoutMs'] as const) {
      for (const value of [0, -1, 0.5, Number.NaN]) {
        expect(refusal(() => build({ url: MONGO_URL, [field]: value })).field).toBe(field);
      }
    }
  });

  test.each(mongoStores)('$name refuses a timeout longer than a timer can hold', ({ build }) => {
    // The driver arms both as timers — server selection through its own
    // Timeout, the connect timeout on the socket — and a timer asked for
    // longer than this fires at once.
    for (const field of ['serverSelectionTimeoutMs', 'connectTimeoutMs'] as const) {
      const error = refusal(() => build({ url: MONGO_URL, [field]: MAX_TIMER_DELAY_MS + 1 }));
      expect(error.field).toBe(field);
      expect(error.message).toContain(String(MAX_TIMER_DELAY_MS));
      expect(() => build({ url: MONGO_URL, [field]: MAX_TIMER_DELAY_MS })).not.toThrow();
    }
  });

  test.each(mongoStores)('$name refuses an empty ca-file', ({ build }) => {
    expect(refusal(() => build({ url: MONGO_URL, caFile: '' })).field).toBe('caFile');
  });
});

describe('MongoDB: a setting made twice is refused, naming both sides', () => {
  test.each(mongoStores)('$name refuses a typed field beside the same option in clientOptions, in any letter case', ({ build }) => {
    // The driver reads clientOptions case-insensitively, so MAXPOOLSIZE is the
    // same option as maxPoolSize to it — and to this rule.
    for (const { field, leaf, option, value } of MONGO_NUMERIC_FIELDS) {
      for (const key of [option, option.toUpperCase(), option.toLowerCase()]) {
        const error = refusal(() => build({ url: MONGO_URL, [field]: value, clientOptions: { [key]: value } }));
        expect(error.field).toBe(field);
        expect(error.message).toContain(`the ${leaf} leaf`);
        expect(error.message).toContain(`clientOptions.${key}`);
      }
    }
  });

  test.each(mongoStores)('$name takes a clientOptions key the driver drops — one set to null or undefined', ({ build }) => {
    expect(() => build({ url: MONGO_URL, maxPoolSize: 20, clientOptions: { maxPoolSize: undefined } })).not.toThrow();
    expect(() => build({ url: MONGO_URL, maxPoolSize: 20, clientOptions: { maxPoolSize: null } })).not.toThrow();
  });

  test.each(mongoStores)('$name refuses a typed field beside the same option in the url, in any letter case', ({ build }) => {
    // The driver would keep the field and drop the url's value without a word.
    for (const { field, leaf, option, value } of MONGO_NUMERIC_FIELDS) {
      for (const key of [option, option.toUpperCase()]) {
        const error = refusal(() => build({ url: `${MONGO_URL}?${key}=7`, [field]: value }));
        expect(error.field).toBe(field);
        expect(error.message).toContain(`the ${leaf} leaf`);
        expect(error.message).toContain(`the url's ${key}`);
      }
    }
  });

  test.each(mongoStores)('$name takes a typed field beside a different option in the url', ({ build }) => {
    expect(() => build({ url: `${MONGO_URL}?maxPoolSize=50&appName=ledger`, minPoolSize: 2 })).not.toThrow();
    // A seed list and a query: the url is read as the driver reads it.
    expect(() => build({ url: 'mongodb://h1:27017,h2:27017/app?replicaSet=rs&minPoolSize=1', maxPoolSize: 9 }))
      .not.toThrow();
  });

  test.each(mongoStores)('$name refuses ca-file beside a url that names another CA or switches TLS off', ({ build }) => {
    for (const query of [
      'tls=true&tlsCAFile=/etc/ssl/other-ca.pem',
      'TLSCAFILE=/etc/ssl/other-ca.pem',
      'tls=false',
      'ssl=false',
      'TLS=False',
      'tlsInsecure=true',
      'tlsAllowInvalidCertificates=true',
    ]) {
      const error = refusal(() => build({ url: `${MONGO_URL}?${query}`, caFile: caPath }));
      expect(error.field, query).toBe('caFile');
      expect(error.message, query).toContain('ca-file');
    }
  });

  test.each(mongoStores)('$name takes ca-file beside a url that switches TLS on', ({ build }) => {
    expect(() => build({ url: `${MONGO_URL}?tls=true`, caFile: caPath })).not.toThrow();
    expect(() => build({ url: `${MONGO_URL}?ssl=true&authSource=admin`, caFile: caPath })).not.toThrow();
    expect(() => build({ url: 'mongodb+srv://cluster.example.net/app', caFile: caPath })).not.toThrow();
  });

  test.each(mongoStores)('$name refuses ca-file beside clientOptions that name another CA or leave it unused', ({ build }) => {
    for (const [clientOptions, named] of [
      [{ ca: 'another PEM' }, 'clientOptions.ca'],
      [{ tlsCAFile: '/etc/ssl/other-ca.pem' }, 'clientOptions.tlsCAFile'],
      [{ TLSCAFILE: '/etc/ssl/other-ca.pem' }, 'clientOptions.TLSCAFILE'],
      [{ tls: false }, 'clientOptions.tls'],
      [{ ssl: 'false' }, 'clientOptions.ssl'],
      [{ tlsInsecure: true }, 'clientOptions.tlsInsecure'],
      [{ tlsAllowInvalidCertificates: 'true' }, 'clientOptions.tlsAllowInvalidCertificates'],
    ] as const) {
      const error = refusal(() => build({ url: MONGO_URL, caFile: caPath, clientOptions }));
      expect(error.field, named).toBe('caFile');
      expect(error.message, named).toContain('ca-file');
      expect(error.message, named).toContain(named);
    }
  });

  test.each(mongoStores)('$name takes ca-file beside clientOptions that switch TLS on', ({ build }) => {
    expect(() => build({ url: MONGO_URL, caFile: caPath, clientOptions: { tls: true } })).not.toThrow();
    expect(() => build({ url: MONGO_URL, caFile: caPath, clientOptions: { ssl: true, appName: 'ledger' } })).not.toThrow();
  });

  test.each(mongoStores)('$name refuses ca-file beside a rejectUnauthorized of false in clientOptions, in any letter case', ({ build }) => {
    // The driver hands rejectUnauthorized to node:tls as it stands and matches
    // the key case-insensitively, so every spelling here is the switch
    // tlsInsecure sets: the server's certificate is accepted unchecked.
    for (const key of ['rejectUnauthorized', 'rejectunauthorized', 'REJECTUNAUTHORIZED']) {
      for (const value of [false, 'false']) {
        const named = `clientOptions.${key} = ${String(value)}`;
        const error = refusal(() => build({ url: MONGO_URL, caFile: caPath, clientOptions: { [key]: value } }));
        expect(error.field, named).toBe('caFile');
        expect(error.message, named).toContain('ca-file');
        expect(error.message, named).toContain(`clientOptions.${key}`);
      }
    }
  });

  test.each(mongoStores)('$name refuses ca-file beside a secureContext in clientOptions', ({ build }) => {
    // A secure context brings a trust store of its own, which node:tls uses in
    // place of the ca the framework hands over.
    for (const key of ['secureContext', 'SECURECONTEXT']) {
      const error = refusal(() => build({ url: MONGO_URL, caFile: caPath, clientOptions: { [key]: createSecureContext() } }));
      expect(error.field, key).toBe('caFile');
      expect(error.message, key).toContain('ca-file');
      expect(error.message, key).toContain(`clientOptions.${key}`);
    }
  });

  test.each(mongoStores)('$name refuses ca-file beside a pre-built client', ({ build }) => {
    // A pre-built client was configured where it was built, and the store
    // never reads ca-file for it.
    const client = new StandInMongoClient('mongodb://shared', undefined) as unknown as MongoClientLike;
    mongoClientArguments.length = 0;

    // With a url beside it too: the client bypasses the url as well.
    for (const options of [{ client, caFile: caPath }, { client, url: MONGO_URL, caFile: caPath }]) {
      const error = refusal(() => build(options));
      expect(error.field).toBe('caFile');
      expect(error.message).toContain('ca-file');
      expect(error.message).toContain('pre-built client');
    }
    expect(mongoClientArguments).toEqual([]);
  });

  test.each(mongoStores)('$name takes what keeps a CA file in force, and the same switches with no CA file', ({ build }) => {
    const client = new StandInMongoClient('mongodb://shared', undefined) as unknown as MongoClientLike;
    expect(() => build({ url: MONGO_URL, caFile: caPath, clientOptions: { rejectUnauthorized: true } })).not.toThrow();
    // A key set to null or undefined is one the driver drops before it reads anything.
    expect(() => build({ url: MONGO_URL, caFile: caPath, clientOptions: { rejectUnauthorized: undefined, secureContext: null } }))
      .not.toThrow();
    // Without a CA file there is nothing for these to contradict: they are the code's own decision.
    expect(() => build({ url: MONGO_URL, clientOptions: { rejectUnauthorized: false } })).not.toThrow();
    expect(() => build({ url: MONGO_URL, clientOptions: { secureContext: createSecureContext() } })).not.toThrow();
    expect(() => build({ client })).not.toThrow();
  });
});

describe('MongoDB: what the url is read for', () => {
  test('a typed option is found by its key as spelled, in any case, each named once', () => {
    const url = `${MONGO_URL}?MaxPoolSize=5&appName=ledger&maxpoolsize=6`;

    expect(mongoUrlKeysNaming(url, 'maxPoolSize')).toEqual(['MaxPoolSize', 'maxpoolsize']);
    expect(mongoUrlKeysNaming(url, 'minPoolSize')).toEqual([]);
    expect(mongoUrlKeysNaming(MONGO_URL, 'maxPoolSize')).toEqual([]);
  });

  test('what contradicts a CA file is named as the url spells it, and nothing else is', () => {
    expect(mongoCaFileConflicts(`${MONGO_URL}?tlsCAFile=/a.pem&TLS=false&tlsInsecure=true`))
      .toEqual(['tlsCAFile', 'TLS=false', 'tlsInsecure=true']);
    expect(mongoCaFileConflicts(`${MONGO_URL}?tls=true&tlsCertificateKeyFile=/client.pem&tlsAllowInvalidHostnames=true`))
      .toEqual([]);
  });
});

describe('MongoDB: registerMongoPlugins carries the typed fields to every store', () => {
  /** A system that selects the three MongoDB stores, which the call under test then registers. */
  function systemSelectingMongo(name: string, blocks: ConfigObject = {}): ActorSystem {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            journal: { plugin: MONGO_JOURNAL_PLUGIN_ID, mongodb: blocks },
            'snapshot-store': { plugin: MONGO_SNAPSHOT_PLUGIN_ID },
            'durable-state': { plugin: MONGO_DURABLE_STATE_PLUGIN_ID },
          },
        },
      });
    return ActorSystem.create(name, systemOptions);
  }

  test('a shared typed field reaches every store that does not set its own', async () => {
    const system = systemSelectingMongo('mongo-shared-typed-fields');
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = MongoJournalOptions.create().withClientOptions({ maxPoolSize: 4 });
      const pluginOptions = RegisterMongoPluginsOptions.create()
        .withUrl(MONGO_URL)
        .withMaxPoolSize(20)
        .withCaFile(missingPath)
        .withJournal(journalOptions);
      const handles = registerMongoPlugins(persistence, pluginOptions);

      // The journal's own clientOptions sets the pool size too, so the shared
      // field landing on it is the same setting made twice — refused when the
      // journal is built, which is how the merge shows it reached that store.
      expect(() => persistence.journal).toThrow(/maxPoolSize .*clientOptions\.maxPoolSize/);
      // The durable-state store sets nothing of its own and inherits the CA
      // file, which its first use reads — and fails on, naming the path.
      const error = await rejection(() => handles.durableStateStore.start());
      expect(error.message).toContain('ca-file');
      expect(error.message).toContain(missingPath);
    } finally {
      await system.terminate();
    }
  });

  test('a store\'s own typed field wins over the shared one', async () => {
    const system = systemSelectingMongo('mongo-own-typed-field');
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = MongoJournalOptions.create().withMaxPoolSize(5);
      const pluginOptions = RegisterMongoPluginsOptions.create()
        .withUrl(MONGO_URL)
        .withMaxPoolSize(20)
        .withServerSelectionTimeoutMs(4_000)
        .withJournal(journalOptions);
      registerMongoPlugins(persistence, pluginOptions);

      await (persistence.journal as unknown as StartableStore).start();

      expect(mongoClientArguments.map((call) => call.options)).toStrictEqual([
        { maxPoolSize: 5, serverSelectionTimeoutMS: 4_000 },
      ]);
    } finally {
      await system.terminate();
    }
  });

  test('a leaf read from the journal\'s block reaches the client, under the option the driver reads', async () => {
    const system = systemSelectingMongo('mongo-leaf-to-driver', {
      'max-pool-size': 12,
      'connect-timeout': '2s',
    });
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const pluginOptions = RegisterMongoPluginsOptions.create().withUrl(MONGO_URL);
      registerMongoPlugins(persistence, pluginOptions);

      await (persistence.journal as unknown as StartableStore).start();

      expect(mongoClientArguments).toStrictEqual([
        { url: MONGO_URL, options: { maxPoolSize: 12, connectTimeoutMS: 2_000 } },
      ]);
    } finally {
      await system.terminate();
    }
  });

  test('a ca-file read from the journal\'s block is refused beside a rejectUnauthorized of false set in code', async () => {
    const system = systemSelectingMongo('mongo-ca-file-beside-code-switch', { url: MONGO_URL, 'ca-file': caPath });
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = MongoJournalOptions.create().withClientOptions({ rejectUnauthorized: false });
      const pluginOptions = RegisterMongoPluginsOptions.create().withJournal(journalOptions);
      registerMongoPlugins(persistence, pluginOptions);

      expect(() => persistence.journal).toThrow(/caFile .*clientOptions\.rejectUnauthorized/);
      expect(mongoClientArguments).toEqual([]);
    } finally {
      await system.terminate();
    }
  });

  test('a ca-file read from the journal\'s block is refused beside the shared client handed over in code', async () => {
    const system = systemSelectingMongo('mongo-ca-file-beside-shared-client', { 'ca-file': caPath });
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const client = new StandInMongoClient('mongodb://shared', undefined) as unknown as MongoClientLike;
      const pluginOptions = RegisterMongoPluginsOptions.create().withClient(client);
      registerMongoPlugins(persistence, pluginOptions);

      expect(() => persistence.journal).toThrow(/caFile .*pre-built client/);
    } finally {
      await system.terminate();
    }
  });
});

/* -------------------------------- DynamoDB --------------------------------- */

type DynamoDbStoreCase = {
  readonly name: string;
  readonly build: (options: DynamoDbConnection) => StartableStore;
};

const dynamoDbStores: DynamoDbStoreCase[] = [
  { name: 'DynamoDbJournal', build: (options) => new DynamoDbJournal(options) },
  { name: 'DynamoDbSnapshotStore', build: (options) => new DynamoDbSnapshotStore(options) },
  { name: 'DynamoDbDurableStateStore', build: (options) => new DynamoDbDurableStateStore(options) },
];

const REGION = 'eu-central-1';

/** What `dynamodb-local` takes, and what nothing here ever sends. */
const LOCAL_CREDENTIALS = { accessKeyId: 'local', secretAccessKey: 'local' };

describe('DynamoDB: the typed client fields reach DynamoDBClient under the SDK\'s own names', () => {
  test('nothing typed is set, so the client is configured exactly as before', async () => {
    await buildDynamoDbOperations({ region: REGION });
    await buildDynamoDbOperations({ region: REGION, clientConfig: { credentials: LOCAL_CREDENTIALS } });

    expect(dynamoDbClientConfigs).toStrictEqual([
      { region: REGION },
      { region: REGION, credentials: LOCAL_CREDENTIALS },
    ]);
  });

  test('each field set reaches the client as the setting the SDK reads', async () => {
    await buildDynamoDbOperations({
      region: REGION,
      maxAttempts: 5,
      retryMode: 'adaptive',
      requestTimeoutMs: 9_000,
      connectionTimeoutMs: 3_000,
    });

    expect(dynamoDbClientConfigs).toStrictEqual([{
      region: REGION,
      maxAttempts: 5,
      retryMode: 'adaptive',
      requestHandler: { requestTimeout: 9_000, throwOnRequestTimeout: true, connectionTimeout: 3_000 },
    }]);
  });

  test('a request timeout fails the attempt, rather than logging that it passed', async () => {
    // @smithy/node-http-handler 4.11 and 4.12 only log a warning when a
    // request outlives requestTimeout, unless throwOnRequestTimeout is set
    // too — so a timeout leaf without it would time nothing out.
    await buildDynamoDbOperations({ region: REGION, requestTimeoutMs: 9_000 });

    expect(dynamoDbClientConfigs[0]!['requestHandler']).toStrictEqual({ requestTimeout: 9_000, throwOnRequestTimeout: true });
  });

  test('a connection timeout alone is the one handler option it sets', async () => {
    await buildDynamoDbOperations({ region: REGION, connectionTimeoutMs: 3_000 });

    expect(dynamoDbClientConfigs[0]!['requestHandler']).toStrictEqual({ connectionTimeout: 3_000 });
  });

  test('one field set is one setting, and the rest of clientConfig stays as written', async () => {
    const clientConfig = { credentials: LOCAL_CREDENTIALS, useFipsEndpoint: true };
    await buildDynamoDbOperations({ region: REGION, clientConfig, retryMode: 'standard' });

    expect(dynamoDbClientConfigs).toStrictEqual([
      { region: REGION, credentials: LOCAL_CREDENTIALS, useFipsEndpoint: true, retryMode: 'standard' },
    ]);
    // The caller's object is spread, never written to.
    expect(clientConfig).toStrictEqual({ credentials: LOCAL_CREDENTIALS, useFipsEndpoint: true });
  });

  test('a clientConfig key the SDK reads as unset leaves the typed field in force', async () => {
    // The validator takes such a key beside the typed field, so the field has
    // to be laid over clientConfig rather than under it: the other way round,
    // `maxAttempts: undefined` would reach the SDK and the typed 5 would not.
    await buildDynamoDbOperations({ region: REGION, maxAttempts: 5, clientConfig: { maxAttempts: undefined } });
    await buildDynamoDbOperations({ region: REGION, requestTimeoutMs: 5_000, clientConfig: { requestHandler: null } });

    expect(dynamoDbClientConfigs).toStrictEqual([
      { region: REGION, maxAttempts: 5 },
      { region: REGION, requestHandler: { requestTimeout: 5_000, throwOnRequestTimeout: true } },
    ]);
  });

  test('a pre-built operations façade bypasses the typed fields, as it bypasses region', async () => {
    const operations = {} as DynamoDbOperations;

    expect(await buildDynamoDbOperations({ operations, maxAttempts: 2, requestTimeoutMs: 1_000 })).toBe(operations);
    expect(dynamoDbClientConfigs).toEqual([]);
  });
});

describe('DynamoDB: the typed fields are validated when a store is built', () => {
  test.each(dynamoDbStores)('$name refuses an attempt count that is not a positive integer', ({ build }) => {
    for (const maxAttempts of [0, -1, 2.5, Number.NaN]) {
      expect(refusal(() => build({ region: REGION, maxAttempts })).field).toBe('maxAttempts');
    }
    // One attempt is no retry at all, which is a legitimate choice.
    expect(() => build({ region: REGION, maxAttempts: 1 })).not.toThrow();
  });

  test.each(dynamoDbStores)('$name takes standard and adaptive as the retry mode, and nothing else', ({ build }) => {
    // The SDK reads anything but adaptive as standard without a word, so a
    // typo would silently pick the other strategy.
    for (const retryMode of ['legacy', 'STANDARD', 'Adaptive', '']) {
      const error = refusal(() => build({ region: REGION, retryMode: retryMode as DynamoDbConnection['retryMode'] }));
      expect(error.field).toBe('retryMode');
      expect(error.message).toContain('standard');
      expect(error.message).toContain('adaptive');
    }
    expect(() => build({ region: REGION, retryMode: 'standard' })).not.toThrow();
    expect(() => build({ region: REGION, retryMode: 'adaptive' })).not.toThrow();
  });

  test.each(dynamoDbStores)('$name refuses a timeout that is not a positive integer of milliseconds', ({ build }) => {
    for (const field of ['requestTimeoutMs', 'connectionTimeoutMs'] as const) {
      for (const value of [0, -1, 0.5, Number.NaN]) {
        expect(refusal(() => build({ region: REGION, [field]: value })).field).toBe(field);
      }
    }
  });

  test.each(dynamoDbStores)('$name refuses a timeout longer than a timer can hold', ({ build }) => {
    // The request handler arms both as timers, and a timer asked for longer
    // than this fires at once.
    for (const field of ['requestTimeoutMs', 'connectionTimeoutMs'] as const) {
      const error = refusal(() => build({ region: REGION, [field]: MAX_TIMER_DELAY_MS + 1 }));
      expect(error.field).toBe(field);
      expect(error.message).toContain(String(MAX_TIMER_DELAY_MS));
      expect(() => build({ region: REGION, [field]: MAX_TIMER_DELAY_MS })).not.toThrow();
    }
  });
});

describe('DynamoDB: a setting made twice is refused, naming both sides', () => {
  /** Each typed field, the leaf it is read from, and the clientConfig keys it collides with. */
  const COLLISIONS = [
    { field: 'maxAttempts', leaf: 'max-attempts', value: 5, keys: ['maxAttempts', 'retryStrategy'] },
    { field: 'retryMode', leaf: 'retry-mode', value: 'adaptive', keys: ['retryMode', 'retryStrategy'] },
    { field: 'requestTimeoutMs', leaf: 'request-timeout', value: 9_000, keys: ['requestHandler'] },
    { field: 'connectionTimeoutMs', leaf: 'connection-timeout', value: 3_000, keys: ['requestHandler'] },
  ] as const;

  test.each(dynamoDbStores)('$name refuses a typed field beside what it replaces in clientConfig', ({ build }) => {
    for (const { field, leaf, value, keys } of COLLISIONS) {
      for (const key of keys) {
        const error = refusal(() => build({ region: REGION, [field]: value, clientConfig: { [key]: { stand: 'in' } } }));
        expect(error.field, `${field} beside ${key}`).toBe(field);
        expect(error.message, `${field} beside ${key}`).toContain(`the ${leaf} leaf`);
        expect(error.message, `${field} beside ${key}`).toContain(`clientConfig.${key}`);
      }
    }
  });

  test.each(dynamoDbStores)('$name takes a clientConfig key the SDK reads as unset — undefined or null', ({ build }) => {
    expect(() => build({ region: REGION, maxAttempts: 5, clientConfig: { maxAttempts: undefined } })).not.toThrow();
    expect(() => build({ region: REGION, requestTimeoutMs: 5_000, clientConfig: { requestHandler: null } })).not.toThrow();
  });

  test.each(dynamoDbStores)('$name takes a typed field beside settings it does not replace', ({ build }) => {
    expect(() => build({
      region: REGION,
      maxAttempts: 5,
      retryMode: 'adaptive',
      requestTimeoutMs: 9_000,
      connectionTimeoutMs: 3_000,
      clientConfig: { credentials: LOCAL_CREDENTIALS, useDualstackEndpoint: true },
    })).not.toThrow();
  });
});

describe('DynamoDB: registerDynamoDbPlugins carries the typed fields to every store', () => {
  /**
   * A system that selects the three DynamoDB stores, which the call under test
   * then registers.  `auto-create-tables` is off under every block, so a
   * store's first use opens its client and describes its table, which the
   * stand-in finds active, with nothing to create.
   */
  function systemSelectingDynamoDb(name: string, journalBlock: ConfigObject = {}): ActorSystem {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            journal: {
              plugin: DYNAMODB_JOURNAL_PLUGIN_ID,
              dynamodb: { 'auto-create-tables': false, ...journalBlock },
            },
            'snapshot-store': { plugin: DYNAMODB_SNAPSHOT_PLUGIN_ID, dynamodb: { 'auto-create-tables': false } },
            'durable-state': { plugin: DYNAMODB_DURABLE_STATE_PLUGIN_ID, dynamodb: { 'auto-create-tables': false } },
          },
        },
      });
    return ActorSystem.create(name, systemOptions);
  }

  test('a shared typed field reaches every store that does not set its own', async () => {
    const system = systemSelectingDynamoDb('dynamodb-shared-typed-fields');
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = DynamoDbJournalOptions.create().withClientConfig({ maxAttempts: 2 });
      const pluginOptions = RegisterDynamoDbPluginsOptions.create()
        .withRegion(REGION)
        .withMaxAttempts(6)
        .withJournal(journalOptions);
      const handles = registerDynamoDbPlugins(persistence, pluginOptions);

      // The journal's own clientConfig sets the attempt count too, so the
      // shared field landing on it is the same setting made twice — refused
      // when the journal is built, which is how the merge shows it reached it.
      expect(() => persistence.journal).toThrow(/maxAttempts .*clientConfig\.maxAttempts/);
      // The durable-state store sets nothing of its own and takes the shared one.
      await handles.durableStateStore.start();
      expect(dynamoDbClientConfigs).toStrictEqual([{ region: REGION, maxAttempts: 6 }]);
      // Its open went through the client it built, to its own table (#1473).
      expect(dynamoDbDescribedTables).toEqual(['actor_ts_durable_state']);
    } finally {
      await system.terminate();
    }
  });

  test('a store\'s own typed field wins over the shared one', async () => {
    const system = systemSelectingDynamoDb('dynamodb-own-typed-field');
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = DynamoDbJournalOptions.create().withRetryMode('standard');
      const pluginOptions = RegisterDynamoDbPluginsOptions.create()
        .withRegion(REGION)
        .withRetryMode('adaptive')
        .withConnectionTimeoutMs(2_000)
        .withJournal(journalOptions);
      registerDynamoDbPlugins(persistence, pluginOptions);

      await (persistence.journal as unknown as StartableStore).start();

      expect(dynamoDbClientConfigs).toStrictEqual([
        { region: REGION, retryMode: 'standard', requestHandler: { connectionTimeout: 2_000 } },
      ]);
    } finally {
      await system.terminate();
    }
  });

  test('a leaf read from the journal\'s block reaches the client, under the setting the SDK reads', async () => {
    const system = systemSelectingDynamoDb('dynamodb-leaf-to-driver', {
      'max-attempts': 4,
      'retry-mode': 'adaptive',
      'request-timeout': '8s',
    });
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const pluginOptions = RegisterDynamoDbPluginsOptions.create().withRegion(REGION);
      registerDynamoDbPlugins(persistence, pluginOptions);

      await (persistence.journal as unknown as StartableStore).start();

      expect(dynamoDbClientConfigs).toStrictEqual([{
        region: REGION,
        maxAttempts: 4,
        retryMode: 'adaptive',
        requestHandler: { requestTimeout: 8_000, throwOnRequestTimeout: true },
      }]);
    } finally {
      await system.terminate();
    }
  });
});
