import { describe, expect, test } from 'bun:test';
import {
  adaptSqliteDatabase,
  assertLocalSqlitePath,
  buildSqliteDatabase,
  type SqliteConnection,
} from '../../../src/persistence/journals/SqliteClient.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * An untyped `database: null` is no handle, for the path rule and for
 * `buildSqliteDatabase` alike (#1492).
 *
 * `null` is what a caller without the declared types passes for "none".
 * Before the rule `buildSqliteDatabase` tested the handle for truthiness and
 * opened the path beside a `null`; the rule changed both places to
 * `!== undefined`, so `null` stood in for a valid path — the function handed
 * `null` back, and a store over it failed its first statement with a
 * `TypeError` — and with no path at all `null` passed the rule as a supplied
 * handle.
 */

/** `connection` with an untyped `database: null` — outside the declared type, as such a caller's value is. */
function withNullDatabase(connection: { readonly path?: string }): SqliteConnection {
  return { ...connection, database: null } as unknown as SqliteConnection;
}

describe('buildSqliteDatabase and assertLocalSqlitePath read database: null as no handle (#1492)', () => {
  test('beside a valid path, buildSqliteDatabase opens the path', async () => {
    const database = await buildSqliteDatabase(withNullDatabase({ path: ':memory:' }));
    expect(database).not.toBeNull();
    const pool = adaptSqliteDatabase(database);
    try {
      await pool.query('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      await pool.query('INSERT INTO t (id) VALUES (1)');
      expect((await pool.query('SELECT id FROM t')).rows).toEqual([{ id: 1 }]);
    } finally {
      await pool.end();
    }
  });

  test('without a path, buildSqliteDatabase refuses it as a connection given neither', async () => {
    await expect(buildSqliteDatabase(withNullDatabase({}))).rejects.toThrow(
      /path is required unless `database` is supplied/,
    );
  });

  test('without a path, assertLocalSqlitePath refuses it for a store that takes a handle', () => {
    let thrown: unknown;
    try {
      assertLocalSqlitePath('SqliteDurableStateStoreOptions', withNullDatabase({}), { acceptsDatabase: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OptionsError);
    expect((thrown as OptionsError).field).toBe('path');
  });

  test('beside a valid path, assertLocalSqlitePath accepts it', () => {
    expect(() =>
      assertLocalSqlitePath('SqliteDurableStateStoreOptions', withNullDatabase({ path: ':memory:' }), {
        acceptsDatabase: true,
      }),
    ).not.toThrow();
  });
});
