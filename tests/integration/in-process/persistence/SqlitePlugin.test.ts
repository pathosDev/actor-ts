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
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
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
  SqliteSnapshotStoreOptions,
  SQLITE_DURABLE_STATE_PLUGIN_ID,
  SQLITE_JOURNAL_PLUGIN_ID,
  SQLITE_SNAPSHOT_PLUGIN_ID,
  type PersistencePlugin,
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
 * The assertions that matter are the *values*: a table name read back out of
 * the database is what shows that a leaf reached the store it configures.
 * `NoDeadConfigKeys` stops a step short of that (#1425).  It proves each SQLite
 * reader's answer moves with its leaf, not that the plug-in hands the answer
 * on — a plug-in that dropped it would leave that gate green and every table
 * here at its built-in name.
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

/** A system on `config`, with `plugin` registering inside `create` through the `plugins` slot (#1473). */
function systemWith(config?: ConfigObject, plugin?: PersistencePlugin): ActorSystem {
  let options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config) options = options.withConfig(config);
  if (plugin) options = options.withPersistence({ plugins: [plugin] });
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

/**
 * What `create` threw for a system on `config` with `plugin` in its `plugins`
 * slot, or `undefined` — and then the system it built is terminated, so a
 * registration that should have refused and did not fails the test instead of
 * leaving a system running.
 */
async function thrownByCreate(config: ConfigObject, plugin: PersistencePlugin): Promise<unknown> {
  let system: ActorSystem;
  try {
    system = systemWith(config, plugin);
  } catch (error) {
    return error;
  }
  await system.terminate();
  return undefined;
}

describe('registerSqlitePlugins — selected and configured from HOCON alone', () => {
  test('all three stores resolve, connect and round-trip with no options in code', async () => {
    const system = systemWith(sqliteSelected(tempDatabase('all.db')), (persistence) => registerSqlitePlugins(persistence));
    const ext = system.extension(PersistenceExtensionId);

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
    }), (persistence) => registerSqlitePlugins(persistence));
    const ext = system.extension(PersistenceExtensionId);

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
    // Only the journal's table is stated in code; the snapshot store's is not.
    const system = systemWith(sqliteSelected(path, {
      journal: { 'events-table': 'from_hocon' },
      snapshotStore: { 'snapshots-table': 'snaps_from_hocon', 'keep-n': 9 },
    }), (persistence) => registerSqlitePlugins(persistence, { journal: { eventsTable: 'from_code' } }));
    const ext = system.extension(PersistenceExtensionId);

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
    const system = systemWith(
      sqliteSelected(),
      (persistence) => registerSqlitePlugins(persistence, { path: shared, journal: { path: journalOnly } }),
    );
    const ext = system.extension(PersistenceExtensionId);

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
    const journalOptions = SqliteJournalOptions.create().withEventsTable('builder_events');
    const durableStateOptions = SqliteDurableStateStoreOptions.create().withTable('builder_state');
    const sqliteOptions = RegisterSqlitePluginsOptions.create()
      .withPath(path)
      .withJournal(journalOptions)
      .withDurableStateStore(durableStateOptions);
    const system = systemWith(sqliteSelected(), (persistence) => registerSqlitePlugins(persistence, sqliteOptions));
    const ext = system.extension(PersistenceExtensionId);

    await ext.journal.append('pid-5', [{ event: { n: 1 } }], 0);
    await ext.durableStateStore.upsert('pid-5', 0, { n: 1 });
    await system.terminate();

    expect(await tablesOf(path)).toContain('builder_events');
    expect(await tablesOf(path)).toContain('builder_state');
  });

  test('a pre-opened database reaches the durable-state store, and stays the caller\'s to close', async () => {
    // The one field that cannot come from HOCON: a live handle.  It overrides
    // the durable-state leaf's own rather than filling in for it, because a
    // connection handed over in code is the more specific instruction.  The
    // journal and the snapshot store open their own handle (#491), so they
    // take the shared path instead.
    const path = tempDatabase('handle.db');
    // A database of its own, so where each store wrote tells them apart.
    const database = (await getSqliteDriver()).open(':memory:');
    const sqliteOptions = RegisterSqlitePluginsOptions.create()
      .withPath(path)
      .withDatabase(database);
    const system = systemWith(sqliteSelected(), (persistence) => registerSqlitePlugins(persistence, sqliteOptions));
    const ext = system.extension(PersistenceExtensionId);

    await ext.journal.append('pid-6', [{ event: { n: 1 } }], 0);
    await ext.durableStateStore.upsert('pid-6', 0, { n: 1 });
    await system.terminate();

    const inHandle = database
      .prepare('SELECT name FROM sqlite_master WHERE type = ?')
      .all<{ name: string }>('table')
      .map((row) => row.name);
    expect(inHandle).toContain('durable_state');
    expect(inHandle).not.toContain('events');
    expect(await tablesOf(path)).toContain('events');
    expect(await tablesOf(path)).not.toContain('durable_state');
    // Still usable: nothing closed a handle it did not open.
    expect(database.prepare('SELECT 1 AS one').all<{ one: number }>()).toEqual([{ one: 1 }]);
    database.close();
  });
});

