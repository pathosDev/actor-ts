import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDurableStateStore } from '../../../src/persistence/durable-state-stores/SqliteDurableStateStore.js';
import { SqliteJournal } from '../../../src/persistence/journals/SqliteJournal.js';
import { SqliteJournalOptions, type SqliteJournalOptionsType } from '../../../src/persistence/journals/SqliteJournalOptions.js';
import { SqliteSnapshotStore } from '../../../src/persistence/snapshot-stores/SqliteSnapshotStore.js';
import {
  SqliteSnapshotStoreOptions,
  type SqliteSnapshotStoreOptionsType,
} from '../../../src/persistence/snapshot-stores/SqliteSnapshotStoreOptions.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  registerSqlitePlugins,
  SQLITE_DURABLE_STATE_PLUGIN_ID,
  SQLITE_JOURNAL_PLUGIN_ID,
  SQLITE_SNAPSHOT_PLUGIN_ID,
} from '../../../src/persistence/journals/SqlitePlugin.js';
import { getSqliteDriver, type SqliteDb } from '../../../src/runtime/sqlite/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * #1492 — what a SQLite store's `path` may be is one rule, and each of the
 * three stores holds it when it is constructed.
 *
 * They used to disagree.  With no path the journal and the snapshot store
 * opened an anonymous in-memory database while the durable-state store
 * refused, and `''` or a `libsql://` URL was a file name to the first two and
 * a mistake to the third — so one configuration gave two stores that lost
 * their data on restart beside one that would not start, and nothing said
 * which.  Now all three refuse an absent, empty or remote path, and an
 * in-memory database is the explicit `':memory:'`.
 *
 * Construction is lazy for every SQLite store, so nothing here opens a
 * database: the file path below is never created.
 */

/** The two fields the rule reads; `database` is not in the journal's or the snapshot store's type. */
type PathSettings = { readonly path?: string; readonly database?: SqliteDb };

type StoreUnderTest = {
  readonly name: string;
  readonly construct: (settings: PathSettings) => unknown;
  /** Whether a pre-opened handle stands in for the path: only the durable-state store takes one (#491). */
  readonly takesDatabase: boolean;
};

const STORES: ReadonlyArray<StoreUnderTest> = [
  {
    name: 'SqliteJournal',
    construct: (settings) => new SqliteJournal(settings as Partial<SqliteJournalOptionsType>),
    takesDatabase: false,
  },
  {
    name: 'SqliteSnapshotStore',
    construct: (settings) => new SqliteSnapshotStore(settings as Partial<SqliteSnapshotStoreOptionsType>),
    takesDatabase: false,
  },
  {
    name: 'SqliteDurableStateStore',
    construct: (settings) => new SqliteDurableStateStore(settings),
    takesDatabase: true,
  },
];

/** A path no store opens, because construction is lazy. */
const FILE_PATH = join(tmpdir(), 'actor-ts-sqlite-path-rule', 'never-opened.db');

const REMOTE_PATHS = ['libsql://app.example.turso.io', 'https://app.example.turso.io', 'wss://app.example.turso.io'];

/** The refusal `construct` throws; fails the test when it constructs instead. */
function refusalOf(construct: () => unknown): OptionsError {
  let thrown: unknown;
  try {
    construct();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'the store was constructed, but its path should have been refused').toBeInstanceOf(OptionsError);
  return thrown as OptionsError;
}

