import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { ActorFactory } from '../../../../src/Actor.js';
import type { ConfigObject } from '../../../../src/index.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { getSqliteDriver } from '../../../../src/runtime/sqlite/index.js';
import {
  DurableStateActor,
  DurableStateOptions,
  InMemoryDurableStateStore,
  PersistenceExtensionId,
  registerSqlitePlugins,
  RegisterSqlitePluginsOptions,
  SqliteDurableStateStore,
  SqliteDurableStateStoreOptions,
  SqliteJournal,
  SqliteJournalOptions,
  SqliteSnapshotStore,
  SQLITE_DURABLE_STATE_PLUGIN_ID,
  SQLITE_JOURNAL_PLUGIN_ID,
  SQLITE_SNAPSHOT_PLUGIN_ID,
} from '../../../../src/persistence/index.js';

/**
 * #872 — the SQLite plug-in end to end, and the proof that a HOCON block is
 * actually read.
 *
 * SQLite is the only shipped backend that runs in-process **against a real
 * database**, which is what makes this the one arm that can show "selected and
 * configured purely from HOCON, connects, round-trips" without Docker.  It is
 * also the backend that had no registration story at all: no plug-in file, no
 * ids — while `configuration.mdx` and `examples/chat/application.conf` both
 * printed `actor-ts.persistence.journal.sqlite` as a plugin id that resolved
 * to nothing.
 *
 * The assertions that matter are the *values*, not the wiring: a table name
 * read back out of the database is what distinguishes a leaf that is read from
 * a leaf that merely exists.  `NoDeadConfigKeys` cannot make that distinction
 * here — its `coveringAccessor` falls back to the block root, which
 * `SqlitePlugin.ts` contains as a plugin-id literal regardless.
 */

const roots: string[] = [];

function tempDatabase(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'actor-ts-sqlite-'));
  roots.push(dir);
  return join(dir, name);
}

afterAll(() => {
  // Best-effort.  Windows refuses to unlink a file another handle still has
  // open, and a store closed at the end of a test may not have released its
  // handle yet — a leftover file under the OS temp directory is not worth
  // failing a suite over.
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked */ }
  }
});

/** Every table in a SQLite file, read back through a fresh handle. */
async function tablesOf(file: string): Promise<string[]> {
  const database = (await getSqliteDriver()).open(file);
  try {
    return database
      .prepare('SELECT name FROM sqlite_master WHERE type = ?')
      .all<{ name: string }>('table')
      .map((row) => row.name);
  } finally {
    database.close();
  }
}

function systemWith(config?: ConfigObject): ActorSystem {
  let options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config) options = options.withConfig(config);
  return ActorSystem.create('sqlite-plugin', options);
}

/**
 * Select all three SQLite plug-ins, optionally pointing them at one database
 * file.  A `path` of `undefined` leaves the blocks at the shipped `""`, which
 * the reader drops — so the store falls through to whatever code supplies.
 */
function sqliteSelected(path?: string, extra: Record<string, unknown> = {}): ConfigObject {
  const at = (leaf: string): object => ({
    ...(path !== undefined ? { path } : {}),
    ...(extra[leaf] as object ?? {}),
  });
  return {
    'actor-ts': {
      persistence: {
        journal: { plugin: SQLITE_JOURNAL_PLUGIN_ID, sqlite: at('journal') },
        'snapshot-store': { plugin: SQLITE_SNAPSHOT_PLUGIN_ID, sqlite: at('snapshotStore') },
        'durable-state': { plugin: SQLITE_DURABLE_STATE_PLUGIN_ID, sqlite: at('durableState') },
      },
    },
  } as ConfigObject;
}

