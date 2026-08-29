import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

import { STORAGE_IDENTITY_TABLE } from '../../../src/persistence/Constants.js';
import { JournalError } from '../../../src/persistence/JournalTypes.js';
import {
  CachedSnapshotStore,
  CachedSnapshotStoreOptions,
  InMemoryDurableStateStore,
  InMemoryJournal,
  InMemorySnapshotStore,
  ObjectStorageSnapshotStore,
  SqliteJournal,
  SqliteSnapshotStore,
} from '../../../src/persistence/index.js';
import {
  ObjectStorageConcurrencyError,
  resolveObjectStorageIdentity,
  type ObjectStorageBackend,
} from '../../../src/persistence/object-storage/ObjectStorageBackend.js';
import { RelationalDurableStateStore } from '../../../src/persistence/relational/RelationalDurableStateStore.js';
import { postgresDialect } from '../../../src/persistence/relational/PostgresDialect.js';
import type { SqlExecutor, SqlPool, SqlResult } from '../../../src/persistence/relational/SqlPool.js';
import type { Cache } from '../../../src/cache/Cache.js';
import type { SnapshotStore } from '../../../src/persistence/SnapshotStore.js';
import { none, some } from '../../../src/util/Option.js';

/**
 * The storage identity (#1358) is what turns "same backend technology" into
 * a checkable claim about "same database": minted once, persisted in the
 * database itself, stable across restarts, shared by every store that opens
 * the same database.  These tests pin those properties per family — the
 * in-memory semantics the shared fixtures rely on, the SQLite file as the
 * unit of identity, the relational family's exact SQL against a recording
 * pool (the fake-pool byte-identity pattern the relational base is tested
 * with everywhere else), and the object-storage claim protocol.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('in-memory stores', () => {
  test('one instance is one identity, stable across calls', async () => {
    const journal = new InMemoryJournal();
    const first = await journal.storageIdentity();
    expect(first).toMatch(UUID_PATTERN);
    expect(await journal.storageIdentity()).toBe(first);
  });

  test('two instances are two databases and say so', async () => {
    expect(await new InMemoryJournal().storageIdentity())
      .not.toBe(await new InMemoryJournal().storageIdentity());
    expect(await new InMemorySnapshotStore().storageIdentity())
      .not.toBe(await new InMemorySnapshotStore().storageIdentity());
    expect(await new InMemoryDurableStateStore().storageIdentity())
      .not.toBe(await new InMemoryDurableStateStore().storageIdentity());
  });
});

describe('SQLite stores', () => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-identity-'));
  // Best-effort, like the migration suites' temp-dir cleanup: Windows can
  // hold a closed SQLite handle past `close()`, and a cleanup EBUSY says
  // nothing about the identity semantics under test.
  afterAll(() => {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  });

  test('an in-memory database mints once per open store', async () => {
    const journal = new SqliteJournal();
    const identity = await journal.storageIdentity();
    expect(identity).toMatch(UUID_PATTERN);
    expect(await journal.storageIdentity()).toBe(identity);
    await journal.close();
  });

  test('the file is the unit of identity: shared by stores, stable across reopen', async () => {
    const path = join(directory, 'shared.db');
    const journal = new SqliteJournal({ path });
    const identity = await journal.storageIdentity();

    // A snapshot store on the SAME file reads the same row — the identity
    // belongs to the database, not to the store family that opened it.
    const snapshotStore = new SqliteSnapshotStore({ path });
    expect(await snapshotStore.storageIdentity()).toBe(identity);

    await journal.close();
    await snapshotStore.close();

    // Reopen: minted once, persisted, never re-minted.
    const reopened = new SqliteJournal({ path });
    expect(await reopened.storageIdentity()).toBe(identity);
    await reopened.close();
  });

  test('two files are two databases', async () => {
    const first = new SqliteJournal({ path: join(directory, 'a.db') });
    const second = new SqliteJournal({ path: join(directory, 'b.db') });
    expect(await first.storageIdentity()).not.toBe(await second.storageIdentity());
    await first.close();
    await second.close();
  });
});

/** Records every statement and serves the canned identity row. */
class RecordingPool implements SqlPool {
  readonly statements: Array<{ readonly sql: string; readonly params?: ReadonlyArray<unknown> }> = [];
  storedIdentity = 'stored-identity';
  failInsertAsDuplicate = false;

  async query(sql: string, params?: ReadonlyArray<unknown>): Promise<SqlResult> {
    this.statements.push(params === undefined ? { sql } : { sql, params });
    if (sql.startsWith(`INSERT INTO ${STORAGE_IDENTITY_TABLE}`) && this.failInsertAsDuplicate) {
      const duplicate = new Error('duplicate key value violates unique constraint') as Error & { code?: string };
      duplicate.code = '23505';
      throw duplicate;
    }
    if (sql.startsWith(`SELECT identity FROM ${STORAGE_IDENTITY_TABLE}`)) {
      return { rows: [{ identity: this.storedIdentity }], affectedRows: 0 };
    }
    return { rows: [], affectedRows: 1 };
  }

  async withTransaction<T>(body: (transaction: SqlExecutor) => Promise<T>): Promise<T> { return body(this); }
  async end(): Promise<void> {}
}

function relationalStoreOver(pool: RecordingPool, autoCreateTables = true): RelationalDurableStateStore {
  return new RelationalDurableStateStore({
    storeName: 'IdentityProbeStore',
    dialect: postgresDialect,
    ownsPool: false,
    autoCreateTables,
    openPool: async () => pool,
  });
}

