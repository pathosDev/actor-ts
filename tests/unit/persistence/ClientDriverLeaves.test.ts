import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MAX_TIMER_DELAY_MS } from '../../../src/util/Constants.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  MONGO_DURABLE_STATE_PLUGIN_ID,
  MONGO_JOURNAL_PLUGIN_ID,
  MONGO_SNAPSHOT_PLUGIN_ID,
  MongoDurableStateStore,
  MongoJournal,
  MongoJournalOptions,
  MongoSnapshotStore,
  PersistenceExtensionId,
  RegisterMongoPluginsOptions,
  registerMongoPlugins,
} from '../../../src/persistence/index.js';
import {
  buildMongoResource,
  resetMongoModuleCache,
  type MongoClientLike,
  type MongoConnection,
} from '../../../src/persistence/journals/MongoClient.js';
import { mongoCaFileConflicts, mongoUrlKeysNaming } from '../../../src/persistence/journals/ConnectionStringInspection.js';

/**
 * What the MongoDB stores hand their client driver, and what they refuse to
 * hand it (#1490).
 *
 * A store's client is configured from up to three places — the `url`, a
 * `clientOptions` object written in code, and the typed client fields an
 * operator can also set from HOCON — and the driver merges the first two by a
 * rule of its own: it reads both case-insensitively and keeps the object's
 * value, dropping the url's without a word (mongodb 7.6
 * connection_string.js:252-263, 436-466; 6.21 the same).  The typed fields
 * reach the driver under its own names and only when set; where a combination
 * would silently drop one side, the store refuses it at construction with an
 * `OptionsError` naming both sides, before anything connects.
 *
 * The driver is not installed in this repository — its coverage against a
 * live server is the broker suite under `tests/integration/brokers/` — so it is
 * replaced here by a stand-in that records what it is handed.  The stores
 * import the driver lazily, on first use, so installing the stand-in before
 * that use is enough; `resetMongoModuleCache` drops a cached import so every
 * test resolves the stand-in afresh.
 */

/* -------------------------------- stand-ins -------------------------------- */

/** Every `(url, options)` a stand-in `MongoClient` was constructed with, in order. */
const mongoClientArguments: Array<{ readonly url: string; readonly options: Record<string, unknown> | undefined }> = [];

/** A collection as far as a store's start reaches into it: index creation. */
const standInCollection = {
  createIndex: async (): Promise<string> => 'index',
};

/** The mongodb driver's `MongoClient`, as far as a store reaches into it. */
class StandInMongoClient {
  constructor(url: string, options?: Record<string, unknown>) {
    mongoClientArguments.push({ url, options });
  }

  async connect(): Promise<this> {
    return this;
  }

  db(): { collection: () => typeof standInCollection } {
    return { collection: () => standInCollection };
  }

  async close(): Promise<void> {}
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

const realMongo = await snapshotOf('mongodb');
mock.module('mongodb', () => ({ MongoClient: StandInMongoClient }));

beforeEach(() => {
  mongoClientArguments.length = 0;
  resetMongoModuleCache();
});

afterAll(() => {
  // A module mock is process-wide and outlives `mock.restore()`, so it is put
  // back by hand.  A driver that was never installed cannot be put back as
  // missing — bun evaluates a factory when it is registered, so one that throws
  // throws out of `mock.module` itself — and the nearest state is a module
  // whose entry point is gone, which a later store fails on at first use
  // instead of reaching this file's stand-in.
  mock.module('mongodb', () => realMongo ?? { MongoClient: undefined });
  resetMongoModuleCache();
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
});