describe('registerSqlitePlugins — selected and configured from HOCON alone', () => {
  test('all three stores resolve, connect and round-trip with no options in code', async () => {
    const system = systemWith(sqliteSelected(tempDatabase('all.db')));
    const ext = system.extension(PersistenceExtensionId);
    registerSqlitePlugins(ext);

    expect(ext.journal).toBeInstanceOf(SqliteJournal);
    expect(ext.snapshotStore).toBeInstanceOf(SqliteSnapshotStore);
    expect(ext.durableStateStore).toBeInstanceOf(SqliteDurableStateStore);

    const [event] = await ext.journal.append('pid-1', [{ event: { n: 1 } }], 0);
    expect(event?.sequenceNr).toBe(1);
    expect(await ext.journal.read('pid-1', 0)).toHaveLength(1);

    await ext.snapshotStore.save('pid-1', 1, { n: 1 });
    expect((await ext.snapshotStore.loadLatest('pid-1')).toNullable()?.sequenceNr).toBe(1);

    await ext.durableStateStore.upsert('pid-1', 0, { n: 1 });
    expect((await ext.durableStateStore.load<{ n: number }>('pid-1')).toNullable()?.state.n).toBe(1);

    await system.terminate();
  });

  test('the table names in the block are the tables the stores actually use', async () => {
    // The load-bearing assertion: a leaf that is merely published would leave
    // the stores on `events` / `snapshots` / `durable_state`, and every test
    // above would still pass.
    const path = tempDatabase('named.db');
    const system = systemWith(sqliteSelected(path, {
      journal: { 'events-table': 'app_events' },
      snapshotStore: { 'snapshots-table': 'app_snapshots' },
      durableState: { table: 'app_state' },
    }));
    const ext = system.extension(PersistenceExtensionId);
    registerSqlitePlugins(ext);

    await ext.journal.append('pid-2', [{ event: { n: 1 } }], 0);
    await ext.snapshotStore.save('pid-2', 1, { n: 1 });
    await ext.durableStateStore.upsert('pid-2', 0, { n: 1 });
    await system.terminate();

    const tables = await tablesOf(path);

    expect(tables).toContain('app_events');
    expect(tables).toContain('app_snapshots');
    expect(tables).toContain('app_state');
    expect(tables).not.toContain('events');
    expect(tables).not.toContain('snapshots');
    expect(tables).not.toContain('durable_state');
  });

  test('explicit options beat the block, per field, and an unset field falls through', async () => {
    const path = tempDatabase('precedence.db');
    const system = systemWith(sqliteSelected(path, {
      journal: { 'events-table': 'from_hocon' },
      snapshotStore: { 'snapshots-table': 'snaps_from_hocon', 'keep-n': 9 },
    }));
    const ext = system.extension(PersistenceExtensionId);
    // Only the journal's table is stated in code; the snapshot store's is not.
    registerSqlitePlugins(ext, { journal: { eventsTable: 'from_code' } });

    await ext.journal.append('pid-3', [{ event: { n: 1 } }], 0);
    await ext.snapshotStore.save('pid-3', 1, { n: 1 });
    await system.terminate();

    const tables = await tablesOf(path);

    expect(tables).toContain('from_code');
    expect(tables).not.toContain('from_hocon');
    // Not stated in code, so the block still applies rather than being
    // shadowed by the `undefined` a spread of a partial would carry.
    expect(tables).toContain('snaps_from_hocon');
  });

  test('a shared path in code is a default, not an override — a leaf keeps its own', async () => {
    const shared = tempDatabase('shared.db');
    const journalOnly = tempDatabase('journal-only.db');
    const system = systemWith(sqliteSelected());
    const ext = system.extension(PersistenceExtensionId);
    registerSqlitePlugins(ext, { path: shared, journal: { path: journalOnly } });

    await ext.journal.append('pid-4', [{ event: { n: 1 } }], 0);
    await ext.snapshotStore.save('pid-4', 1, { n: 1 });
    await system.terminate();

    expect(await tablesOf(journalOnly)).toContain('events');
    expect(await tablesOf(journalOnly)).not.toContain('snapshots');
    expect(await tablesOf(shared)).toContain('snapshots');
    expect(await tablesOf(shared)).not.toContain('events');
  });
});

describe('registerSqlitePlugins — the builder form', () => {
  test('a builder and a plain object are interchangeable', async () => {
    const path = tempDatabase('builder.db');
    const system = systemWith(sqliteSelected());
    const ext = system.extension(PersistenceExtensionId);
    const journalOptions = SqliteJournalOptions.create().withEventsTable('builder_events');
    const durableStateOptions = SqliteDurableStateStoreOptions.create().withTable('builder_state');
    const sqliteOptions = RegisterSqlitePluginsOptions.create()
      .withPath(path)
      .withJournal(journalOptions)
      .withDurableStateStore(durableStateOptions);
    registerSqlitePlugins(ext, sqliteOptions);

    await ext.journal.append('pid-5', [{ event: { n: 1 } }], 0);
    await ext.durableStateStore.upsert('pid-5', 0, { n: 1 });
    await system.terminate();

    expect(await tablesOf(path)).toContain('builder_events');
    expect(await tablesOf(path)).toContain('builder_state');
  });

  test('a pre-opened database is shared by all three stores, and stays the caller\'s to close', async () => {
    // The one field that cannot come from HOCON: a live handle.  Sharing it is
    // an override rather than a default, because one connection across the
    // three stores is the more specific instruction.
    const path = tempDatabase('handle.db');
    const driver = await getSqliteDriver();
    const database = driver.open(path);
    const system = systemWith(sqliteSelected());
    const ext = system.extension(PersistenceExtensionId);
    const sqliteOptions = RegisterSqlitePluginsOptions.create()
      .withPath(path)
      .withDatabase(database);
    registerSqlitePlugins(ext, sqliteOptions);

    await ext.durableStateStore.upsert('pid-6', 0, { n: 1 });
    await system.terminate();

    // Still usable: nothing closed a handle it did not open.
    expect(database.prepare('SELECT 1 AS one').all<{ one: number }>()).toEqual([{ one: 1 }]);
    database.close();
  });
});