/** One SQLite axis as a selector names it, with the key and the leaf builder that give it a path. */
type SqliteAxis = {
  readonly axis: 'journal' | 'snapshot-store' | 'durable-state';
  readonly pluginId: string;
  readonly pathKey: string;
  readonly leafOptions: string;
  /** Whether a database handed to the plug-in reaches this store — the durable-state store only (#491). */
  readonly takesDatabase: boolean;
};

const SQLITE_AXES: ReadonlyArray<SqliteAxis> = [
  {
    axis: 'journal',
    pluginId: SQLITE_JOURNAL_PLUGIN_ID,
    pathKey: 'actor-ts.persistence.journal.sqlite.path',
    leafOptions: 'SqliteJournalOptions',
    takesDatabase: false,
  },
  {
    axis: 'snapshot-store',
    pluginId: SQLITE_SNAPSHOT_PLUGIN_ID,
    pathKey: 'actor-ts.persistence.snapshot-store.sqlite.path',
    leafOptions: 'SqliteSnapshotStoreOptions',
    takesDatabase: false,
  },
  {
    axis: 'durable-state',
    pluginId: SQLITE_DURABLE_STATE_PLUGIN_ID,
    pathKey: 'actor-ts.persistence.durable-state.sqlite.path',
    leafOptions: 'SqliteDurableStateStoreOptions',
    takesDatabase: true,
  },
];

/** Select the SQLite store on `entry`'s axis alone, with `block` as its SQLite block. */
function selecting(entry: SqliteAxis, block: object = {}): ConfigObject {
  return { 'actor-ts': { persistence: { [entry.axis]: { plugin: entry.pluginId, sqlite: block } } } } as ConfigObject;
}