describe('relational family', () => {
  test('emits exactly the dialect DDL, the guarded insert, and the read-back', async () => {
    const pool = new RecordingPool();
    const store = relationalStoreOver(pool);

    const identity = await store.storageIdentity();

    expect(identity).toBe('stored-identity');
    const sql = pool.statements.map((statement) => statement.sql);
    for (const ddl of postgresDialect.storageIdentityDdl!(STORAGE_IDENTITY_TABLE)) {
      expect(sql).toContain(ddl);
    }
    const insert = pool.statements.find((statement) => statement.sql.startsWith(`INSERT INTO ${STORAGE_IDENTITY_TABLE}`));
    expect(insert?.sql).toBe(`INSERT INTO ${STORAGE_IDENTITY_TABLE} (singleton, identity) VALUES ($1, $2)`);
    expect(insert?.params?.[0]).toBe(1);
    expect(insert?.params?.[1]).toMatch(UUID_PATTERN);
    const select = pool.statements.find((statement) => statement.sql.startsWith(`SELECT identity FROM ${STORAGE_IDENTITY_TABLE}`));
    expect(select?.sql).toBe(`SELECT identity FROM ${STORAGE_IDENTITY_TABLE} WHERE singleton = $1`);

    // Cached: a second call issues nothing new.
    const statementCount = pool.statements.length;
    expect(await store.storageIdentity()).toBe('stored-identity');
    expect(pool.statements.length).toBe(statementCount);
  });

  test('losing the insert race to a sibling store resolves to the stored row', async () => {
    const pool = new RecordingPool();
    pool.failInsertAsDuplicate = true;

    expect(await relationalStoreOver(pool).storageIdentity()).toBe('stored-identity');
  });

  test('autoCreateTables: false skips the identity DDL but still resolves', async () => {
    const pool = new RecordingPool();

    await relationalStoreOver(pool, false).storageIdentity();

    expect(pool.statements.some((statement) => statement.sql.includes(`CREATE TABLE IF NOT EXISTS ${STORAGE_IDENTITY_TABLE}`))).toBe(false);
  });

  test('a dialect without an identity table rejects, which callers treat as unknown', async () => {
    const dialectWithoutIdentity = { ...postgresDialect, storageIdentityDdl: undefined };
    const store = new RelationalDurableStateStore({
      storeName: 'IdentityProbeStore',
      dialect: dialectWithoutIdentity,
      ownsPool: false,
      openPool: async () => new RecordingPool(),
    });

    await expect(store.storageIdentity()).rejects.toThrow(JournalError);
  });
});

/** Map-backed backend with honest create-only CAS. */
class FakeObjectStorageBackend implements ObjectStorageBackend {
  readonly objects = new Map<string, Uint8Array>();
  /** Assigned by the delegation test — optional on the contract, so optional here. */
  storageIdentity?: () => Promise<string>;

  async put(key: string, body: Uint8Array, options?: { ifNoneMatch?: '*' }): Promise<{ etag: string }> {
    if (options?.ifNoneMatch === '*' && this.objects.has(key)) {
      throw new ObjectStorageConcurrencyError(key);
    }
    this.objects.set(key, body);
    return { etag: 'fixture' };
  }

  async get(key: string) {
    const body = this.objects.get(key);
    if (body === undefined) return none;
    return some({ body, etag: 'fixture', lastModified: new Date(0) });
  }

  async delete(): Promise<void> {}
  async list() { return []; }
}

describe('object storage', () => {
  test('mints under the root identity key and stays stable', async () => {
    const backend = new FakeObjectStorageBackend();
    const identity = await resolveObjectStorageIdentity(backend);
    expect(identity).toMatch(UUID_PATTERN);
    expect(backend.objects.has('storage-identity')).toBe(true);
    expect(await resolveObjectStorageIdentity(backend)).toBe(identity);
  });

  test('losing the create-only race returns the stored identity', async () => {
    const backend = new FakeObjectStorageBackend();
    backend.objects.set('storage-identity', new TextEncoder().encode('already-there'));

    expect(await resolveObjectStorageIdentity(backend)).toBe('already-there');
  });

  test('the store delegates to its backend', async () => {
    const backend = new FakeObjectStorageBackend();
    backend.objects.set('storage-identity', new TextEncoder().encode('bucket-identity'));
    backend.storageIdentity = () => resolveObjectStorageIdentity(backend);

    const store = new ObjectStorageSnapshotStore({ backend });
    expect(await store.storageIdentity()).toBe('bucket-identity');
  });
});

describe('wrappers', () => {
  const fakeCache = { get: async () => null, set: async () => {}, delete: async () => {} } as unknown as Cache;

  test('the cached snapshot store reports the wrapped store\'s identity', async () => {
    const inner = new InMemorySnapshotStore();
    const cached = new CachedSnapshotStore(inner, CachedSnapshotStoreOptions.create().withCache(fakeCache));

    expect(await cached.storageIdentity()).toBe(await inner.storageIdentity());
  });

  test('a wrapped store without an identity is a rejection, not an invention', async () => {
    const bare: SnapshotStore = {
      save: async () => { throw new Error('unused'); },
      loadLatest: async () => none,
      loadBefore: async () => none,
      delete: async () => {},
    };
    const cached = new CachedSnapshotStore(bare, CachedSnapshotStoreOptions.create().withCache(fakeCache));

    await expect(cached.storageIdentity()).rejects.toThrow(JournalError);
  });
});
