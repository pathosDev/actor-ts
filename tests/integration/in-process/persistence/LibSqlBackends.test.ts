import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import {
  LIBSQL_DURABLE_STATE_PLUGIN_ID,
  LIBSQL_JOURNAL_PLUGIN_ID,
  LIBSQL_SNAPSHOT_PLUGIN_ID,
  LibSqlDurableStateStore,
  LibSqlDurableStateStoreOptions,
  LibSqlJournal,
  LibSqlJournalOptions,
  LibSqlSnapshotStore,
  LibSqlSnapshotStoreOptions,
  PersistenceExtensionId,
  RegisterLibSqlPluginsOptions,
  registerLibSqlPlugins,
} from '../../../../src/persistence/index.js';
import { FakeLibSqlClient } from './FakeLibSqlClient.js';

/**
 * libSQL-specific behaviour (#400).  The three storage contracts themselves are
 * covered by the shared suite in `PersistenceContract.test.ts`, which the libSQL
 * trio is registered into — this file carries only what is particular to the
 * backend: option validation, client ownership, and plugin wiring.
 */

describe('LibSqlJournal — schema compatibility with the local SQLite backend', () => {
  test('emits SQLite dialect statements, not Postgres ones', async () => {
    const client = new FakeLibSqlClient();
    const journal = new LibSqlJournal(LibSqlJournalOptions.create().withClient(client));
    await journal.append('account-1', ['created'], 0, ['ledger']);
    await journal.delete('account-1', 1);   // issues the high-water-mark upsert
    const issued = client.log.join('\n');
    // Matching `SqliteJournal`'s statements is what makes a database portable
    // between a local file and Turso without a migration.
    expect(issued).toContain('INSERT OR IGNORE INTO events_tags');
    expect(issued).toContain('sequence_nr INTEGER NOT NULL');
    expect(issued).toContain('MAX(deleted_to, excluded.deleted_to)');
    // Postgres-isms must not leak through the shared base.
    expect(issued).not.toContain('$1');
    expect(issued).not.toContain('GREATEST');
    expect(issued).not.toContain('BIGINT');
    await journal.close();
  });

  test('the concurrency backstop recognises a SQLite constraint violation', async () => {
    const client = new FakeLibSqlClient();
    const journal = new LibSqlJournal(LibSqlJournalOptions.create().withClient(client));
    await journal.append('account-1', ['a'], 0);
    // Two writers agreeing on the head: the second trips the primary key, and
    // the dialect has to classify a `SQLITE_CONSTRAINT_*` code as a duplicate
    // key so it surfaces as a concurrency error rather than a raw driver error.
    expect(journal.append('account-1', ['b'], 0)).rejects.toMatchObject({
      name: 'JournalConcurrencyError',
      expectedSeq: 0,
      actualSeq: 1,
    });
    await journal.close();
  });
});

describe('LibSql* option validation', () => {
  const localPaths = [':memory:', 'file:local.db', 'file:/tmp/actor-ts.db'];

  for (const url of localPaths) {
    test(`rejects the local database URL ${JSON.stringify(url)} with a pointer to SqliteJournal`, () => {
      // `@libsql/client/web` cannot open a local database at all, so without
      // this rule the failure would surface deep in the driver on first append.
      expect(() => new LibSqlJournal(LibSqlJournalOptions.create().withUrl(url)))
        .toThrow(/SqliteJournal/);
    });
  }

  test('rejects an unsupported URL scheme', () => {
    expect(() => new LibSqlJournal(LibSqlJournalOptions.create().withUrl('postgres://host/db')))
      .toThrow(/must use protocol/);
  });

  test('rejects a malformed URL', () => {
    expect(() => new LibSqlJournal(LibSqlJournalOptions.create().withUrl('not a url')))
      .toThrow(/must be a valid URL/);
  });

  test('never renders the URL credential into the rejection (#590)', () => {
    // A Turso URL is handed out with its auth token, and this message ends up
    // in an ERROR log via ActorCell.
    let caught: unknown;
    try {
      new LibSqlJournal(LibSqlJournalOptions.create().withUrl('postgres://admin:hunter2@host/db'));
    } catch (e) {
      caught = e;
    }
    const err = caught as { message: string; value: unknown };
    expect(err.message).toContain('must use protocol');
    expect(err.message).toContain('postgres://***@host/db');
    expect(err.message).not.toContain('hunter2');
    expect(err.value).toBe('postgres://***@host/db');
  });

  test('accepts the Turso and self-hosted schemes', () => {
    for (const url of ['libsql://db.turso.io', 'https://db.turso.io', 'http://127.0.0.1:8080', 'wss://db.turso.io']) {
      expect(() => new LibSqlJournal(LibSqlJournalOptions.create().withUrl(url))).not.toThrow();
    }
  });

  test('rejects an empty auth token', () => {
    const journalOptions = LibSqlJournalOptions.create()
      .withUrl('libsql://db.turso.io')
      .withAuthToken('');
    expect(() => new LibSqlJournal(journalOptions)).toThrow(/authToken/);
  });

  test('rejects a fractional keepN but accepts 0 as keep-all', () => {
    const fractional = LibSqlSnapshotStoreOptions.create()
      .withClient(new FakeLibSqlClient())
      .withKeepN(2.5);
    expect(() => new LibSqlSnapshotStore(fractional)).toThrow(/keepN/);
    const keepAll = LibSqlSnapshotStoreOptions.create()
      .withClient(new FakeLibSqlClient())
      .withKeepN(0);
    expect(() => new LibSqlSnapshotStore(keepAll)).not.toThrow();
  });

  test('a store without a url or client fails only when it is first used', async () => {
    // Construction stays side-effect-free; the missing connection surfaces on
    // the first operation, like every other lazily-opened store.
    const journal = new LibSqlJournal();
    expect(journal.highestSeq('account-1')).rejects.toThrow(/url.*or a pre-built `client`/);
  });
});

