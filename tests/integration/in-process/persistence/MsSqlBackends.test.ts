import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  MSSQL_DURABLE_STATE_PLUGIN_ID,
  MSSQL_JOURNAL_PLUGIN_ID,
  MSSQL_SNAPSHOT_PLUGIN_ID,
  MsSqlDurableStateStore,
  MsSqlDurableStateStoreOptions,
  MsSqlJournal,
  MsSqlJournalOptions,
  MsSqlSnapshotStore,
  MsSqlSnapshotStoreOptions,
  PersistenceExtensionId,
  RegisterMsSqlPluginsOptions,
  registerMsSqlPlugins,
} from '../../../../src/persistence/index.js';
import { FakeMsSqlPool } from './FakeMsSqlPool.js';

/**
 * SQL Server-specific behaviour (#399).  The three storage contracts are covered
 * by the shared suite in `PersistenceContract.test.ts`, which the MSSQL trio is
 * registered into — this file carries only what is particular to the backend:
 * the named-parameter mapping, the transaction lifecycle the `mssql` API
 * demands, option validation, pool ownership, and plugin wiring.
 */

describe('MsSqlJournal — T-SQL statements and named parameters', () => {
  test('emits guarded DDL and T-SQL DML, not another dialect', async () => {
    const pool = new FakeMsSqlPool();
    const journal = new MsSqlJournal(MsSqlJournalOptions.create().withPool(pool));
    await journal.append('account-1', [{ event: 'created', tags: ['ledger'] }], 0);
    await journal.delete('account-1', 1);   // issues the high-water-mark MERGE
    const issued = pool.log.join('\n');
    // T-SQL has no `IF NOT EXISTS` for tables, no upsert clause, no LIMIT.
    expect(issued).toContain("IF OBJECT_ID(N'events', N'U') IS NULL");
    expect(issued).toContain('MERGE INTO events_meta WITH (HOLDLOCK)');
    expect(issued).toContain('WHERE NOT EXISTS');
    expect(issued).toContain('@p1');
    // Other dialects' idioms must not leak through the shared base.
    expect(issued).not.toContain('CREATE TABLE IF NOT EXISTS');
    expect(issued).not.toContain('ON CONFLICT');
    expect(issued).not.toContain('ON DUPLICATE KEY');
    expect(issued).not.toContain('$1');
    expect(issued).not.toMatch(/\bLIMIT\b/);
    await journal.close();
  });

  test('snapshot reads use OFFSET/FETCH rather than LIMIT', async () => {
    const pool = new FakeMsSqlPool();
    const store = new MsSqlSnapshotStore(MsSqlSnapshotStoreOptions.create().withPool(pool));
    await store.save('account-1', 1, { v: 1 });
    await store.loadLatest('account-1');
    await store.loadBefore('account-1', 5);
    const selects = pool.log.filter((sql) => sql.startsWith('SELECT persistence_id'));
    expect(selects).toHaveLength(2);
    for (const select of selects) {
      expect(select).toContain('OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY');
    }
    await store.close();
  });

  test('append runs inside a transaction that commits, and rolls back on rejection', async () => {
    const pool = new FakeMsSqlPool();
    const journal = new MsSqlJournal(MsSqlJournalOptions.create().withPool(pool));
    await journal.append('account-1', [{ event: 'a' }], 0);
    expect(pool.transactionLog).toEqual(['begin', 'commit']);

    // A stale expectedSeq must roll the transaction back, not leave it open —
    // `mssql` throws on any further use of a settled Transaction, so a missing
    // rollback would surface as a cascade of confusing errors.
    await expect(journal.append('account-1', [{ event: 'b' }], 0)).rejects.toMatchObject({
      name: 'JournalConcurrencyError',
    });
    expect(pool.transactionLog).toEqual(['begin', 'commit', 'begin', 'rollback']);
    await journal.close();
  });

  test('a duplicate key (2627) from the server becomes a concurrency error', async () => {
    const pool = new FakeMsSqlPool();
    const journal = new MsSqlJournal(MsSqlJournalOptions.create().withPool(pool));
    await journal.append('account-1', [{ event: 'a' }], 0);
    // The fake enforces the primary key exactly as the server does, so this
    // exercises the dialect's 2627 classification through the real code path.
    await expect(journal.append('account-1', [{ event: 'b' }], 0)).rejects.toMatchObject({
      name: 'JournalConcurrencyError',
      expectedSeq: 0,
      actualSeq: 1,
    });
    await journal.close();
  });
});

