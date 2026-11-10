import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MAX_TIMER_DELAY_MS } from '../../../src/util/Constants.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  MSSQL_JOURNAL_PLUGIN_ID,
  MariaDbDurableStateStore,
  MariaDbJournal,
  MariaDbSnapshotStore,
  MsSqlDurableStateStore,
  MsSqlJournal,
  MsSqlSnapshotStore,
  PostgresDurableStateStore,
  PostgresJournal,
  PostgresSnapshotStore,
  registerMsSqlPlugins,
} from '../../../src/persistence/index.js';
import {
  buildMsSqlPool,
  resetMsSqlModuleCache,
  type MsSqlConnection,
} from '../../../src/persistence/journals/MsSqlClient.js';
import {
  buildPgPool,
  resetPgModuleCache,
  type PostgresConnection,
} from '../../../src/persistence/journals/PostgresClient.js';
import {
  buildMariaDbPool,
  parseMariaDbUrl,
  resetMariaDbModuleCache,
  type MariaDbConnection,
} from '../../../src/persistence/journals/MariaDbClient.js';

/**
 * What the Postgres, MariaDB and SQL Server stores hand their drivers, and what
 * they refuse to hand them (#1490).
 *
 * Each store resolves its connection from up to three places — a `url`, a
 * `poolConfig` object written in code, and the typed connection fields an
 * operator can also set from HOCON — and each driver merges the first two by
 * rules of its own.  The typed fields reach the driver under its own names and
 * only when set; where a combination would silently drop one side, the store
 * refuses it at construction with an `OptionsError` naming both sides, before
 * anything connects.
 *
 * None of the three drivers is installed in this repository — their coverage
 * against a live server is the broker suites under `tests/integration/brokers/`
 * — so each is replaced here by a stand-in that records the config it is
 * handed.  The stores import their driver lazily, on first use, so installing
 * the stand-in before that use is enough; `reset*ModuleCache` drops a cached
 * import so every test resolves the stand-in afresh.
 */

/* -------------------------------- stand-ins -------------------------------- */

/** Every config a stand-in driver was handed, in order. */
const pgPoolConfigs: Array<Record<string, unknown>> = [];

/** node-postgres' `Pool`, as far as a store reaches into it. */
class StandInPgPool {
  constructor(config: Record<string, unknown>) {
    pgPoolConfigs.push(config);
  }

  async query(): Promise<{ rows: []; rowCount: 0 }> {
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<{ query: () => Promise<{ rows: []; rowCount: 0 }>; release: () => void }> {
    return { query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined };
  }

  async end(): Promise<void> {}
}

/** Every argument the stand-in `mariadb.createPool` was handed, in order — an options object or a url. */
const mariaDbPoolArguments: Array<Record<string, unknown> | string> = [];

/** The mariadb connector's `createPool`, as far as a store reaches into it. */
function standInCreatePool(argument: Record<string, unknown> | string): object {
  mariaDbPoolArguments.push(argument);
  return {
    query: async () => [],
    getConnection: async () => ({
      query: async () => [],
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    }),
    end: async () => undefined,
  };
}

/** Every config the stand-in `mssql.ConnectionPool` was constructed with, and every string it was asked to parse. */
const msSqlPoolConfigs: Array<Record<string, unknown> | string> = [];
const msSqlParsedStrings: string[] = [];

/**
 * What node-mssql 12.7's own `ConnectionPool.parseConnectionString` returned
 * for the strings these tests hand the stand-in, captured by running the real
 * parser.  Any other string is refused, so no test can pass on a parse the
 * real driver never produced.
 */
const MSSQL_PARSES: ReadonlyMap<string, Record<string, unknown>> = new Map([
  ['Server=db.internal,1433;Database=app;User Id=ledger;Password=secret;Encrypt=true', {
    options: { encrypt: true }, pool: {}, port: 1433, server: 'db.internal', database: 'app',
    password: 'secret', user: 'ledger',
  }],
  ['Server=db.internal;Database=app', {
    options: {}, pool: {}, port: 1433, server: 'db.internal', database: 'app',
  }],
]);

/** node-mssql's `ConnectionPool`, as far as a store reaches into it. */
class StandInMsSqlConnectionPool {
  static parseConnectionString(connectionString: string): Record<string, unknown> {
    msSqlParsedStrings.push(connectionString);
    const parsed = MSSQL_PARSES.get(connectionString);
    if (parsed === undefined) throw new Error(`no captured parse for ${connectionString}`);
    return structuredClone(parsed);
  }

  constructor(config: Record<string, unknown> | string) {
    msSqlPoolConfigs.push(config);
  }

  async connect(): Promise<this> {
    return this;
  }

  request(): { input: () => undefined; query: () => Promise<{ recordset: []; rowsAffected: [] }> } {
    return { input: () => undefined, query: async () => ({ recordset: [], rowsAffected: [] }) };
  }

  transaction(): object {
    return {};
  }