describe('LibSql* client ownership', () => {
  test('an injected client is left open — the caller shares and closes it', async () => {
    const client = new FakeLibSqlClient();
    const journal = new LibSqlJournal(LibSqlJournalOptions.create().withClient(client));
    const snapshots = new LibSqlSnapshotStore(LibSqlSnapshotStoreOptions.create().withClient(client));
    const state = new LibSqlDurableStateStore(LibSqlDurableStateStoreOptions.create().withClient(client));
    await journal.append('account-1', ['a'], 0);   // force the stores open
    await snapshots.save('account-1', 1, { v: 1 });
    await state.upsert('account-1', 0, { v: 1 });

    await journal.close();
    await snapshots.close();
    await state.close();

    expect(client.closed).toBe(false);
  });
});

describe('registerLibSqlPlugins', () => {
  /**
   * Boots a system whose config names the libSQL plug-ins, which is how the
   * extension selects them — `registerLibSqlPlugins` only populates the
   * factories (the two-step registration #386 is meant to collapse).
   */
  function bootSystem(): ActorSystem {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({
        'actor-ts': {
          persistence: {
            journal: { plugin: LIBSQL_JOURNAL_PLUGIN_ID },
            'snapshot-store': { plugin: LIBSQL_SNAPSHOT_PLUGIN_ID },
          },
        },
      });
    return ActorSystem.create('libsql-plugins', systemOptions);
  }

  test('registers the journal and snapshot store under their plugin ids', async () => {
    const system = bootSystem();
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const pluginOptions = RegisterLibSqlPluginsOptions.create()
        .withClient(new FakeLibSqlClient());
      const handles = registerLibSqlPlugins(persistence, pluginOptions);

      expect(handles.durableStateStore).toBeInstanceOf(LibSqlDurableStateStore);
      expect(persistence.journal).toBeInstanceOf(LibSqlJournal);
      expect(persistence.snapshotStore).toBeInstanceOf(LibSqlSnapshotStore);
      // The durable-state id exists for symmetry, awaiting the extension's
      // durable-state registry (#387).
      expect(LIBSQL_DURABLE_STATE_PLUGIN_ID).toBe('actor-ts.persistence.durable-state.libsql');
    } finally {
      await system.terminate();
    }
  });

  test('a shared client reaches all three stores', async () => {
    const system = bootSystem();
    try {
      const client = new FakeLibSqlClient();
      const persistence = system.extension(PersistenceExtensionId);
      const pluginOptions = RegisterLibSqlPluginsOptions.create()
        .withClient(client);
      const handles = registerLibSqlPlugins(persistence, pluginOptions);

      // All three writing through the one fake proves the merge reached each
      // leaf — none of them fell back to building its own client (which would
      // have thrown for want of a url).
      await persistence.journal.append('account-1', ['a'], 0);
      await persistence.snapshotStore.save('account-1', 1, { v: 1 });
      await handles.durableStateStore.upsert('account-1', 0, { v: 1 });
      expect(client.log.some((sql) => sql.startsWith('INSERT INTO events('))).toBe(true);
      expect(client.log.some((sql) => sql.startsWith('INSERT INTO snapshots('))).toBe(true);
      expect(client.log.some((sql) => sql.startsWith('INSERT INTO durable_state('))).toBe(true);
    } finally {
      await system.terminate();
    }
  });

  test('a leaf keeps its own table names while inheriting the shared client', async () => {
    const system = bootSystem();
    try {
      const client = new FakeLibSqlClient();
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = LibSqlJournalOptions.create()
        .withEventsTable('ledger_events');
      const pluginOptions = RegisterLibSqlPluginsOptions.create()
        .withClient(client)
        .withJournal(journalOptions);
      registerLibSqlPlugins(persistence, pluginOptions);

      await persistence.journal.append('account-1', ['a'], 0);
      expect(client.log.some((sql) => sql.includes('INSERT INTO ledger_events('))).toBe(true);
    } finally {
      await system.terminate();
    }
  });

  test('a shared url is a default that a leaf can override', async () => {
    const system = bootSystem();
    try {
      const persistence = system.extension(PersistenceExtensionId);
      const journalOptions = LibSqlJournalOptions.create()
        .withUrl('libsql://journal.turso.io');
      const pluginOptions = RegisterLibSqlPluginsOptions.create()
        .withUrl('libsql://shared.turso.io')
        .withAuthToken('token')
        .withJournal(journalOptions);
      // Nothing connects here — registration only stores factories, and the
      // durable-state store constructs without opening a client.
      const handles = registerLibSqlPlugins(persistence, pluginOptions);
      expect(handles.durableStateStore).toBeInstanceOf(LibSqlDurableStateStore);
    } finally {
      await system.terminate();
    }
  });
});
