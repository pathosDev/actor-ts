import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { MAX_TIMER_DELAY_MS } from '../../../src/util/Constants.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  PostgresDurableStateStore,
  PostgresJournal,
  PostgresSnapshotStore,
} from '../../../src/persistence/index.js';
import {
  buildPgPool,
  resetPgModuleCache,
  type PostgresConnection,
} from '../../../src/persistence/journals/PostgresClient.js';

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
mock.module('pg', () => ({ Pool: StandInPgPool }));

beforeEach(() => {
  pgPoolConfigs.length = 0;
  resetPgModuleCache();
});

afterAll(() => {
  // A module mock is process-wide and outlives `mock.restore()`, so it is put
  // back by hand.  A driver that was never installed cannot be put back as
  // missing — bun evaluates a factory when it is registered, so one that throws
  // throws out of `mock.module` itself — and the nearest state is a module
  // whose entry point is gone, which a later store fails on at first use
  // instead of reaching this file's stand-in.
  mock.module('pg', () => realPg ?? { Pool: undefined });
  resetPgModuleCache();
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