describe('a selected SQLite store names its database, or registration refuses it (#1492)', () => {
  for (const entry of SQLITE_AXES) {
    test(`a selected ${entry.axis} with no path in its block or in code makes create throw, naming ${entry.pathKey}`, async () => {
      const refusal = await thrownByCreate(selecting(entry), (persistence) => registerSqlitePlugins(persistence));

      expect(refusal).toBeInstanceOf(OptionsError);
      expect((refusal as OptionsError).field).toBe('path');
      const message = (refusal as OptionsError).message;
      expect(message).toContain(entry.pathKey);
      expect(message).toContain('":memory:"');
      expect(message).toContain('RegisterSqlitePluginsOptions.withPath');
      expect(message).toContain(`${entry.leafOptions}.withPath`);
    });
  }

  for (const entry of SQLITE_AXES.filter((candidate) => !candidate.takesDatabase)) {
    test(`a selected ${entry.axis} given only a database in code is refused: the handle does not reach it (#491)`, async () => {
      const database = (await getSqliteDriver()).open(':memory:');
      try {
        const sqliteOptions = RegisterSqlitePluginsOptions.create().withDatabase(database);
        const refusal = await thrownByCreate(
          selecting(entry),
          (persistence) => registerSqlitePlugins(persistence, sqliteOptions),
        );

        expect(refusal).toBeInstanceOf(OptionsError);
        expect((refusal as OptionsError).message).toContain(entry.pathKey);
        expect((refusal as OptionsError).message).toContain('#491');
      } finally {
        database.close();
      }
    });
  }

  test('a selected durable-state store given only a database in code registers: the handle stands in for its path', async () => {
    const database = (await getSqliteDriver()).open(':memory:');
    try {
      const sqliteOptions = RegisterSqlitePluginsOptions.create().withDatabase(database);
      const durableState = SQLITE_AXES.find((candidate) => candidate.takesDatabase)!;
      const system = systemWith(selecting(durableState), (persistence) => registerSqlitePlugins(persistence, sqliteOptions));
      try {
        const ext = system.extension(PersistenceExtensionId);
        await ext.durableStateStore.upsert('pid-handle', 0, { n: 1 });
        expect((await ext.durableStateStore.load<{ n: number }>('pid-handle')).toNullable()?.state.n).toBe(1);
      } finally {
        await system.terminate();
      }
    } finally {
      database.close();
    }
  });

  test('a selected store whose path is a remote URL is refused at registration too', async () => {
    const snapshotStore = SQLITE_AXES.find((candidate) => candidate.axis === 'snapshot-store')!;
    const refusal = await thrownByCreate(
      selecting(snapshotStore, { path: 'libsql://app.example.turso.io' }),
      (persistence) => registerSqlitePlugins(persistence),
    );

    expect(refusal).toBeInstanceOf(OptionsError);
    expect((refusal as OptionsError).message).toContain(snapshotStore.pathKey);
    expect((refusal as OptionsError).message).toContain('LibSqlSnapshotStore');
  });

  test('a selected store\'s other refused setting fails the registration too, rethrown as it is', async () => {
    // The validator runs over the whole merge, so a refusal that is not about
    // the path surfaces at registration as well — untouched, because the
    // path guidance would point at the wrong setting.  An empty table name
    // reaches it: the identifier reader passes `""` through on purpose.
    const durableState = SQLITE_AXES.find((candidate) => candidate.axis === 'durable-state')!;
    const refusal = await thrownByCreate(
      selecting(durableState, { path: ':memory:', table: '' }),
      (persistence) => registerSqlitePlugins(persistence),
    );

    expect(refusal).toBeInstanceOf(OptionsError);
    expect((refusal as OptionsError).field).toBe('table');
    expect((refusal as OptionsError).message).toMatch(/^SqliteDurableStateStoreOptions: table /);
    expect((refusal as OptionsError).message).not.toContain('registerSqlitePlugins');
  });

  test('the examples/chat shape registers: two stores selected with paths in code, durable state neither selected nor given one', async () => {
    // Registering all three and selecting two is the documented shape, so a
    // refusal keyed on the registration rather than the selection would make
    // every journal-only application name a database it never opens.
    const journalOptions = SqliteJournalOptions.create().withPath(tempDatabase('chat-journal.db'));
    const snapshotOptions = SqliteSnapshotStoreOptions.create().withPath(tempDatabase('chat-snapshots.db'));
    const sqliteOptions = RegisterSqlitePluginsOptions.create()
      .withJournal(journalOptions)
      .withSnapshotStore(snapshotOptions);
    const config = {
      'actor-ts': {
        persistence: {
          journal: { plugin: SQLITE_JOURNAL_PLUGIN_ID },
          'snapshot-store': { plugin: SQLITE_SNAPSHOT_PLUGIN_ID },
        },
      },
    } as ConfigObject;
    const system = systemWith(config, (persistence) => registerSqlitePlugins(persistence, sqliteOptions));
    try {
      const ext = system.extension(PersistenceExtensionId);
      await ext.journal.append('pid-chat', [{ event: { n: 1 } }], 0);
      expect(await ext.journal.read('pid-chat', 0)).toHaveLength(1);
      await ext.snapshotStore.save('pid-chat', 1, { n: 1 });
      expect((await ext.snapshotStore.loadLatest('pid-chat')).toNullable()?.sequenceNr).toBe(1);
      // Not selected, so never built from its pathless options.
      expect(ext.durableStateStore).toBeInstanceOf(InMemoryDurableStateStore);
    } finally {
      await system.terminate();
    }
  });

  for (const unselected of SQLITE_AXES) {
    test(`an unselected ${unselected.axis} block is never read: a malformed leaf in it leaves create to succeed`, async () => {
      // Only a selected root is merged at registration.  Any other is merged
      // inside its factory, which runs only for a store something resolves,
      // so a block the configuration does not select is never read — the
      // property every other plug-in keeps.
      const selected = SQLITE_AXES.find((candidate) => candidate !== unselected)!;
      const config = {
        'actor-ts': {
          persistence: {
            [selected.axis]: { plugin: selected.pluginId, sqlite: { path: ':memory:' } },
            [unselected.axis]: { sqlite: { 'busy-timeout': 'not a duration' } },
          },
        },
      } as ConfigObject;
      let system: ActorSystem | undefined;
      let createFailure: unknown;
      try {
        system = systemWith(config, (persistence) => registerSqlitePlugins(persistence));
      } catch (error) {
        createFailure = error;
      }
      try {
        expect(createFailure).toBeUndefined();
        const ext = system!.extension(PersistenceExtensionId);
        if (selected.axis === 'journal') {
          await ext.journal.append('pid-unselected', [{ event: { n: 1 } }], 0);
          expect(await ext.journal.read('pid-unselected', 0)).toHaveLength(1);
        } else {
          await ext.snapshotStore.save('pid-unselected', 1, { n: 1 });
          expect((await ext.snapshotStore.loadLatest('pid-unselected')).toNullable()?.sequenceNr).toBe(1);
        }
      } finally {
        await system?.terminate();
      }
    });
  }

  test('a selector that holds no id is left to the registry, which refuses it as it does without the plug-in', async () => {
    // Reading the selection is how the plug-in knows which stores to hold to
    // the rule, but a selector that names nothing at all is not a SQLite
    // mistake: the startup refuses it, naming the selector, whichever
    // backends are registered.
    const config = { 'actor-ts': { persistence: { journal: { plugin: ['not', 'an', 'id'] } } } } as ConfigObject;
    const system = systemWith(config, (persistence) => registerSqlitePlugins(persistence));
    try {
      let startupFailure: unknown;
      try {
        await system.whenReady();
      } catch (error) {
        startupFailure = error;
      }
      expect((startupFailure as Error | undefined)?.message).toContain('actor-ts.persistence.journal.plugin');
    } finally {
      await system.terminate();
      await system.whenTerminated();
    }
  });

  test('path = ":memory:" in all three blocks, with nothing in code, round-trips all three stores', async () => {
    const system = systemWith(sqliteSelected(':memory:'), (persistence) => registerSqlitePlugins(persistence));
    try {
      const ext = system.extension(PersistenceExtensionId);

      await ext.journal.append('pid-memory', [{ event: { n: 1 } }], 0);
      expect(await ext.journal.read('pid-memory', 0)).toHaveLength(1);

      await ext.snapshotStore.save('pid-memory', 1, { n: 1 });
      expect((await ext.snapshotStore.loadLatest('pid-memory')).toNullable()?.sequenceNr).toBe(1);

      await ext.durableStateStore.upsert('pid-memory', 0, { n: 1 });
      expect((await ext.durableStateStore.load<{ n: number }>('pid-memory')).toNullable()?.state.n).toBe(1);
    } finally {
      await system.terminate();
    }
  });
});