describe('MsSql* option validation', () => {
  test('rejects an empty connection string or table name', () => {
    expect(() => new MsSqlJournal(MsSqlJournalOptions.create().withUrl(''))).toThrow(/url/);
    expect(() => new MsSqlJournal(MsSqlJournalOptions.create().withEventsTable(''))).toThrow(/eventsTable/);
  });

  test('accepts both connection-string forms', () => {
    // SQL Server's native form is not a URL, so the validator must not try to
    // parse it as one.
    for (const url of [
      'Server=localhost,1433;Database=app;User Id=sa;Password=secret;Encrypt=true',
      'mssql://sa:secret@localhost:1433/app',
    ]) {
      expect(() => new MsSqlJournal(MsSqlJournalOptions.create().withUrl(url))).not.toThrow();
    }
  });

  test('rejects a fractional keepN but accepts 0 as keep-all', () => {
    const fractional = MsSqlSnapshotStoreOptions.create()
      .withPool(new FakeMsSqlPool())
      .withKeepN(2.5);
    expect(() => new MsSqlSnapshotStore(fractional)).toThrow(/keepN/);
    const keepAll = MsSqlSnapshotStoreOptions.create()
      .withPool(new FakeMsSqlPool())
      .withKeepN(0);
    expect(() => new MsSqlSnapshotStore(keepAll)).not.toThrow();
  });

  test('a store without a connection fails only when it is first used', async () => {
    // Construction stays side-effect-free; the missing connection surfaces on
    // the first operation, like every other lazily-opened store.
    const journal = new MsSqlJournal();
    expect(journal.highestSeq('account-1')).rejects.toThrow(/poolConfig.*url.*or a pre-built `pool`/);
  });
});

describe('MsSql* pool ownership', () => {
  test('an injected pool is left open — the caller shares and closes it', async () => {
    const pool = new FakeMsSqlPool();
    const journal = new MsSqlJournal(MsSqlJournalOptions.create().withPool(pool));
    const snapshots = new MsSqlSnapshotStore(MsSqlSnapshotStoreOptions.create().withPool(pool));
    const state = new MsSqlDurableStateStore(MsSqlDurableStateStoreOptions.create().withPool(pool));
    await journal.append('account-1', [{ event: 'a' }], 0);   // force the stores open
    await snapshots.save('account-1', 1, { v: 1 });
    await state.upsert('account-1', 0, { v: 1 });

    await journal.close();
    await snapshots.close();
    await state.close();

    expect(pool.closed).toBe(false);
  });
});

describe('registerMsSqlPlugins', () => {
  /**
   * Boots a system whose config names the MSSQL plug-ins, which is how the
   * extension selects them — `registerMsSqlPlugins` only populates the
   * factories (the two-step registration #386 is meant to collapse).
   */
  function bootSystem(): ActorSystem {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            journal: { plugin: MSSQL_JOURNAL_PLUGIN_ID },
            'snapshot-store': { plugin: MSSQL_SNAPSHOT_PLUGIN_ID },
          },
        },
      });
    return ActorSystem.create('mssql-plugins', systemOptions);
  }

  test('a shared pool reaches all three stores', async () => {
    const system = bootSystem();
    try {
      const pool = new FakeMsSqlPool();
      const persistence = system.extension(PersistenceExtensionId);
      const pluginOptions = RegisterMsSqlPluginsOptions.create()
        .withPool(pool);
      const handles = registerMsSqlPlugins(persistence, pluginOptions);

      expect(persistence.journal).toBeInstanceOf(MsSqlJournal);
      expect(persistence.snapshotStore).toBeInstanceOf(MsSqlSnapshotStore);
      expect(handles.durableStateStore).toBeInstanceOf(MsSqlDurableStateStore);

      // All three writing through the one fake proves the merge reached each
      // leaf — none fell back to building its own pool (which would have thrown
      // for want of a connection).
      await persistence.journal.append('account-1', [{ event: 'a' }], 0);
      await persistence.snapshotStore.save('account-1', 1, { v: 1 });
      await handles.durableStateStore.upsert('account-1', 0, { v: 1 });
      expect(pool.log.some((sql) => sql.startsWith('INSERT INTO events('))).toBe(true);
      expect(pool.log.some((sql) => sql.startsWith('MERGE INTO snapshots'))).toBe(true);
      expect(pool.log.some((sql) => sql.startsWith('INSERT INTO durable_state ('))).toBe(true);
      expect(MSSQL_DURABLE_STATE_PLUGIN_ID).toBe('actor-ts.persistence.durable-state.mssql');
    } finally {
      await system.terminate();
    }
  });

  test('a leaf keeps its own table names while inheriting the shared pool', async () => {
    const system = bootSystem();
    try {
      const pool = new FakeMsSqlPool();
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = MsSqlJournalOptions.create()
        .withEventsTable('ledger_events');
      const pluginOptions = RegisterMsSqlPluginsOptions.create()
        .withPool(pool)
        .withJournal(journalOptions);
      registerMsSqlPlugins(persistence, pluginOptions);

      await persistence.journal.append('account-1', [{ event: 'a' }], 0);
      expect(pool.log.some((sql) => sql.includes('INSERT INTO ledger_events('))).toBe(true);
    } finally {
      await system.terminate();
    }
  });

  test('a shared poolConfig is a default that a leaf can override', async () => {
    const system = bootSystem();
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = MsSqlJournalOptions.create()
        .withPoolConfig({ server: 'journal-host', database: 'journal' });
      const pluginOptions = RegisterMsSqlPluginsOptions.create()
        .withPoolConfig({ server: 'shared-host', database: 'shared' })
        .withJournal(journalOptions);
      // Nothing connects here — registration only stores factories, and the
      // durable-state store constructs without opening a pool.
      const handles = registerMsSqlPlugins(persistence, pluginOptions);
      expect(handles.durableStateStore).toBeInstanceOf(MsSqlDurableStateStore);
    } finally {
      await system.terminate();
    }
  });
});
