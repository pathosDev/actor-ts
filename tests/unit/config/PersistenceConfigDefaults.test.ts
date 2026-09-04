import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { ConfigKeys } from '../../../src/config/ConfigKeys.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import {
  DEFAULT_AUTO_CREATE_TABLES,
  DEFAULT_DURABLE_STATE_TABLE,
  DEFAULT_EVENTS_TABLE,
  DEFAULT_SNAPSHOTS_TABLE,
  DEFAULT_SNAPSHOT_KEEP_N,
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
} from '../../../src/persistence/Constants.js';
import { DEFAULT_D1_BASE_URL } from '../../../src/persistence/journals/D1Client.js';
import {
  readSqliteDurableStateStoreOptionsFromConfig,
  readSqliteJournalOptionsFromConfig,
  readSqliteSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/SqlitePluginOptions.js';
import {
  readPostgresDurableStateStoreOptionsFromConfig,
  readPostgresJournalOptionsFromConfig,
  readPostgresSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/PostgresPluginOptions.js';
import {
  readMariaDbDurableStateStoreOptionsFromConfig,
  readMariaDbJournalOptionsFromConfig,
  readMariaDbSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/MariaDbPluginOptions.js';
import {
  readMsSqlDurableStateStoreOptionsFromConfig,
  readMsSqlJournalOptionsFromConfig,
  readMsSqlSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/MsSqlPluginOptions.js';
import {
  readLibSqlDurableStateStoreOptionsFromConfig,
  readLibSqlJournalOptionsFromConfig,
  readLibSqlSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/LibSqlPluginOptions.js';
import {
  readD1DurableStateStoreOptionsFromConfig,
  readD1JournalOptionsFromConfig,
  readD1SnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/D1PluginOptions.js';

/**
 * #872 — before this, nothing under `src/persistence/` read a config block.
 * `PersistenceExtension` resolved two plugin *ids* and every store took its
 * settings constructor-only, so a table name or a database path could only be
 * changed by editing code — while `configuration.mdx` and
 * `examples/chat/application.conf` both already printed
 * `actor-ts.persistence.journal.sqlite` as if it held settings.
 *
 * **This file is the gate, and `NoDeadConfigKeys` is not.**  That guard's
 * `coveringAccessor` falls back to a config root above the leaf, and
 * `isReferencedInSource` is satisfied by a bare string literal — which
 * `SqlitePlugin.ts` contains anyway, as the plugin id.  So every leaf under
 * `…journal.sqlite` would pass it with nothing reading them.  Measured, not
 * assumed: see the binding experiment recorded on the issue.  What actually
 * pins a leaf to a value is an exact-object assertion here plus the
 * end-to-end arm in `SqlitePlugin.test.ts`.
 *
 * `Config.parseString` throughout, never `Config.fromObject({'a.b': 1})`: the
 * latter keeps the dotted string as a literal top-level key, so `hasPath`
 * resolves the nested reference.conf value instead and the assertion is about
 * nothing.
 */

/**
 * The reader's contract is that an absent leaf is **omitted**, not written as
 * an explicit `undefined` — that is what lets a consumer spread the result
 * without shadowing the layer beneath it.  `toEqual` cannot express the
 * difference: it ignores a property whose value is `undefined`, so a reader
 * rewritten to punch holes passes every `toEqual` in this file.
 */
function ownKeysOf(options: object): string[] {
  return Object.keys(options);
}

const reference = Config.parseString(REFERENCE_CONF);
const unrelated = Config.parseString('actor-ts.system.name = x');

/** A block body, indented under one of the three SQLite roots. */
function sqliteConfig(root: string, body: string): Config {
  return Config.parseString(`
    ${root} {
      ${body}
    }
  `);
}

describe('readSqliteJournalOptionsFromConfig', () => {
  test('the shipped reference.conf resolves to the documented defaults', () => {
    // `path` is absent because `path = ""` is the shape of the key, not a
    // value — an empty path falls through to DEFAULT_SQLITE_PATH.
    const options = readSqliteJournalOptionsFromConfig(reference);

    expect(options).toEqual({
      eventsTable: DEFAULT_EVENTS_TABLE,
      wal: false,
      busyTimeoutMs: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
    });
    expect(ownKeysOf(options)).toEqual(['eventsTable', 'wal', 'busyTimeoutMs']);
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    const options = readSqliteJournalOptionsFromConfig(unrelated);

    expect(options).toEqual({});
    expect(ownKeysOf(options)).toEqual([]);
  });

  test('a partial block leaves the unset leaves out', () => {
    const options = readSqliteJournalOptionsFromConfig(
      sqliteConfig(ConfigKeys.persistence.journal.sqlite.root, 'events-table = "journal"'),
    );

    expect(options).toEqual({ eventsTable: 'journal' });
    expect(ownKeysOf(options)).toEqual(['eventsTable']);
  });

  test('reads every leaf, kebab mapped to camelCase and the duration to ms', () => {
    const options = readSqliteJournalOptionsFromConfig(sqliteConfig(
      ConfigKeys.persistence.journal.sqlite.root,
      `
        path = "./events.db"
        events-table = "journal"
        wal = on
        busy-timeout = 250ms
      `,
    ));

    expect(options).toEqual({
      path: './events.db',
      eventsTable: 'journal',
      wal: true,
      busyTimeoutMs: 250,
    });
  });

  test('an empty path is dropped rather than passed through as ""', () => {
    // `''` is a legal SQLite path — an anonymous on-disk database — so a
    // published placeholder forwarded verbatim would be a value, and would
    // outrank the store's own default instead of falling through to it.
    const options = readSqliteJournalOptionsFromConfig(
      sqliteConfig(ConfigKeys.persistence.journal.sqlite.root, 'path = ""'),
    );

    expect(options.path).toBeUndefined();
    expect(ownKeysOf(options)).toEqual([]);
  });

  test('a live object written into the block is not read, whatever it is called', () => {
    // The mitigation is the absent path, not a filter that could be forgotten:
    // a driver, a pre-opened handle and a serializer have no leaf at all.
    const options = readSqliteJournalOptionsFromConfig(sqliteConfig(
      ConfigKeys.persistence.journal.sqlite.root,
      'driver = "bun:sqlite", database = "handle", serializer = "cbor"',
    ));

    expect(options).toEqual({});
    expect(JSON.stringify(options)).not.toContain('cbor');
  });

  test('a custom block root is read instead of the canonical one', () => {
    // The plugin id IS the config section, so a plug-in registered under
    // another id must read that id's block — and only that one.
    const config = Config.parseString(`
      actor-ts.persistence.journal.sqlite.events-table = "canonical"
      actor-ts.persistence.journal.app.events-table = "custom"
    `);

    expect(readSqliteJournalOptionsFromConfig(config, 'actor-ts.persistence.journal.app'))
      .toEqual({ eventsTable: 'custom' });
    expect(readSqliteJournalOptionsFromConfig(config)).toEqual({ eventsTable: 'canonical' });
  });
});

describe('readSqliteSnapshotStoreOptionsFromConfig', () => {
  test('the shipped reference.conf resolves to the documented defaults', () => {
    const options = readSqliteSnapshotStoreOptionsFromConfig(reference);

    expect(options).toEqual({
      snapshotsTable: DEFAULT_SNAPSHOTS_TABLE,
      keepN: DEFAULT_SNAPSHOT_KEEP_N,
      busyTimeoutMs: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
    });
    expect(ownKeysOf(options)).toEqual(['snapshotsTable', 'keepN', 'busyTimeoutMs']);
  });

  test('an absent block yields nothing at all', () => {
    expect(ownKeysOf(readSqliteSnapshotStoreOptionsFromConfig(unrelated))).toEqual([]);
  });

  test('keep-n = 0 is read as 0 — that is how pruning is switched off', () => {
    // The one leaf where a falsy value is meaningful: dropped as "unset" it
    // would silently restore pruning on a store configured not to prune.
    const options = readSqliteSnapshotStoreOptionsFromConfig(
      sqliteConfig(ConfigKeys.persistence.snapshotStore.sqlite.root, 'keep-n = 0'),
    );

    expect(options).toEqual({ keepN: 0 });
  });

  test('reads every leaf', () => {
    const options = readSqliteSnapshotStoreOptionsFromConfig(sqliteConfig(
      ConfigKeys.persistence.snapshotStore.sqlite.root,
      'path = "./snap.db", snapshots-table = "snaps", keep-n = 5, busy-timeout = 2s',
    ));

    expect(options).toEqual({
      path: './snap.db',
      snapshotsTable: 'snaps',
      keepN: 5,
      busyTimeoutMs: 2_000,
    });
  });
});

describe('readSqliteDurableStateStoreOptionsFromConfig', () => {
  test('the shipped reference.conf resolves to the documented defaults', () => {
    const options = readSqliteDurableStateStoreOptionsFromConfig(reference);

    expect(options).toEqual({
      table: DEFAULT_DURABLE_STATE_TABLE,
      autoCreateTables: DEFAULT_AUTO_CREATE_TABLES,
      busyTimeoutMs: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
    });
    expect(ownKeysOf(options)).toEqual(['table', 'autoCreateTables', 'busyTimeoutMs']);
  });

  test('an absent block yields nothing at all', () => {
    expect(ownKeysOf(readSqliteDurableStateStoreOptionsFromConfig(unrelated))).toEqual([]);
  });

  test('auto-create-tables = off is read as false, not dropped', () => {
    // A deployment that migrates with a schema tool switches this off; read as
    // "unset" it would fall back to `true` and issue the DDL anyway.
    const options = readSqliteDurableStateStoreOptionsFromConfig(
      sqliteConfig(ConfigKeys.persistence.durableState.sqlite.root, 'auto-create-tables = off'),
    );

    expect(options).toEqual({ autoCreateTables: false });
  });

  test('reads every leaf', () => {
    const options = readSqliteDurableStateStoreOptionsFromConfig(sqliteConfig(
      ConfigKeys.persistence.durableState.sqlite.root,
      'path = "./state.db", table = "kv", auto-create-tables = off, busy-timeout = 100ms',
    ));

    expect(options).toEqual({
      path: './state.db',
      table: 'kv',
      autoCreateTables: false,
      busyTimeoutMs: 100,
    });
  });
});

describe('the three blocks are read independently', () => {
  test('a journal block does not leak into the snapshot or durable-state readers', () => {
    // All three carry a `path` and a `busy-timeout`, so a reader that composed
    // its paths from the wrong root would read plausible values and pass every
    // assertion above.
    const config = sqliteConfig(
      ConfigKeys.persistence.journal.sqlite.root,
      'path = "./events.db", busy-timeout = 7s',
    );

    expect(readSqliteJournalOptionsFromConfig(config)).toEqual({ path: './events.db', busyTimeoutMs: 7_000 });
    expect(readSqliteSnapshotStoreOptionsFromConfig(config)).toEqual({});
    expect(readSqliteDurableStateStoreOptionsFromConfig(config)).toEqual({});
  });
});

/**
 * The relational family — Postgres, MariaDB, SQL Server, libSQL and Cloudflare
 * D1 (#872, slice 2).
 *
 * Fifteen readers over fifteen blocks, and the reason they are asserted one by
 * one rather than by a shared helper is the mistake a shared helper cannot
 * catch: the leaf *names* are identical across all fifteen — `events-table`,
 * `snapshots-table`, `keep-n`, `table`, `auto-create-tables` — so a reader that
 * composed its paths from the wrong backend's root, or from the wrong axis,
 * would read entirely plausible values.  `NoDeadConfigKeys` cannot see that at
 * all: its `coveringAccessor` falls back to a root above the leaf, and every
 * one of these roots is *also* hard-coded as a plugin id in the matching
 * `XxxPlugin.ts`, so the guard is satisfied by a string that is not a config
 * read.  The table below is what actually pins a leaf to a value.
 */
type RelationalReader = (config: Config, blockRoot?: string) => Record<string, unknown>;

type RelationalReaderCase = {
  /** Reader name, for the test title. */
  readonly name: string;
  readonly read: RelationalReader;
  /** The canonical block root the reader defaults to. */
  readonly root: string;
  /** Exactly what the shipped reference.conf resolves to — no more, no less. */
  readonly fromReference: Record<string, unknown>;
};

// Mutable rather than `readonly`: bun's `test.each` takes a mutable array, and
// widening it here beats casting at each of the three call sites.
const relationalReaders: RelationalReaderCase[] = [
  {
    name: 'readPostgresJournalOptionsFromConfig',
    read: readPostgresJournalOptionsFromConfig,
    root: ConfigKeys.persistence.journal.postgres.root,
    fromReference: { eventsTable: DEFAULT_EVENTS_TABLE, autoCreateTables: DEFAULT_AUTO_CREATE_TABLES },
  },
  {
    name: 'readPostgresSnapshotStoreOptionsFromConfig',
    read: readPostgresSnapshotStoreOptionsFromConfig,
    root: ConfigKeys.persistence.snapshotStore.postgres.root,
    fromReference: {
      snapshotsTable: DEFAULT_SNAPSHOTS_TABLE,
      keepN: DEFAULT_SNAPSHOT_KEEP_N,
      autoCreateTables: DEFAULT_AUTO_CREATE_TABLES,
    },
  },
  {
    name: 'readPostgresDurableStateStoreOptionsFromConfig',
    read: readPostgresDurableStateStoreOptionsFromConfig,
    root: ConfigKeys.persistence.durableState.postgres.root,
    fromReference: { table: DEFAULT_DURABLE_STATE_TABLE, autoCreateTables: DEFAULT_AUTO_CREATE_TABLES },
  },
  {
    name: 'readMariaDbJournalOptionsFromConfig',
    read: readMariaDbJournalOptionsFromConfig,
    root: ConfigKeys.persistence.journal.mariadb.root,
    fromReference: { eventsTable: DEFAULT_EVENTS_TABLE, autoCreateTables: DEFAULT_AUTO_CREATE_TABLES },
  },
  {
    name: 'readMariaDbSnapshotStoreOptionsFromConfig',
    read: readMariaDbSnapshotStoreOptionsFromConfig,
    root: ConfigKeys.persistence.snapshotStore.mariadb.root,
    fromReference: {
      snapshotsTable: DEFAULT_SNAPSHOTS_TABLE,
      keepN: DEFAULT_SNAPSHOT_KEEP_N,
      autoCreateTables: DEFAULT_AUTO_CREATE_TABLES,
    },
  },
  {
    name: 'readMariaDbDurableStateStoreOptionsFromConfig',
    read: readMariaDbDurableStateStoreOptionsFromConfig,
    root: ConfigKeys.persistence.durableState.mariadb.root,
    fromReference: { table: DEFAULT_DURABLE_STATE_TABLE, autoCreateTables: DEFAULT_AUTO_CREATE_TABLES },
  },
  {
    name: 'readMsSqlJournalOptionsFromConfig',
    read: readMsSqlJournalOptionsFromConfig,
    root: ConfigKeys.persistence.journal.mssql.root,
    fromReference: { eventsTable: DEFAULT_EVENTS_TABLE, autoCreateTables: DEFAULT_AUTO_CREATE_TABLES },
  },
  {
    name: 'readMsSqlSnapshotStoreOptionsFromConfig',
    read: readMsSqlSnapshotStoreOptionsFromConfig,
    root: ConfigKeys.persistence.snapshotStore.mssql.root,
    fromReference: {
      snapshotsTable: DEFAULT_SNAPSHOTS_TABLE,
      keepN: DEFAULT_SNAPSHOT_KEEP_N,
      autoCreateTables: DEFAULT_AUTO_CREATE_TABLES,
    },
  },
  {
    name: 'readMsSqlDurableStateStoreOptionsFromConfig',
    read: readMsSqlDurableStateStoreOptionsFromConfig,
    root: ConfigKeys.persistence.durableState.mssql.root,
    fromReference: { table: DEFAULT_DURABLE_STATE_TABLE, autoCreateTables: DEFAULT_AUTO_CREATE_TABLES },
  },
  {
    name: 'readLibSqlJournalOptionsFromConfig',
    read: readLibSqlJournalOptionsFromConfig,
    root: ConfigKeys.persistence.journal.libsql.root,
    fromReference: { eventsTable: DEFAULT_EVENTS_TABLE, autoCreateTables: DEFAULT_AUTO_CREATE_TABLES },
  },
  {
    name: 'readLibSqlSnapshotStoreOptionsFromConfig',
    read: readLibSqlSnapshotStoreOptionsFromConfig,
    root: ConfigKeys.persistence.snapshotStore.libsql.root,
    fromReference: {
      snapshotsTable: DEFAULT_SNAPSHOTS_TABLE,
      keepN: DEFAULT_SNAPSHOT_KEEP_N,
      autoCreateTables: DEFAULT_AUTO_CREATE_TABLES,
    },
  },
  {
    name: 'readLibSqlDurableStateStoreOptionsFromConfig',
    read: readLibSqlDurableStateStoreOptionsFromConfig,
    root: ConfigKeys.persistence.durableState.libsql.root,
    fromReference: { table: DEFAULT_DURABLE_STATE_TABLE, autoCreateTables: DEFAULT_AUTO_CREATE_TABLES },
  },
  {
    name: 'readD1JournalOptionsFromConfig',
    read: readD1JournalOptionsFromConfig,
    root: ConfigKeys.persistence.journal.cloudflareD1.root,
    fromReference: {
      baseUrl: DEFAULT_D1_BASE_URL,
      eventsTable: DEFAULT_EVENTS_TABLE,
      autoCreateTables: DEFAULT_AUTO_CREATE_TABLES,
    },
  },
  {
    name: 'readD1SnapshotStoreOptionsFromConfig',
    read: readD1SnapshotStoreOptionsFromConfig,
    root: ConfigKeys.persistence.snapshotStore.cloudflareD1.root,
    fromReference: {
      baseUrl: DEFAULT_D1_BASE_URL,
      snapshotsTable: DEFAULT_SNAPSHOTS_TABLE,
      keepN: DEFAULT_SNAPSHOT_KEEP_N,
      autoCreateTables: DEFAULT_AUTO_CREATE_TABLES,
    },
  },
  {
    name: 'readD1DurableStateStoreOptionsFromConfig',
    read: readD1DurableStateStoreOptionsFromConfig,
    root: ConfigKeys.persistence.durableState.cloudflareD1.root,
    fromReference: {
      baseUrl: DEFAULT_D1_BASE_URL,
      table: DEFAULT_DURABLE_STATE_TABLE,
      autoCreateTables: DEFAULT_AUTO_CREATE_TABLES,
    },
  },
];

describe('the relational family reads its own block', () => {
  test('every relational reader is covered exactly once', () => {
    // Guards the table: a reader added to src/ and forgotten here would leave
    // its block asserted by nothing at all, which is the state the whole family
    // was in before this commit.
    expect(relationalReaders).toHaveLength(15);
    expect(new Set(relationalReaders.map((entry) => entry.root)).size).toBe(15);
  });

  test.each(relationalReaders)(
    '$name resolves the shipped reference.conf to exactly the documented defaults',
    ({ read, fromReference }) => {
      const options = read(reference);

      expect(options).toEqual(fromReference);
      // `toEqual` ignores a property whose value is `undefined`, so it cannot
      // tell an omitted leaf from one punched through as a hole — and a hole
      // would shadow the explicit options this result is spread under.
      expect(ownKeysOf(options)).toEqual(Object.keys(fromReference));
    },
  );

  test.each(relationalReaders)('$name yields nothing at all for an absent block', ({ read }) => {
    const options = read(unrelated);

    expect(options).toEqual({});
    expect(ownKeysOf(options)).toEqual([]);
  });

  test.each(relationalReaders)('$name reads only its own root', ({ read, root }) => {
    // Every one of the fifteen blocks spells its table leaves the same way, so
    // a reader pointed at a sibling root reads a real value and looks correct.
    const others = relationalReaders.filter((entry) => entry.root !== root);
    const config = Config.parseString(
      others.map((entry) => `${entry.root}.auto-create-tables = off`).join('\n'),
    );

    expect(read(config)).toEqual({});
  });
});

describe('the relational connection halves', () => {
  test('an empty url is dropped rather than passed through as ""', () => {
    // `new pg.Pool({ connectionString: '' })` does not fail — it falls back to
    // the PG* environment variables — so a published placeholder forwarded
    // verbatim would connect somewhere nobody asked for.
    const options = readPostgresJournalOptionsFromConfig(
      Config.parseString(`${ConfigKeys.persistence.journal.postgres.root}.url = ""`),
    );

    expect(options.url).toBeUndefined();
    expect(ownKeysOf(options)).toEqual([]);
  });

  test('libSQL reads url and auth-token, and drops both when empty', () => {
    const set = readLibSqlJournalOptionsFromConfig(Config.parseString(`
      ${ConfigKeys.persistence.journal.libsql.root} {
        url = "libsql://db.turso.io"
        auth-token = "secret"
      }
    `));
    const unset = readLibSqlJournalOptionsFromConfig(Config.parseString(`
      ${ConfigKeys.persistence.journal.libsql.root} {
        url = ""
        auth-token = ""
      }
    `));

    expect(set).toEqual({ url: 'libsql://db.turso.io', authToken: 'secret' });
    expect(ownKeysOf(unset)).toEqual([]);
  });

  test('D1 reads its three coordinates, and keeps the published base-url', () => {
    const options = readD1JournalOptionsFromConfig(Config.parseString(`
      ${ConfigKeys.persistence.journal.cloudflareD1.root} {
        account-id  = "acct"
        database-id = "db-uuid"
        api-token   = "token"
      }
    `));

    expect(options).toEqual({ accountId: 'acct', databaseId: 'db-uuid', apiToken: 'token' });
  });

  test('a live object written into a block is not read, whatever it is called', () => {
    // The mitigation is the absent path, not a filter that could be forgotten:
    // a pool, a client and a serializer have no leaf at all.  `pool-config` has
    // none either — it is free-form driver config with no enumerable leaf set.
    const options = readPostgresJournalOptionsFromConfig(Config.parseString(`
      ${ConfigKeys.persistence.journal.postgres.root} {
        pool = "handle"
        pool-config = { max = 10 }
        serializer = "cbor"
      }
    `));

    expect(options).toEqual({});
    expect(JSON.stringify(options)).not.toContain('cbor');
  });
});

describe('the relational table halves', () => {
  test('tags-table is comment-only but read — absence is what derives it', () => {
    // The default is `${events-table}_tags`, computed in RelationalJournal, so
    // absence is the only way to keep the two in step.  That is exactly the
    // case reference.conf ships as a comment rather than a leaf — invisible to
    // the leaf-driven guards, and still reachable from an application.conf.
    const derived = readPostgresJournalOptionsFromConfig(
      Config.parseString(`${ConfigKeys.persistence.journal.postgres.root}.events-table = "journal"`),
    );
    const pinned = readPostgresJournalOptionsFromConfig(Config.parseString(`
      ${ConfigKeys.persistence.journal.postgres.root} {
        events-table = "journal"
        tags-table   = "journal_labels"
      }
    `));

    expect(ownKeysOf(derived)).toEqual(['eventsTable']);
    expect(pinned).toEqual({ eventsTable: 'journal', tagsTable: 'journal_labels' });
  });

  test('keep-n = 0 is read as 0 — that is how pruning is switched off', () => {
    const options = readMariaDbSnapshotStoreOptionsFromConfig(
      Config.parseString(`${ConfigKeys.persistence.snapshotStore.mariadb.root}.keep-n = 0`),
    );

    expect(options).toEqual({ keepN: 0 });
  });

  test('auto-create-tables = off is read as false, not dropped', () => {
    // A deployment whose schema is owned by a migration tool switches this off;
    // read as "unset" it would fall back to `true` and issue the DDL anyway.
    const options = readMsSqlDurableStateStoreOptionsFromConfig(
      Config.parseString(`${ConfigKeys.persistence.durableState.mssql.root}.auto-create-tables = off`),
    );

    expect(options).toEqual({ autoCreateTables: false });
  });

  test('a custom block root is read instead of the canonical one', () => {
    // The plugin id IS the config section, so a plug-in registered under
    // another id must read that id's block — and only that one.
    const config = Config.parseString(`
      actor-ts.persistence.journal.postgres.events-table = "canonical"
      actor-ts.persistence.journal.ledger.events-table   = "custom"
    `);

    expect(readPostgresJournalOptionsFromConfig(config, 'actor-ts.persistence.journal.ledger'))
      .toEqual({ eventsTable: 'custom' });
    expect(readPostgresJournalOptionsFromConfig(config)).toEqual({ eventsTable: 'canonical' });
  });
});