for (const store of STORES) {
  describe(`${store.name} holds the SQLite path rule (#1492)`, () => {
    test('a missing path is refused, naming ":memory:" as the in-memory choice', () => {
      const refusal = refusalOf(() => store.construct({}));
      expect(refusal.field).toBe('path');
      expect(refusal.message).toContain('":memory:"');
    });

    test('an empty path is refused rather than opened as an anonymous database', () => {
      const refusal = refusalOf(() => store.construct({ path: '' }));
      expect(refusal.field).toBe('path');
      expect(refusal.value).toBe('');
    });

    test('a path that is not a string is refused, as an untyped caller can pass one', () => {
      const refusal = refusalOf(() => store.construct({ path: 42 as unknown as string }));
      expect(refusal.field).toBe('path');
      expect(refusal.value).toBe(42);
    });

    for (const path of REMOTE_PATHS) {
      test(`the remote URL ${path} is refused, pointing at the libSQL stores`, () => {
        const refusal = refusalOf(() => store.construct({ path }));
        expect(refusal.field).toBe('path');
        expect(refusal.message).toContain('LibSql');
      });
    }

    test('a remote scheme is refused in any letter case, as URL schemes are case-insensitive', () => {
      // RFC 3986 §3.1: a scheme is compared case-insensitively, so
      // `LIBSQL://` names the same service as `libsql://` and would equally
      // become a file of that name on the local driver.
      for (const path of ['LIBSQL://app.example.turso.io', 'Https://app.example.turso.io', 'WSS://app.example.turso.io']) {
        const refusal = refusalOf(() => store.construct({ path }));
        expect(refusal.field).toBe('path');
        expect(refusal.message).toContain('LibSql');
      }
    });

    test('a refused remote URL reaches the message with its credentials masked', () => {
      // The refusal is logged at ERROR when it fails a startup, and a libSQL
      // URL is handed out with its token.
      const refusal = refusalOf(() => store.construct({ path: 'libsql://reader:secret-token@app.example.turso.io' }));
      expect(refusal.message).not.toContain('secret-token');
      expect(String(refusal.value)).not.toContain('secret-token');
    });

    test('a refused remote URL keeps a token in its query out of the message', () => {
      // `@libsql/client` takes the token as a query parameter too, and that
      // form carries no userinfo to mask (#1492).
      for (const path of [
        'libsql://app.example.turso.io?authToken=QUERY-SECRET',
        'https://app.example.turso.io/?authToken=QUERY-SECRET',
        'wss://reader:USER-SECRET@app.example.turso.io?authToken=QUERY-SECRET#FRAGMENT-SECRET',
      ]) {
        const refusal = refusalOf(() => store.construct({ path }));
        for (const secret of ['QUERY-SECRET', 'USER-SECRET', 'FRAGMENT-SECRET']) {
          expect(refusal.message).not.toContain(secret);
          expect(String(refusal.value)).not.toContain(secret);
        }
        // What is left still says which service was meant.
        expect(String(refusal.value)).toContain('app.example.turso.io');
      }
    });

    test('":memory:" and a file path construct', () => {
      expect(() => store.construct({ path: ':memory:' })).not.toThrow();
      expect(() => store.construct({ path: FILE_PATH })).not.toThrow();
    });

    test(`a pre-opened database ${store.takesDatabase ? 'stands in for' : 'does not stand in for'} the path`, async () => {
      const database = (await getSqliteDriver()).open(':memory:');
      try {
        if (store.takesDatabase) {
          expect(() => store.construct({ database })).not.toThrow();
        } else {
          expect(refusalOf(() => store.construct({ database })).field).toBe('path');
        }
      } finally {
        database.close();
      }
    });
  });
}

describe('a store opens the path its validator checked (#1492)', () => {
  // A builder *is* its settings, so one changed after the store was built
  // would otherwise be read again when the store opens — and its new path
  // would never have met the rule.  Here it is changed to `''`, which SQLite
  // opens as an anonymous temporary database: the checked file would then
  // never be created.
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-sqlite-path-rule-'));
  afterAll(() => {
    // Best-effort: Windows can hold a closed SQLite handle past close().
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* still locked */ }
  });

  test('the journal ignores a path set on its builder afterwards', async () => {
    const checked = join(directory, 'journal.db');
    const journalOptions = SqliteJournalOptions.create().withPath(checked);
    const journal = new SqliteJournal(journalOptions);
    journalOptions.withPath('');
    await journal.append('pid-1', [{ event: { n: 1 } }], 0);
    await journal.close();
    expect(existsSync(checked)).toBe(true);
  });

  test('the snapshot store ignores a path set on its builder afterwards', async () => {
    const checked = join(directory, 'snapshots.db');
    const storeOptions = SqliteSnapshotStoreOptions.create().withPath(checked);
    const store = new SqliteSnapshotStore(storeOptions);
    storeOptions.withPath('');
    await store.save('pid-1', 1, { n: 1 });
    await store.close();
    expect(existsSync(checked)).toBe(true);
  });
});

/**
 * The registration refusal carries the store's refusal on, message and value
 * both, and it fails `ActorSystem.create` — so it is the line a misconfigured
 * deployment logs at startup.  A `libsql://` path selected from HOCON, with
 * its token in the query (#1492).
 */
describe('registerSqlitePlugins keeps a query-string token out of its refusal (#1492)', () => {
  const axes = [
    { axis: 'journal', plugin: SQLITE_JOURNAL_PLUGIN_ID },
    { axis: 'snapshot-store', plugin: SQLITE_SNAPSHOT_PLUGIN_ID },
    { axis: 'durable-state', plugin: SQLITE_DURABLE_STATE_PLUGIN_ID },
  ] as const;

  for (const { axis, plugin } of axes) {
    test(`a selected ${axis} with a libsql:// path refuses without the token`, () => {
      const systemOptions = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off)
        .withConfig({
          'actor-ts': {
            persistence: {
              [axis]: { plugin, sqlite: { path: 'libsql://app.example.turso.io?authToken=QUERY-SECRET' } },
            },
          },
        } as ConfigObject)
        .withPersistence({ plugins: [(persistence) => registerSqlitePlugins(persistence)] });
      let thrown: unknown;
      try {
        // A system that is built is terminated at once; the refusal is what is wanted.
        void ActorSystem.create(`sqlite-query-token-${axis}`, systemOptions).terminate();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OptionsError);
      const refusal = thrown as OptionsError;
      expect(refusal.message).toContain('has no usable path');
      expect(refusal.message).not.toContain('QUERY-SECRET');
      expect(String(refusal.value)).not.toContain('QUERY-SECRET');
    });
  }
});
