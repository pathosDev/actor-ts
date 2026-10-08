import { describe, expect, test } from 'bun:test';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import {
  PostgresDurableStateStore,
  PostgresJournal,
  PostgresSnapshotStore,
} from '../../../src/persistence/index.js';
import type { PostgresConnection } from '../../../src/persistence/journals/PostgresClient.js';

/**
 * What the Postgres, MariaDB and SQL Server stores hand their drivers, and what
 * they refuse to hand them (#1490).
 *
 * Each store resolves its connection from up to three places — a `url`, a
 * `poolConfig` object written in code, and the typed connection fields an
 * operator can set from HOCON — and each driver merges the first two by rules
 * of its own.  Where those rules would silently drop one side, the store
 * refuses the combination at construction with an `OptionsError` naming both
 * sides, before anything connects.
 */

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

type PostgresStoreCase = {
  readonly name: string;
  readonly build: (options: PostgresConnection) => unknown;
};

const postgresStores: PostgresStoreCase[] = [
  { name: 'PostgresJournal', build: (options) => new PostgresJournal(options) },
  { name: 'PostgresSnapshotStore', build: (options) => new PostgresSnapshotStore(options) },
  { name: 'PostgresDurableStateStore', build: (options) => new PostgresDurableStateStore(options) },
];

/** A CA object in the shape the poolConfig JSDoc shows, with stand-in bytes. */
const CA_OBJECT = { ca: '-----BEGIN CERTIFICATE-----' };

describe('a Postgres poolConfig.ssl beside a url that carries ssl parameters', () => {
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
