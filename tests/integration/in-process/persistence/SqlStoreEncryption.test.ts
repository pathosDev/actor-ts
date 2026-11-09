import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  DurableStateActor,
  DurableStateOptions,
  JournalError,
  LibSqlDurableStateStore,
  LibSqlDurableStateStoreOptions,
  LibSqlSnapshotStore,
  LibSqlSnapshotStoreOptions,
  PostgresDurableStateStore,
  PostgresDurableStateStoreOptions,
  PostgresSnapshotStore,
  PostgresSnapshotStoreOptions,
  SqliteDurableStateStore,
  SqliteDurableStateStoreOptions,
  SqliteSnapshotStore,
  SqliteSnapshotStoreOptions,
  type DurableStateStore,
  type EncryptionConfig,
  type IntegrityConfig,
  type PersistenceOptions,
  type SnapshotStore,
} from '../../../../src/persistence/index.js';
import { getSqliteDriver } from '../../../../src/runtime/sqlite/index.js';
import { gracefulStop } from '../../../../src/pattern/GracefulStop.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { FakeLibSqlClient } from './FakeLibSqlClient.js';
import { FakePgPool } from './FakePgPool.js';

/**
 * The SQL snapshot and durable-state stores honour the per-actor persistence
 * hooks (#1802).  The SQLite stores run against a real database file, so the
 * stored column can be read and rewritten the way someone with write access
 * to the table would; the Postgres and libSQL fakes stand in for the rest of
 * the relational family, which shares one implementation.
 */

const MASTER_KEY = new Uint8Array(32).fill(11);
const OTHER_KEY = new Uint8Array(32).fill(13);
const ENCRYPTION: EncryptionConfig = { mode: 'client-aes256-gcm', masterKey: MASTER_KEY, info: 'sql-store-test' };
const WRONG_ENCRYPTION: EncryptionConfig = { mode: 'client-aes256-gcm', masterKey: OTHER_KEY, info: 'sql-store-test' };
const INTEGRITY: IntegrityConfig = { mode: 'hmac-sha256', integrityKey: new Uint8Array(32).fill(17) };
const SEALED: PersistenceOptions = { encryption: ENCRYPTION, integrity: INTEGRITY, compression: { algorithm: 'gzip' } };

type Account = { readonly owner: string; readonly balance: number };
const STATE: Account = { owner: 'a name nobody reading the table should see', balance: 1200 };

const scratch = mkdtempSync(join(tmpdir(), 'sql-store-encryption-'));
let databaseCounter = 0;
const databasePath = (): string => join(scratch, `store-${++databaseCounter}.db`);

afterAll(() => {
  // An empty path would empty the working directory on Bun 1.4.2.  Best
  // effort, as in `StorageIdentity.test.ts`: on Windows the file the actor
  // test used can still be held for a moment after its store is closed — with
  // or without a hook, so it says nothing about what this suite tests.
  if (scratch === '') return;
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
});

/** A second connection to the same file — the table as an operator, or an attacker, sees it. */
async function rawTable(path: string): Promise<{
  payload(sql: string, ...params: unknown[]): string;
  run(sql: string, ...params: unknown[]): void;
  close(): void;
}> {
  const database = (await getSqliteDriver()).open(path);
  return {
    payload: (sql, ...params) => (database.prepare(sql).get(...params) as { payload: string }).payload,
    run: (sql, ...params) => { database.prepare(sql).run(...params); },
    close: () => database.close(),
  };
}

type SnapshotStoreCase = { readonly label: string; readonly make: () => SnapshotStore };
type DurableStateStoreCase = { readonly label: string; readonly make: () => DurableStateStore };

const SNAPSHOT_STORES: ReadonlyArray<SnapshotStoreCase> = [
  { label: 'SqliteSnapshotStore', make: () => new SqliteSnapshotStore(SqliteSnapshotStoreOptions.create().withPath(databasePath())) },
  {
    label: 'PostgresSnapshotStore',
    make: () => new PostgresSnapshotStore(PostgresSnapshotStoreOptions.create().withPool(new FakePgPool())),
  },
  {
    label: 'LibSqlSnapshotStore',
    make: () => new LibSqlSnapshotStore(LibSqlSnapshotStoreOptions.create().withClient(new FakeLibSqlClient())),
  },
];

const DURABLE_STATE_STORES: ReadonlyArray<DurableStateStoreCase> = [
  {
    label: 'SqliteDurableStateStore',
    make: () => new SqliteDurableStateStore(SqliteDurableStateStoreOptions.create().withPath(databasePath())),
  },
  {
    label: 'PostgresDurableStateStore',
    make: () => new PostgresDurableStateStore(PostgresDurableStateStoreOptions.create().withPool(new FakePgPool())),
  },
  {
    label: 'LibSqlDurableStateStore',
    make: () => new LibSqlDurableStateStore(LibSqlDurableStateStoreOptions.create().withClient(new FakeLibSqlClient())),
  },
];

