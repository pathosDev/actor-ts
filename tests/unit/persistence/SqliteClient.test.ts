import { describe, expect, test } from 'bun:test';
import { adaptSqliteDatabase, buildSqliteDatabase } from '../../../src/persistence/journals/SqliteClient.js';
import type { SqlPool } from '../../../src/persistence/relational/SqlPool.js';

async function pool(): Promise<SqlPool> {
  const database = await buildSqliteDatabase({ path: ':memory:' });
  const adapted = adaptSqliteDatabase(database);
  await adapted.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  return adapted;
}

describe('adaptSqliteDatabase — SqlResult shape (#392)', () => {
  test('a SELECT reports rows and no affected rows', async () => {
    const p = await pool();
    await p.query('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
    const result = await p.query('SELECT id, v FROM t WHERE id = ?', [1]);
    expect(result.rows).toEqual([{ id: 1, v: 'a' }]);
    // The contract says affectedRows is 0 for row-returning statements.
    expect(result.affectedRows).toBe(0);
    await p.end();
  });

  test('a write reports affected rows and no rows', async () => {
    // The driver splits these across .all() and .run(), and asking for the
    // wrong one throws on better-sqlite3 — so classification has to be right
    // rather than merely lucky.
    const p = await pool();
    const inserted = await p.query('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
    expect(inserted.affectedRows).toBe(1);
    expect(inserted.rows).toEqual([]);

    const updated = await p.query('UPDATE t SET v = ? WHERE id = ?', ['b', 1]);
    expect(updated.affectedRows).toBe(1);

    const missed = await p.query('UPDATE t SET v = ? WHERE id = ?', ['c', 999]);
    expect(missed.affectedRows).toBe(0);

    const deleted = await p.query('DELETE FROM t WHERE id = ?', [1]);
    expect(deleted.affectedRows).toBe(1);
    await p.end();
  });

  test('a conflicting insert reports zero affected rows, not an error', async () => {
    // This is the signal the SQLite dialect's revision-0 insert relies on:
    // ON CONFLICT DO NOTHING must read back as "nothing changed".
    const p = await pool();
    await p.query('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
    const conflicted = await p.query('INSERT INTO t (id, v) VALUES (?, ?) ON CONFLICT DO NOTHING', [1, 'b']);
    expect(conflicted.affectedRows).toBe(0);
    await p.end();
  });

  test('leading comments and whitespace do not defeat classification', async () => {
    const p = await pool();
    await p.query('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
    const commented = await p.query('-- a leading line comment\n  SELECT v FROM t WHERE id = ?', [1]);
    expect(commented.rows).toEqual([{ v: 'a' }]);
    const blockCommented = await p.query('/* block */ SELECT v FROM t WHERE id = ?', [1]);
    expect(blockCommented.rows).toEqual([{ v: 'a' }]);
    await p.end();
  });
});

describe('adaptSqliteDatabase — transactions (#392)', () => {
  test('a real BEGIN/COMMIT: the body is visible after commit', async () => {
    const p = await pool();
    await p.withTransaction(async (transaction) => {
      await transaction.query('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'a']);
      await transaction.query('INSERT INTO t (id, v) VALUES (?, ?)', [2, 'b']);
    });
    const result = await p.query('SELECT COUNT(*) AS c FROM t');
    expect(Number(result.rows[0]!.c)).toBe(2);
    await p.end();
  });

  test('a throw rolls the whole transaction back', async () => {
    // The behaviour that distinguishes this adapter from the HTTP-fronted
    // SQLite backends: `SqlPool` allows an adapter to offer only an atomic
    // batch, but a local file can give genuine rollback, so it does.
    const p = await pool();
    await p.query('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'before']);

    await expect(p.withTransaction(async (transaction) => {
      await transaction.query('INSERT INTO t (id, v) VALUES (?, ?)', [2, 'inside']);
      await transaction.query('UPDATE t SET v = ? WHERE id = ?', ['changed', 1]);
      throw new Error('abort');
    })).rejects.toThrow('abort');

    const rows = (await p.query('SELECT id, v FROM t ORDER BY id')).rows;
    expect(rows).toEqual([{ id: 1, v: 'before' }]);
    await p.end();
  });

  test('reads inside a transaction see its own writes', async () => {
    // Read-your-write within the transaction is what the relational bases'
    // CAS paths depend on, and what an atomic batch cannot provide.
    const p = await pool();
    const seen = await p.withTransaction(async (transaction) => {
      await transaction.query('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'x']);
      const result = await transaction.query('SELECT v FROM t WHERE id = ?', [1]);
      return result.rows[0]?.v;
    });
    expect(seen).toBe('x');
    await p.end();
  });

  test('concurrent transactions are serialized, not interleaved', async () => {
    // One SqliteDb is one connection, and the callback is async — so without a
    // queue a second BEGIN could land while the first was still awaiting, and
    // the two would collapse into one transaction committing early.  The
    // second transaction throws, and the first must survive it intact.
    const p = await pool();

    const first = p.withTransaction(async (transaction) => {
      await transaction.query('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'first']);
      // A fixture: the first transaction has to still be open when the second one
      // starts and fails, which is the interleaving the case exists to rule out.
      await Bun.sleep(30);
      await transaction.query('INSERT INTO t (id, v) VALUES (?, ?)', [2, 'first-again']);
    });
    const second = p.withTransaction(async (transaction) => {
      await transaction.query('INSERT INTO t (id, v) VALUES (?, ?)', [3, 'second']);
      throw new Error('second fails');
    });

    await first;
    await expect(second).rejects.toThrow('second fails');

    // First committed both rows; second rolled back entirely.
    const rows = (await p.query('SELECT id FROM t ORDER BY id')).rows;
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    await p.end();
  });

  test('a failed transaction does not poison the queue', async () => {
    const p = await pool();
    await expect(p.withTransaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The chain must still accept work after a rejection.
    await p.withTransaction(async (transaction) => {
      await transaction.query('INSERT INTO t (id, v) VALUES (?, ?)', [1, 'after']);
    });
    expect((await p.query('SELECT v FROM t')).rows).toEqual([{ v: 'after' }]);
    await p.end();
  });
});

describe('buildSqliteDatabase (#392)', () => {
  test('requires a path or a pre-opened database', async () => {
    await expect(buildSqliteDatabase({})).rejects.toThrow(/requires either `path`/);
  });

  test('an injected database is not closed by end()', async () => {
    // A shared handle belongs to whoever opened it: closing it here would pull
    // the database out from under the journal and snapshot store sharing it.
    const database = await buildSqliteDatabase({ path: ':memory:' });
    const shared = adaptSqliteDatabase(database, false);
    await shared.query('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await shared.end();
    // Still usable — end() was a no-op for the handle.
    await expect(shared.query('SELECT COUNT(*) AS c FROM t')).resolves.toBeDefined();
    database.close();
  });
});