describe('the durable-state selector (#872)', () => {
  test('defaults to the in-memory reference store when nothing is configured', () => {
    const system = systemWith();
    const ext = system.extension(PersistenceExtensionId);

    expect(ext.durableStateStore).toBeInstanceOf(InMemoryDurableStateStore);
  });

  test('throws rather than silently falling back when the configured plugin is unregistered', () => {
    const system = systemWith({
      'actor-ts': { persistence: { 'durable-state': { plugin: SQLITE_DURABLE_STATE_PLUGIN_ID } } },
    } as ConfigObject);
    const ext = system.extension(PersistenceExtensionId);

    expect(() => ext.durableStateStore).toThrow(/Unknown durable-state plugin.*sqlite/s);
  });

  test('registering the active plugin after a resolution forces a re-lookup', () => {
    const system = systemWith({
      'actor-ts': { persistence: { 'durable-state': { plugin: 'test.durable-state.custom' } } },
    } as ConfigObject);
    const ext = system.extension(PersistenceExtensionId);
    const first = new InMemoryDurableStateStore();
    ext.registerDurableStateStore('test.durable-state.custom', () => first);
    expect(ext.durableStateStore).toBe(first);

    const second = new InMemoryDurableStateStore();
    ext.registerDurableStateStore('test.durable-state.custom', () => second);
    expect(ext.durableStateStore).toBe(second);
  });

  test('configure() sets the durable-state store alongside the other two', () => {
    const system = systemWith();
    const ext = system.extension(PersistenceExtensionId);
    const durableStateStore = new InMemoryDurableStateStore();
    ext.configure({ durableStateStore });

    expect(ext.durableStateStore).toBe(durableStateStore);
  });
});

type Counter = { readonly n: number };
type Bump = { readonly kind: 'bump' };

class CounterActor extends DurableStateActor<Bump, Counter> {
  override async onCommand(_command: Bump): Promise<void> {
    await this.persist({ n: this.state.n + 1 });
  }
}

describe('DurableStateActor falls back to the configured store (#872)', () => {
  test('an actor that names no store writes to the plugin the extension selected', async () => {
    const system = systemWith();
    const ext = system.extension(PersistenceExtensionId);
    const configured = new InMemoryDurableStateStore();
    ext.configure({ durableStateStore: configured });

    const counterFactory: ActorFactory<Bump> = () => new CounterActor(
      DurableStateOptions.create<Counter>()
        .withPersistenceId('counter-1')
        .withEmptyState(() => ({ n: 0 })),
    ) as never;
    const counter = system.spawn(counterFactory, 'counter-1');
    counter.tell({ kind: 'bump' });

    await awaitCondition(
      async () => (await configured.load<Counter>('counter-1')).isSome(),
      { label: 'the actor persisted into the configured durable-state store' },
    );
    expect((await configured.load<Counter>('counter-1')).toNullable()?.state.n).toBe(1);

    await system.terminate();
  });

  test('a store named in the options still wins over the configured one', async () => {
    const system = systemWith();
    const ext = system.extension(PersistenceExtensionId);
    const configured = new InMemoryDurableStateStore();
    const explicit = new InMemoryDurableStateStore();
    ext.configure({ durableStateStore: configured });

    const counterFactory: ActorFactory<Bump> = () => new CounterActor(
      DurableStateOptions.create<Counter>()
        .withPersistenceId('counter-2')
        .withStore(explicit)
        .withEmptyState(() => ({ n: 0 })),
    ) as never;
    const counter = system.spawn(counterFactory, 'counter-2');
    counter.tell({ kind: 'bump' });

    await awaitCondition(
      async () => (await explicit.load<Counter>('counter-2')).isSome(),
      { label: 'the actor persisted into the store its options named' },
    );
    expect((await explicit.load<Counter>('counter-2')).toNullable()?.state.n).toBe(1);
    // The absence is safe to assert without a wait of its own: the write above
    // has already landed, and both stores are process-heap maps written
    // synchronously by the same `persist` call.
    expect((await configured.load<Counter>('counter-2')).isNone()).toBe(true);

    await system.terminate();
  });
});