describe('the durable-state selector (#872)', () => {
  test('defaults to the in-memory reference store when nothing is configured', () => {
    const system = systemWith();
    const ext = system.extension(PersistenceExtensionId);

    expect(ext.durableStateStore).toBeInstanceOf(InMemoryDurableStateStore);
  });

  test('throws rather than silently falling back when the configured plugin is unregistered', async () => {
    const system = systemWith({
      'actor-ts': { persistence: { 'durable-state': { plugin: SQLITE_DURABLE_STATE_PLUGIN_ID } } },
    } as ConfigObject);
    const ext = system.extension(PersistenceExtensionId);
    try {
      expect(() => ext.durableStateStore).toThrow(/Unknown durable-state plugin.*sqlite/s);
      // And the startup, which resolves the selection inside `create` to open
      // it (#1473), refuses it the same way rather than coming up in memory.
      let startupFailure: unknown;
      try {
        await system.whenReady();
      } catch (error) {
        startupFailure = error;
      }
      expect((startupFailure as Error | undefined)?.message).toMatch(/Unknown durable-state plugin.*sqlite/s);
    } finally {
      await system.terminate();
      await system.whenTerminated();
    }
  });

  test('registering the active plugin after a resolution forces a re-lookup', () => {
    // The first factory comes in through the `plugins` slot like any selected
    // plug-in (#1473); the second registration, after `create` and after a
    // resolution, is the one under test.
    const first = new InMemoryDurableStateStore();
    const system = systemWith({
      'actor-ts': { persistence: { 'durable-state': { plugin: 'test.durable-state.custom' } } },
    } as ConfigObject, (persistence) => persistence.registerDurableStateStore('test.durable-state.custom', () => first));
    const ext = system.extension(PersistenceExtensionId);
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