for (const { label, make } of SNAPSHOT_STORES) describe(`${label} — sealed snapshots`, () => {
  test('a snapshot written under all three hooks loads back under them', async () => {
    const store = make();
    try {
      await store.save('account-1', 4, STATE, SEALED);
      const loaded = (await store.loadLatest<Account>('account-1', SEALED)).toNullable();
      expect(loaded?.state).toEqual(STATE);
      expect(loaded?.sequenceNr).toBe(4);
      const before = (await store.loadBefore<Account>('account-1', 5, SEALED)).toNullable();
      expect(before?.state).toEqual(STATE);
    } finally {
      await store.close?.();
    }
  });

  test('reading without the key, or with the wrong one, is refused', async () => {
    const store = make();
    try {
      await store.save('account-1', 4, STATE, { encryption: ENCRYPTION });
      await expect(store.loadLatest('account-1')).rejects.toBeInstanceOf(JournalError);
      await expect(store.loadLatest('account-1', { encryption: WRONG_ENCRYPTION })).rejects.toThrow(/refused/);
    } finally {
      await store.close?.();
    }
  });

  test('an actor without hooks keeps writing and reading plain rows', async () => {
    const store = make();
    try {
      await store.save('account-1', 1, STATE);
      expect((await store.loadLatest<Account>('account-1')).toNullable()?.state).toEqual(STATE);
      // …which an actor that has since turned encryption on refuses (#965).
      await expect(store.loadLatest('account-1', { encryption: ENCRYPTION })).rejects.toThrow(/plaintext JSON/);
    } finally {
      await store.close?.();
    }
  });
});

for (const { label, make } of DURABLE_STATE_STORES) describe(`${label} — sealed durable state`, () => {
  test('state upserted under all three hooks loads back under them, across revisions', async () => {
    const store = make();
    try {
      await store.upsert('account-1', 0, STATE, SEALED);
      const second: Account = { ...STATE, balance: 900 };
      await store.upsert('account-1', 1, second, SEALED);
      const loaded = (await store.load<Account>('account-1', SEALED)).toNullable();
      expect(loaded?.revision).toBe(2);
      expect(loaded?.state).toEqual(second);
    } finally {
      await store.close?.();
    }
  });

  test('reading without the key, or with the wrong one, is refused', async () => {
    const store = make();
    try {
      await store.upsert('account-1', 0, STATE, { encryption: ENCRYPTION });
      await expect(store.load('account-1')).rejects.toBeInstanceOf(JournalError);
      await expect(store.load('account-1', { encryption: WRONG_ENCRYPTION })).rejects.toThrow(/refused/);
    } finally {
      await store.close?.();
    }
  });
});

describe('the stored column, read and rewritten directly (SQLite)', () => {
  test('a sealed snapshot row holds no plaintext', async () => {
    const path = databasePath();
    const store = new SqliteSnapshotStore(SqliteSnapshotStoreOptions.create().withPath(path));
    await store.save('account-1', 4, STATE, { encryption: ENCRYPTION });
    await store.close();
    const table = await rawTable(path);
    try {
      const payload = table.payload('SELECT payload FROM snapshots WHERE persistence_id = ?', 'account-1');
      expect(payload.startsWith('ats1:')).toBe(true);
      expect(payload).not.toContain('nobody reading');
      expect(Buffer.from(payload.slice('ats1:'.length), 'base64').toString('latin1')).not.toContain('nobody reading');
    } finally {
      table.close();
    }
  });

  test('a snapshot row moved to another sequence number is refused (#612)', async () => {
    const path = databasePath();
    const options = SqliteSnapshotStoreOptions.create()
      .withPath(path)
      .withKeepN(0);
    const store = new SqliteSnapshotStore(options);
    await store.save('account-1', 4, STATE, { encryption: ENCRYPTION });
    await store.close();
    const table = await rawTable(path);
    try {
      table.run('UPDATE snapshots SET sequence_nr = 9 WHERE persistence_id = ?', 'account-1');
    } finally {
      table.close();
    }
    const reopened = new SqliteSnapshotStore(SqliteSnapshotStoreOptions.create().withPath(path));
    try {
      await expect(reopened.loadLatest('account-1', { encryption: ENCRYPTION })).rejects.toThrow(/account-1@9 refused/);
    } finally {
      await reopened.close();
    }
  });

  test('a durable-state payload paired with another revision is refused (#612)', async () => {
    const path = databasePath();
    const store = new SqliteDurableStateStore(SqliteDurableStateStoreOptions.create().withPath(path));
    await store.upsert('account-1', 0, STATE, { integrity: INTEGRITY });
    await store.close();
    const table = await rawTable(path);
    try {
      table.run('UPDATE durable_state SET revision = 7 WHERE persistence_id = ?', 'account-1');
    } finally {
      table.close();
    }
    const reopened = new SqliteDurableStateStore(SqliteDurableStateStoreOptions.create().withPath(path));
    try {
      await expect(reopened.load('account-1', { integrity: INTEGRITY })).rejects.toThrow(/integrity/);
    } finally {
      await reopened.close();
    }
  });

  test('a plaintext row slipped under an encrypting actor is refused, and re-admitted only by the window', async () => {
    const path = databasePath();
    const store = new SqliteDurableStateStore(SqliteDurableStateStoreOptions.create().withPath(path));
    await store.upsert('account-1', 0, STATE, { encryption: ENCRYPTION });
    await store.close();
    const table = await rawTable(path);
    try {
      table.run(
        'UPDATE durable_state SET payload = ? WHERE persistence_id = ?',
        JSON.stringify({ owner: 'attacker', balance: 1_000_000 }),
        'account-1',
      );
    } finally {
      table.close();
    }
    const strict = new SqliteDurableStateStore(SqliteDurableStateStoreOptions.create().withPath(path));
    try {
      await expect(strict.load('account-1', { encryption: ENCRYPTION })).rejects.toThrow(/plaintext JSON/);
    } finally {
      await strict.close();
    }
    const migrationOptions = SqliteDurableStateStoreOptions.create()
      .withPath(path)
      .withAllowPlaintextRows(true);
    const migrating = new SqliteDurableStateStore(migrationOptions);
    try {
      const loaded = (await migrating.load<Account>('account-1', { encryption: ENCRYPTION })).toNullable();
      expect(loaded?.state.owner).toBe('attacker');
      // The next write seals the row, and the window is no longer needed for it.
      await migrating.upsert('account-1', 1, STATE, { encryption: ENCRYPTION });
    } finally {
      await migrating.close();
    }
    const after = new SqliteDurableStateStore(SqliteDurableStateStoreOptions.create().withPath(path));
    try {
      expect((await after.load<Account>('account-1', { encryption: ENCRYPTION })).toNullable()?.state).toEqual(STATE);
    } finally {
      await after.close();
    }
  });
});