  async close(): Promise<void> {}
}

/**
 * What each specifier resolved to before a stand-in replaced it — a plain copy,
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

const realPg = await snapshotOf('pg');
const realMariaDb = await snapshotOf('mariadb');
const realMsSql = await snapshotOf('mssql');
mock.module('pg', () => ({ Pool: StandInPgPool }));
mock.module('mariadb', () => ({ createPool: standInCreatePool }));
mock.module('mssql', () => ({ ConnectionPool: StandInMsSqlConnectionPool }));

beforeEach(() => {
  pgPoolConfigs.length = 0;
  mariaDbPoolArguments.length = 0;
  msSqlPoolConfigs.length = 0;
  msSqlParsedStrings.length = 0;
  resetPgModuleCache();
  resetMariaDbModuleCache();
  resetMsSqlModuleCache();
});

afterAll(() => {
  // A module mock is process-wide and outlives `mock.restore()`, so it is put
  // back by hand.  A driver that was never installed cannot be put back as
  // missing — bun evaluates a factory when it is registered, so one that throws
  // throws out of `mock.module` itself — and the nearest state is a module
  // whose entry point is gone, which a later store fails on at first use
  // instead of reaching this file's stand-in.
  mock.module('pg', () => realPg ?? { Pool: undefined });
  mock.module('mariadb', () => realMariaDb ?? { createPool: undefined });
  mock.module('mssql', () => realMsSql ?? { ConnectionPool: undefined });
  resetPgModuleCache();
  resetMariaDbModuleCache();
  resetMsSqlModuleCache();
});

/* ------------------------------ scratch files ------------------------------ */

const scratch = mkdtempSync(join(tmpdir(), 'sql-driver-leaves-'));
afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

/** A CA file in the shape a managed database publishes, with stand-in bytes. */
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIBstandin\n-----END CERTIFICATE-----\n';
const caPath = join(scratch, 'rds-ca.pem');
writeFileSync(caPath, CA_PEM);
const notPemPath = join(scratch, 'not-a-certificate.txt');
writeFileSync(notPemPath, 'host=db.internal\n');
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

type PostgresStoreCase = {
  readonly name: string;
  readonly build: (options: PostgresConnection) => StartableStore;
};

const postgresStores: PostgresStoreCase[] = [
  { name: 'PostgresJournal', build: (options) => new PostgresJournal(options) },
  { name: 'PostgresSnapshotStore', build: (options) => new PostgresSnapshotStore(options) },
  { name: 'PostgresDurableStateStore', build: (options) => new PostgresDurableStateStore(options) },
];

/** A CA object in the shape the poolConfig JSDoc shows, with stand-in bytes. */
const CA_OBJECT = { ca: CA_PEM };

/* -------------------------------- Postgres --------------------------------- */

describe('Postgres: the typed connection fields reach pg under its own names', () => {
  test('nothing typed is set, so nothing typed reaches the driver', async () => {
    await buildPgPool({ url: 'postgres://db.internal/app' });

    expect(pgPoolConfigs).toStrictEqual([{ connectionString: 'postgres://db.internal/app' }]);
  });

  test('each field set reaches the pool as the key pg reads', async () => {
    await buildPgPool({
      url: 'postgres://db.internal/app',
      maxPoolSize: 20,
      idleTimeoutMs: 30_000,
      connectTimeoutMs: 5_000,
      caFile: caPath,
    });

    expect(pgPoolConfigs).toStrictEqual([{
      connectionString: 'postgres://db.internal/app',
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: { ca: CA_PEM },
    }]);
  });

  test('one field set is one key, and the rest of poolConfig stays as written', async () => {
    const poolConfig = { application_name: 'ledger', ssl: { servername: 'db.internal' } };
    await buildPgPool({ poolConfig, maxPoolSize: 4, caFile: caPath });

    expect(pgPoolConfigs).toStrictEqual([{
      application_name: 'ledger',
      max: 4,
      ssl: { servername: 'db.internal', ca: CA_PEM },
    }]);
    // The caller's object is copied, never written to.
    expect(poolConfig).toStrictEqual({ application_name: 'ledger', ssl: { servername: 'db.internal' } });
  });

  test('ssl: true in poolConfig becomes an ssl object carrying the CA', async () => {
    await buildPgPool({ poolConfig: { ssl: true }, caFile: caPath });

    expect(pgPoolConfigs[0]!['ssl']).toStrictEqual({ ca: CA_PEM });
  });
});

describe('Postgres: ca-file is read by the framework when the pool opens', () => {
  test.each(postgresStores)('$name builds without touching the file and fails first use naming it', async ({ build }) => {
    // Construction stays free of I/O; the store's first operation is what
    // opens the pool, and that is where an unreadable file has to surface.
    const store = build({ url: 'postgres://db.internal/app', caFile: missingPath });

    const error = await rejection(() => store.start());
    expect(error.field).toBe('caFile');
    expect(error.message).toContain('caFile');
    expect(error.message).toContain('ca-file');
    expect(error.message).toContain(missingPath);
    expect(pgPoolConfigs).toEqual([]);
  });

  test('a file that holds no PEM certificate is refused, and its contents are not quoted', async () => {
    const error = await rejection(() => buildPgPool({ caFile: notPemPath }));

    expect(error.message).toContain(notPemPath);
    expect(error.message).toContain('no PEM certificate');
    expect(error.message).not.toContain('db.internal');
  });
});

describe('Postgres: the typed fields are validated when a store is built', () => {
  test.each(postgresStores)('$name refuses a pool size that is not a positive integer', ({ build }) => {
    for (const maxPoolSize of [0, -1, 2.5, Number.NaN]) {
      expect(refusal(() => build({ maxPoolSize })).field).toBe('maxPoolSize');
    }
    expect(() => build({ maxPoolSize: 1 })).not.toThrow();
  });

  test.each(postgresStores)('$name refuses a timeout that is not a positive integer of milliseconds', ({ build }) => {
    for (const field of ['idleTimeoutMs', 'connectTimeoutMs'] as const) {
      for (const value of [0, -1, 0.5, Number.NaN]) {
        expect(refusal(() => build({ [field]: value })).field).toBe(field);
      }
      expect(() => build({ [field]: 1 })).not.toThrow();
    }
  });

  test.each(postgresStores)('$name refuses a timeout the driver could not arm as a timer', ({ build }) => {
    // pg-pool and pg hand both to setTimeout, which fires anything longer at once.
    for (const field of ['idleTimeoutMs', 'connectTimeoutMs'] as const) {
      const error = refusal(() => build({ [field]: MAX_TIMER_DELAY_MS + 1 }));
      expect(error.field).toBe(field);
      expect(error.message).toContain(String(MAX_TIMER_DELAY_MS));
      expect(() => build({ [field]: MAX_TIMER_DELAY_MS })).not.toThrow();
    }
  });

  test.each(postgresStores)('$name refuses an empty ca-file', ({ build }) => {
    expect(refusal(() => build({ caFile: '' })).field).toBe('caFile');
  });
});

describe('Postgres: a setting made in two places is refused, naming both', () => {
  const pairs: ReadonlyArray<readonly [Partial<PostgresConnection>, string, string]> = [
    [{ maxPoolSize: 20, poolConfig: { max: 10 } }, 'maxPoolSize', 'poolConfig.max'],
    [{ maxPoolSize: 20, poolConfig: { poolSize: 10 } }, 'maxPoolSize', 'poolConfig.poolSize'],
    [{ idleTimeoutMs: 1_000, poolConfig: { idleTimeoutMillis: 2_000 } }, 'idleTimeoutMs', 'poolConfig.idleTimeoutMillis'],
    [{ connectTimeoutMs: 1_000, poolConfig: { connectionTimeoutMillis: 0 } }, 'connectTimeoutMs', 'poolConfig.connectionTimeoutMillis'],
  ];

  test.each(postgresStores)('$name refuses a typed field beside the same key in poolConfig', ({ build }) => {
    for (const [options, field, poolConfigKey] of pairs) {
      const error = refusal(() => build(options));
      expect(error.field).toBe(field);
      expect(error.message).toContain(field);
      expect(error.message).toContain(poolConfigKey);
    }
  });

  test.each(postgresStores)('$name refuses ca-file beside a url ssl parameter', ({ build }) => {
    // Executed against pg 8.23: a CA beside sslmode=verify-full was dropped,
    // and beside sslmode=no-verify verification went off with it.
    for (const url of [
      'postgres://db.internal/app?sslmode=verify-full',
      'postgres://db.internal/app?sslmode=no-verify',
      'postgres://db.internal/app?sslrootcert=/etc/ssl/other.pem',
      'postgres://db.internal/app?ssl=true',
    ]) {
      const error = refusal(() => build({ url, caFile: caPath }));
      expect(error.field).toBe('caFile');
      expect(error.message).toMatch(/url's ssl parameter/);
    }
  });

  test.each(postgresStores)('$name refuses ca-file beside a poolConfig.ssl it would contradict', ({ build }) => {
    for (const [ssl, reason] of [
      [{ ca: CA_PEM }, /names a CA already/],
      [false, /switches TLS off/],
      ['no-verify', /mode of its own/],
      [{ rejectUnauthorized: false }, /verification off/],
    ] as const) {
      const error = refusal(() => build({ poolConfig: { ssl }, caFile: caPath }));
      expect(error.field).toBe('caFile');
      expect(error.message).toContain('poolConfig.ssl');
      expect(error.message).toMatch(reason);
    }
  });

  test.each(postgresStores)('$name keeps ca-file beside a poolConfig.ssl that leaves room for it', ({ build }) => {
    for (const ssl of [true, { servername: 'db.internal' }]) {
      expect(() => build({ poolConfig: { ssl }, caFile: caPath })).not.toThrow();
    }
    expect(() => build({ url: 'postgres://db.internal/app?application_name=ledger', caFile: caPath })).not.toThrow();
  });
});

describe('Postgres: a poolConfig.ssl beside a url that carries ssl parameters', () => {
  // node-postgres assigns what it parses out of the url over the config object
  // (pg 8.23 connection-parameters.js:57-60), so the url's ssl wins wholesale:
  // run against the real driver, `{ ca }` beside `?sslmode=verify-full` became
  // `{}` (the CA dropped) and beside `?sslmode=no-verify` it became an ssl
  // object with verification switched off.
  const urlSpellings = [
    'postgres://db.internal/app?sslmode=verify-full',
    'postgres://db.internal/app?sslmode=no-verify',
    'postgres://db.internal/app?ssl=true',
    'postgres://db.internal/app?ssl=',
    'postgres://db.internal/app?sslrootcert=/etc/ssl/rds-ca.pem',
    'postgres://db.internal/app?sslnegotiation=direct',
    'postgres://db.internal/app?application_name=ledger&SSLMode=require',
  ];

  test.each(postgresStores)('$name refuses the pair, naming both sides', ({ build }) => {
    for (const url of urlSpellings) {
      const error = refusal(() => build({ url, poolConfig: { ssl: { ...CA_OBJECT } } }));
      expect(error.field).toBe('poolConfig.ssl');
      expect(error.message).toContain('poolConfig.ssl');
      expect(error.message).toMatch(/url's ssl parameter/);
      const key = [...new URL(url).searchParams.keys()].find((name) => name.toLowerCase().startsWith('ssl'))!;
      expect(error.message).toContain(key);
    }
  });

  test.each(postgresStores)('$name reads a connectionString inside poolConfig as the url it is', ({ build }) => {
    // buildPgPool falls back to poolConfig.connectionString when no url is set,
    // and pg merges it exactly as it merges a url.
    const error = refusal(() => build({
      poolConfig: { connectionString: 'postgres://db.internal/app?sslmode=require', ssl: { ...CA_OBJECT } },
    }));
    expect(error.message).toContain('sslmode');
  });

  test.each(postgresStores)('$name never quotes the url, which carries credentials', ({ build }) => {
    const error = refusal(() => build({
      url: 'postgres://ledger:hunter2@db.internal/app?sslmode=verify-full',
      poolConfig: { ssl: { ...CA_OBJECT } },
    }));
    expect(error.message).not.toContain('hunter2');
    expect(error.message).not.toContain('db.internal');
  });

  test.each(postgresStores)('$name keeps either side on its own, and a url with no ssl parameter', ({ build }) => {
    expect(() => build({ url: 'postgres://db.internal/app?sslmode=verify-full' })).not.toThrow();
    expect(() => build({ poolConfig: { ssl: { ...CA_OBJECT } } })).not.toThrow();
    expect(() => build({
      url: 'postgres://db.internal/app?application_name=ledger',
      poolConfig: { ssl: { ...CA_OBJECT } },
    })).not.toThrow();
  });
});

/* --------------------------------- MariaDB --------------------------------- */

type MariaDbStoreCase = {
  readonly name: string;
  readonly build: (options: MariaDbConnection) => StartableStore;
};

const mariaDbStores: MariaDbStoreCase[] = [
  { name: 'MariaDbJournal', build: (options) => new MariaDbJournal(options) },
  { name: 'MariaDbSnapshotStore', build: (options) => new MariaDbSnapshotStore(options) },
  { name: 'MariaDbDurableStateStore', build: (options) => new MariaDbDurableStateStore(options) },
];

describe('MariaDB: a url is parsed the way the connector parses it', () => {
  // Each expected object is what parseMariaDbUrl returned when it was run
  // beside mariadb 3.5.4 itself, and for every one of them the connector built
  // the same PoolOptions from the parsed object as from the url string: the
  // credentials and the database decoded, `+` kept, a one-character key and a
  // bare flag read as the connector reads them, `0x10` through its radix-less
  // parseInt, and `ssl=TRUE` as false.
  const fixtures: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['mariadb://u:p%40ss@db.internal:3307/app', {
      user: 'u', password: 'p@ss', host: 'db.internal', port: 3307, database: 'app',
    }],
    ['mariadb://u:p@h/app?connectionLimit=5&idleTimeout=600&acquireTimeout=2000&connectTimeout=500', {
      user: 'u', password: 'p', host: 'h', port: undefined, database: 'app',
      connectionLimit: 5, idleTimeout: 600, acquireTimeout: 2000, connectTimeout: 500,
    }],
    ['mariadb://u:p@h/app?ssl=TRUE', {
      user: 'u', password: 'p', host: 'h', port: undefined, database: 'app', ssl: false,
    }],
    ['mariadb://u:p@h/app?ssl=false&resetAfterUse=false&noControlAfterUse=true', {
      user: 'u', password: 'p', host: 'h', port: undefined, database: 'app',
      ssl: false, resetAfterUse: false, noControlAfterUse: true,
    }],
    ['mariadb://u:p@[::1]:3306/app?a=1&connectAttributes=%7B%22x%22%3A1%7D', {
      user: 'u', password: 'p', host: '::1', port: 3306, database: 'app', connectAttributes: { x: 1 },
    }],
    ['mariadb://u:p@h/app?x+y=a+b&k=%2Fv&flag', {
      user: 'u', password: 'p', host: 'h', port: undefined, database: 'app', 'x+y': 'a+b', '': 'flag',
    }],
    ['mariadb://u:p@h/app?acquireTimeout=0x10&connectionLimit=1.9&minimumIdle=2', {
      user: 'u', password: 'p', host: 'h', port: undefined, database: 'app',
      acquireTimeout: 16, connectionLimit: 1, minimumIdle: 2,
    }],
    ['mariadb://h/my%20db?timezone=Z&charset=utf8mb4', {
      user: undefined, password: undefined, host: 'h', port: undefined, database: 'my db',
      timezone: 'Z', charset: 'utf8mb4',
    }],
  ];

  test.each(fixtures)('%s', (url, expected) => {
    expect(parseMariaDbUrl(url)).toStrictEqual(expected);
  });

  test('a url the connector would refuse is refused without quoting it', () => {
    for (const url of ['mysql://ledger:hunter2@db.internal/app', 'mariadb://ledger:hunter2@db.internal/', 'db.internal']) {
      let message = '';
      try {
        parseMariaDbUrl(url);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('mariadb://[<user>[:<password>]@]<host>');
      expect(message).not.toContain('hunter2');
    }
  });
});

describe('MariaDB: the typed connection fields reach the connector under its own names', () => {
  test('nothing typed is set, so the url reaches the connector as written', async () => {
    await buildMariaDbPool({ url: 'mariadb://ledger:secret@db.internal/app' });

    expect(mariaDbPoolArguments).toStrictEqual(['mariadb://ledger:secret@db.internal/app']);
  });

  test('typed fields over a url keep its credentials, host, database and options', async () => {
    await buildMariaDbPool({
      url: 'mariadb://ledger:secret@db.internal:3307/app?timezone=Z',
      maxPoolSize: 15,
      acquireTimeoutMs: 4_000,
      idleTimeoutMs: 600_000,
      connectTimeoutMs: 750,
      caFile: caPath,
    });

    expect(mariaDbPoolArguments).toStrictEqual([{
      user: 'ledger',
      password: 'secret',
      host: 'db.internal',
      port: 3307,
      database: 'app',
      timezone: 'Z',
      connectionLimit: 15,
      acquireTimeout: 4_000,
      idleTimeout: 600,
      connectTimeout: 750,
      ssl: { ca: CA_PEM },
    }]);
  });

  test('one field set is one key, laid over poolConfig, which is copied rather than written to', async () => {
    const poolConfig = { host: 'db.internal', database: 'app', ssl: { servername: 'db.internal' } };
    await buildMariaDbPool({ poolConfig, maxPoolSize: 4, caFile: caPath });

    expect(mariaDbPoolArguments).toStrictEqual([{
      host: 'db.internal',
      database: 'app',
      connectionLimit: 4,
      ssl: { servername: 'db.internal', ca: CA_PEM },
    }]);
    expect(poolConfig).toStrictEqual({ host: 'db.internal', database: 'app', ssl: { servername: 'db.internal' } });
  });

  test("a url's ssl=true becomes an ssl object carrying the CA", async () => {
    await buildMariaDbPool({ url: 'mariadb://db.internal/app?ssl=true', caFile: caPath });

    expect((mariaDbPoolArguments[0] as Record<string, unknown>)['ssl']).toStrictEqual({ ca: CA_PEM });
  });

  test('the idle timeout reaches the connector in the seconds it counts', async () => {
    await buildMariaDbPool({ url: 'mariadb://db.internal/app', idleTimeoutMs: 90_000 });

    expect((mariaDbPoolArguments[0] as Record<string, unknown>)['idleTimeout']).toBe(90);
  });
});

describe('MariaDB: ca-file is read by the framework when the pool opens', () => {
  test.each(mariaDbStores)('$name builds without touching the file and fails first use naming it', async ({ build }) => {
    const store = build({ url: 'mariadb://db.internal/app', caFile: missingPath });

    const error = await rejection(() => store.start());
    expect(error.field).toBe('caFile');
    expect(error.message).toContain('ca-file');
    expect(error.message).toContain(missingPath);
    expect(mariaDbPoolArguments).toStrictEqual([]);
  });
});

describe('MariaDB: the typed fields are validated when a store is built', () => {
  test.each(mariaDbStores)('$name refuses a pool size that is not a positive integer', ({ build }) => {
    for (const maxPoolSize of [0, -1, 2.5, Number.NaN]) {
      expect(refusal(() => build({ maxPoolSize })).field).toBe('maxPoolSize');
    }
    expect(() => build({ maxPoolSize: 1 })).not.toThrow();
  });

  test.each(mariaDbStores)('$name refuses an acquire or connect timeout outside what a timer can hold', ({ build }) => {
    for (const field of ['acquireTimeoutMs', 'connectTimeoutMs'] as const) {
      for (const value of [0, -1, 0.5, Number.NaN, MAX_TIMER_DELAY_MS + 1]) {
        expect(refusal(() => build({ [field]: value })).field).toBe(field);
      }
      expect(() => build({ [field]: MAX_TIMER_DELAY_MS })).not.toThrow();
    }
  });

  test.each(mariaDbStores)('$name refuses an idle timeout that is not a whole number of seconds', ({ build }) => {
    // The connector counts idleTimeout in seconds (pool-options.js:30), so a
    // millisecond remainder could only be rounded, and rounding a sub-second
    // value would hand the connector 0.
    for (const idleTimeoutMs of [500, 1_500, 0, -1_000, Number.NaN]) {
      expect(refusal(() => build({ idleTimeoutMs })).field).toBe('idleTimeoutMs');
    }
    expect(refusal(() => build({ idleTimeoutMs: 1_500 })).message).toContain('seconds');
    for (const idleTimeoutMs of [1_000, 600_000]) {
      expect(() => build({ idleTimeoutMs })).not.toThrow();
    }
  });

  test.each(mariaDbStores)('$name refuses an empty ca-file', ({ build }) => {
    expect(refusal(() => build({ caFile: '' })).field).toBe('caFile');
  });
});

describe('MariaDB: a setting made in two places is refused, naming both', () => {
  const fields: ReadonlyArray<readonly [keyof MariaDbConnection, number, string]> = [
    ['maxPoolSize', 8, 'connectionLimit'],
    ['acquireTimeoutMs', 4_000, 'acquireTimeout'],
    ['idleTimeoutMs', 60_000, 'idleTimeout'],
    ['connectTimeoutMs', 750, 'connectTimeout'],
  ];

  test.each(mariaDbStores)('$name refuses a typed field beside the same option in poolConfig', ({ build }) => {
    for (const [field, value, option] of fields) {
      const error = refusal(() => build({ [field]: value, poolConfig: { host: 'db.internal', [option]: 1 } }));
      expect(error.field).toBe(field);
      expect(error.message).toContain(`poolConfig.${option}`);
    }
  });

  test.each(mariaDbStores)("$name refuses a typed field beside the same option in the url's query", ({ build }) => {
    for (const [field, value, option] of fields) {
      const error = refusal(() => build({ [field]: value, url: `mariadb://ledger:hunter2@db.internal/app?${option}=1` }));
      expect(error.field).toBe(field);
      expect(error.message).toContain(option);
      expect(error.message).not.toContain('hunter2');
    }
    // Matched loosely, as everywhere a file could say two things.
    expect(refusal(() => build({ maxPoolSize: 8, url: 'mariadb://db.internal/app?ConnectionLimit=1' })).field)
      .toBe('maxPoolSize');
  });

  test.each(mariaDbStores)('$name keeps a typed field beside a url that sets something else', ({ build }) => {
    expect(() => build({ maxPoolSize: 8, url: 'mariadb://db.internal/app?timezone=Z&acquireTimeout=500' })).not.toThrow();
  });

  test.each(mariaDbStores)('$name refuses ca-file beside a url whose ssl switches TLS off', ({ build }) => {
    // The connector reads the url's ssl as true for exactly `true` and as false
    // for anything else — run against it, ssl=TRUE meant plaintext.
    for (const url of ['mariadb://db.internal/app?ssl=false', 'mariadb://db.internal/app?ssl=0', 'mariadb://db.internal/app?ssl=TRUE']) {
      const error = refusal(() => build({ url, caFile: caPath }));
      expect(error.field).toBe('caFile');
      expect(error.message).toContain("url's ssl");
    }
    expect(() => build({ url: 'mariadb://db.internal/app?ssl=true', caFile: caPath })).not.toThrow();
  });

  test.each(mariaDbStores)('$name refuses ca-file beside a poolConfig.ssl it would contradict', ({ build }) => {
    for (const [ssl, reason] of [
      [{ ca: CA_PEM }, /names a CA already/],
      [false, /switches TLS off/],
      [{ rejectUnauthorized: false }, /verification off/],
    ] as const) {
      const error = refusal(() => build({ poolConfig: { ssl }, caFile: caPath }));
      expect(error.field).toBe('caFile');
      expect(error.message).toMatch(reason);
    }
    for (const ssl of [true, { servername: 'db.internal' }]) {
      expect(() => build({ poolConfig: { ssl }, caFile: caPath })).not.toThrow();
    }
  });
});

/* ------------------------------- SQL Server -------------------------------- */

type MsSqlStoreCase = {
  readonly name: string;
  readonly build: (options: MsSqlConnection) => StartableStore;
};

const msSqlStores: MsSqlStoreCase[] = [
  { name: 'MsSqlJournal', build: (options) => new MsSqlJournal(options) },
  { name: 'MsSqlSnapshotStore', build: (options) => new MsSqlSnapshotStore(options) },
  { name: 'MsSqlDurableStateStore', build: (options) => new MsSqlDurableStateStore(options) },
];

/** A connection string the stand-in parses the way node-mssql 12.7 parsed it. */
const MSSQL_URL = 'Server=db.internal,1433;Database=app;User Id=ledger;Password=secret;Encrypt=true';

describe('SQL Server: the typed connection fields reach node-mssql under its own names', () => {
  test('nothing typed is set, so the connection string reaches the driver as written', async () => {
    await buildMsSqlPool({ url: MSSQL_URL });

    expect(msSqlPoolConfigs).toStrictEqual([MSSQL_URL]);
    expect(msSqlParsedStrings).toStrictEqual([]);
  });

  test("typed fields over a url go through the driver's own parser and keep what it read", async () => {
    await buildMsSqlPool({
      url: MSSQL_URL,
      maxPoolSize: 25,
      idleTimeoutMs: 45_000,
      connectTimeoutMs: 3_000,
      requestTimeoutMs: 120_000,
      caFile: caPath,
    });

    expect(msSqlParsedStrings).toStrictEqual([MSSQL_URL]);
    expect(msSqlPoolConfigs).toStrictEqual([{
      options: { encrypt: true, cryptoCredentialsDetails: { ca: CA_PEM } },
      pool: { max: 25, idleTimeoutMillis: 45_000 },
      port: 1433,
      server: 'db.internal',
      database: 'app',
      password: 'secret',
      user: 'ledger',
      connectionTimeout: 3_000,
      requestTimeout: 120_000,
    }]);
  });

  test('one field set is one key, laid over poolConfig, which is copied rather than written to', async () => {
    const poolConfig = {
      server: 'db.internal',
      pool: { min: 2 },
      options: { encrypt: true, cryptoCredentialsDetails: { minVersion: 'TLSv1.2' } },
    };
    await buildMsSqlPool({ poolConfig, maxPoolSize: 4, caFile: caPath });

    expect(msSqlPoolConfigs).toStrictEqual([{
      server: 'db.internal',
      pool: { min: 2, max: 4 },
      options: { encrypt: true, cryptoCredentialsDetails: { minVersion: 'TLSv1.2', ca: CA_PEM } },
    }]);
    expect(poolConfig).toStrictEqual({
      server: 'db.internal',
      pool: { min: 2 },
      options: { encrypt: true, cryptoCredentialsDetails: { minVersion: 'TLSv1.2' } },
    });
  });

  test('a timeout alone touches neither pool nor options', async () => {
    await buildMsSqlPool({ url: 'Server=db.internal;Database=app', requestTimeoutMs: 60_000 });

    expect(msSqlPoolConfigs).toStrictEqual([{
      options: {}, pool: {}, port: 1433, server: 'db.internal', database: 'app', requestTimeout: 60_000,
    }]);
  });
});

describe('SQL Server: ca-file is read by the framework when the pool opens', () => {
  test.each(msSqlStores)('$name builds without touching the file and fails first use naming it', async ({ build }) => {
    const store = build({ url: MSSQL_URL, caFile: missingPath });

    const error = await rejection(() => store.start());
    expect(error.field).toBe('caFile');
    expect(error.message).toContain('ca-file');
    expect(error.message).toContain(missingPath);
    expect(msSqlPoolConfigs).toStrictEqual([]);
  });
});

describe('SQL Server: a url and a ca-file set from configuration alone reach node-mssql together', () => {
  test('the CA lands in cryptoCredentialsDetails over the url as the driver parses it', async () => {
    // The documented private-CA route: the journal selected and connected in
    // HOCON, nothing in code but the plug-in registration.  `ca-file` is the
    // only typed leaf set, so it alone has to send the url through the
    // driver's parser; handed over as a string, the url carries no CA, and
    // the operator's pin would be dropped without a word.
    const hocon = [
      `actor-ts.persistence.journal.plugin = "${MSSQL_JOURNAL_PLUGIN_ID}"`,
      `actor-ts.persistence.journal.mssql.url = "${MSSQL_URL}"`,
      `actor-ts.persistence.journal.mssql.ca-file = ${JSON.stringify(caPath)}`,
    ].join('\n');
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig(Config.parseString(hocon))
      .withPersistence({ plugins: [(persistence) => registerMsSqlPlugins(persistence)] });
    const system = ActorSystem.create('mssql-ca-file-from-configuration', systemOptions);
    try {
      await system.whenReady();

      expect(msSqlParsedStrings).toStrictEqual([MSSQL_URL]);
      expect(msSqlPoolConfigs).toStrictEqual([{
        options: { encrypt: true, cryptoCredentialsDetails: { ca: CA_PEM } },
        pool: {},
        port: 1433,
        server: 'db.internal',
        database: 'app',
        password: 'secret',
        user: 'ledger',
      }]);
    } finally {
      await system.terminate();
    }
  });
});

describe('SQL Server: the typed fields are validated when a store is built', () => {
  test.each(msSqlStores)('$name refuses a pool size or idle timeout that is not a positive integer', ({ build }) => {
    for (const field of ['maxPoolSize', 'idleTimeoutMs'] as const) {
      for (const value of [0, -1, 2.5, Number.NaN]) {
        expect(refusal(() => build({ url: MSSQL_URL, [field]: value })).field).toBe(field);
      }
    }
    // tarn compares the idle timeout against a timestamp, so it has no timer ceiling.
    expect(() => build({ url: MSSQL_URL, idleTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).not.toThrow();
  });

  test.each(msSqlStores)('$name refuses a connect or request timeout outside what a timer can hold', ({ build }) => {
    for (const field of ['connectTimeoutMs', 'requestTimeoutMs'] as const) {
      for (const value of [0, -1, 0.5, Number.NaN, MAX_TIMER_DELAY_MS + 1]) {
        expect(refusal(() => build({ url: MSSQL_URL, [field]: value })).field).toBe(field);
      }
      expect(() => build({ url: MSSQL_URL, [field]: MAX_TIMER_DELAY_MS })).not.toThrow();
    }
  });

  test.each(msSqlStores)('$name refuses an empty ca-file', ({ build }) => {
    expect(refusal(() => build({ url: MSSQL_URL, caFile: '' })).field).toBe('caFile');
  });
});

describe('SQL Server: a setting made in two places is refused, naming both', () => {
  const poolConfigPairs: ReadonlyArray<readonly [Partial<MsSqlConnection>, string, string]> = [
    [{ maxPoolSize: 8, poolConfig: { pool: { max: 4 } } }, 'maxPoolSize', 'poolConfig.pool.max'],
    [{ idleTimeoutMs: 1_000, poolConfig: { pool: { idleTimeoutMillis: 2_000 } } }, 'idleTimeoutMs', 'poolConfig.pool.idleTimeoutMillis'],
    [{ connectTimeoutMs: 1_000, poolConfig: { connectionTimeout: 2_000 } }, 'connectTimeoutMs', 'poolConfig.connectionTimeout'],
    [{ connectTimeoutMs: 1_000, poolConfig: { options: { connectTimeout: 2_000 } } }, 'connectTimeoutMs', 'poolConfig.options.connectTimeout'],
    [{ connectTimeoutMs: 1_000, poolConfig: { timeout: 2_000 } }, 'connectTimeoutMs', 'poolConfig.timeout'],
    [{ requestTimeoutMs: 1_000, poolConfig: { requestTimeout: 2_000 } }, 'requestTimeoutMs', 'poolConfig.requestTimeout'],
    [{ requestTimeoutMs: 1_000, poolConfig: { options: { requestTimeout: 2_000 } } }, 'requestTimeoutMs', 'poolConfig.options.requestTimeout'],
    [{ requestTimeoutMs: 1_000, poolConfig: { timeout: 2_000 } }, 'requestTimeoutMs', 'poolConfig.timeout'],
  ];

  test.each(msSqlStores)('$name refuses a typed field beside the same setting in poolConfig', ({ build }) => {
    for (const [options, field, where] of poolConfigPairs) {
      const error = refusal(() => build(options));
      expect(error.field).toBe(field);
      expect(error.message).toContain(where);
    }
  });

  test.each(msSqlStores)('$name refuses a typed field beside the same key in the connection string', ({ build }) => {
    for (const [field, key] of [
      ['maxPoolSize', 'Max Pool Size'],
      ['connectTimeoutMs', 'Connection Timeout'],
      ['connectTimeoutMs', 'Connect Timeout'],
      ['connectTimeoutMs', 'Timeout'],
      ['requestTimeoutMs', 'Request Timeout'],
    ] as const) {
      const error = refusal(() => build({ [field]: 5, url: `Server=db.internal;Database=app;Password=hunter2;${key}=9` }));
      expect(error.field).toBe(field);
      expect(error.message).toContain(key);
      expect(error.message).not.toContain('hunter2');
    }
    // Matched loosely: node-mssql ignores MaxPoolSize, and the file still says it twice.
    expect(refusal(() => build({ maxPoolSize: 5, url: 'Server=db.internal;MaxPoolSize=9' })).field).toBe('maxPoolSize');
    expect(() => build({ maxPoolSize: 5, url: 'Server=db.internal;Database=app;Encrypt=true' })).not.toThrow();
  });

  test.each(msSqlStores)('$name refuses ca-file beside a url that leaves the CA unused', ({ build }) => {
    for (const url of [
      'Server=db.internal;Database=app;Encrypt=false',
      'Server=db.internal;Database=app;Encrypt=no',
      'Server=db.internal;Database=app;TrustServerCertificate=true',
      'Server=db.internal;Database=app;TrustServerCertificate=yes',
    ]) {
      const error = refusal(() => build({ url, caFile: caPath }));
      expect(error.field).toBe('caFile');
      expect(error.message).toContain("the url's");
    }
    for (const url of ['Server=db.internal;Database=app;Encrypt=true', 'Server=db.internal;Database=app;TrustServerCertificate=false']) {
      expect(() => build({ url, caFile: caPath })).not.toThrow();
    }
  });

  test.each(msSqlStores)('$name refuses ca-file beside a poolConfig that says something else about TLS', ({ build }) => {
    for (const [poolConfig, reason] of [
      [{ options: { cryptoCredentialsDetails: { ca: CA_PEM } } }, /a CA already/],
      [{ options: { encrypt: false } }, /TLS off/],
      [{ encrypt: false }, /TLS off/],
      [{ options: { trustServerCertificate: true } }, /verification off/],
      [{ trustServerCertificate: true }, /verification off/],
    ] as const) {
      const error = refusal(() => build({ poolConfig: { server: 'db.internal', ...poolConfig }, caFile: caPath }));
      expect(error.field).toBe('caFile');
      expect(error.message).toMatch(reason);
    }
    // options.encrypt wins over a top-level encrypt, as node-mssql reads them.
    expect(() => build({ poolConfig: { server: 'db.internal', encrypt: false, options: { encrypt: true } }, caFile: caPath }))
      .not.toThrow();
  });
});