/* -------------------- end to end: the hook, not the options ---------------- */

type DepositCommand = { readonly kind: 'deposit'; readonly amount: number; readonly replyTo: ActorRef<BalanceReply> };
type BalanceCommand = { readonly kind: 'balance'; readonly replyTo: ActorRef<BalanceReply> };
type AccountCommand = DepositCommand | BalanceCommand;
type BalanceReply = { readonly kind: 'balance'; readonly balance: number };

class EncryptedAccount extends DurableStateActor<AccountCommand, Account> {
  protected override encryption(): EncryptionConfig | undefined { return ENCRYPTION; }

  override async onCommand(command: AccountCommand): Promise<void> {
    if (command.kind === 'deposit') await this.persist({ ...this.state, balance: this.state.balance + command.amount });
    command.replyTo.tell({ kind: 'balance', balance: this.state.balance });
  }
}

class ReplySink extends Actor<BalanceReply> {
  constructor(private readonly replies: BalanceReply[]) { super(); }
  override onReceive(reply: BalanceReply): void { this.replies.push(reply); }
}

describe('DurableStateActor with encryption() over a SQL store (#1802)', () => {
  test('starts instead of being refused, seals its row, and recovers it after a restart', async () => {
    const path = databasePath();
    const store = new SqliteDurableStateStore(SqliteDurableStateStoreOptions.create().withPath(path));
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('sql-store-encryption', systemOptions);
    const replies: BalanceReply[] = [];
    const accountOptions = DurableStateOptions.create<Account>()
      .withPersistenceId('account-7')
      .withStore(store)
      .withEmptyState(() => ({ owner: 'nobody reading the table', balance: 0 }));
    try {
      const sink = system.spawnAnonymous(() => new ReplySink(replies));
      const first = system.spawnAnonymous(() => new EncryptedAccount(accountOptions));
      first.tell({ kind: 'deposit', amount: 250, replyTo: sink });
      await awaitCondition(() => replies.length === 1, { timeoutMs: 4_000, label: 'the deposit was persisted' });
      expect(await gracefulStop(first, 4_000)).toBe(true);

      const table = await rawTable(path);
      try {
        const payload = table.payload('SELECT payload FROM durable_state WHERE persistence_id = ?', 'account-7');
        expect(payload.startsWith('ats1:')).toBe(true);
        expect(payload).not.toContain('nobody reading');
      } finally {
        table.close();
      }

      const restarted = system.spawnAnonymous(() => new EncryptedAccount(accountOptions));
      restarted.tell({ kind: 'balance', replyTo: sink });
      await awaitCondition(() => replies.length === 2, { timeoutMs: 4_000, label: 'the restarted actor answered' });
      expect(replies[1]).toEqual({ kind: 'balance', balance: 250 });
    } finally {
      await system.terminate();
      await store.close();
    }
  });
});
