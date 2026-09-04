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
import {
  readMongoDurableStateStoreOptionsFromConfig,
  readMongoJournalOptionsFromConfig,
  readMongoSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/MongoPluginOptions.js';
import {
  readDynamoDbDurableStateStoreOptionsFromConfig,
  readDynamoDbJournalOptionsFromConfig,
  readDynamoDbSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/DynamoDbPluginOptions.js';
import {
  readCassandraJournalOptionsFromConfig,
  readCassandraSnapshotStoreOptionsFromConfig,
} from '../../../src/persistence/journals/CassandraPluginOptions.js';
import { readInMemorySnapshotStoreOptionsFromConfig } from '../../../src/persistence/snapshot-stores/InMemorySnapshotStoreOptions.js';
import { DEFAULT_MONGO_AUTO_CREATE_INDEXES } from '../../../src/persistence/Constants.js';
import { DEFAULT_MONGO_DATABASE } from '../../../src/persistence/journals/MongoClient.js';
import { DEFAULT_DYNAMODB_EVENTS_TABLE } from '../../../src/persistence/journals/DynamoDbJournalOptions.js';
import { DEFAULT_DYNAMODB_SNAPSHOTS_TABLE } from '../../../src/persistence/snapshot-stores/DynamoDbSnapshotStoreOptions.js';
import { DEFAULT_DYNAMODB_DURABLE_STATE_TABLE } from '../../../src/persistence/durable-state-stores/DynamoDbDurableStateStoreOptions.js';
import {
  DEFAULT_CASSANDRA_LOCAL_DATA_CENTER,
  DEFAULT_CASSANDRA_PORT,
  DEFAULT_CASSANDRA_TAG_INDEX_TABLE,
} from '../../../src/persistence/journals/CassandraClient.js';
import {
  DEFAULT_CASSANDRA_ALL_IDS_TABLE,
  DEFAULT_CASSANDRA_LIGHTWEIGHT_TRANSACTIONS,
  DEFAULT_CASSANDRA_METADATA_TABLE,
  DEFAULT_CASSANDRA_PARTITION_SIZE,
} from '../../../src/persistence/journals/CassandraJournalOptions.js';

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

/**
 * The non-relational family (#872, slice 3), asserted the same way and for the
 * same reason: these eight readers share their leaf *names* with each other and
 * with the fifteen above — `keep-n`, `region`, `keyspace`, `url` — so a reader
 * composed from the wrong root or the wrong axis reads a plausible value and
 * `NoDeadConfigKeys` stays green over it.
 *
 * Cassandra is the sharpest case in the repository: `ConfigKeys` has carried
 * `persistence.journal.cassandra` since long before this change, and
 * `CassandraPlugin.ts` has carried the same literal as its plugin id, so the
 * guard's `isReferencedInSource` was satisfied by a string that is not a config
 * read at all.  The block was inert and green.
 */
const nonRelationalReaders: RelationalReaderCase[] = [
  {
    name: 'readMongoJournalOptionsFromConfig',
    read: readMongoJournalOptionsFromConfig,
    root: ConfigKeys.persistence.journal.mongodb.root,
    fromReference: {
      databaseName: DEFAULT_MONGO_DATABASE,
      eventsCollection: DEFAULT_EVENTS_TABLE,
      autoCreateIndexes: DEFAULT_MONGO_AUTO_CREATE_INDEXES,
    },
  },
  {
    name: 'readMongoSnapshotStoreOptionsFromConfig',
    read: readMongoSnapshotStoreOptionsFromConfig,
    root: ConfigKeys.persistence.snapshotStore.mongodb.root,
    fromReference: {
      databaseName: DEFAULT_MONGO_DATABASE,
      snapshotsCollection: DEFAULT_SNAPSHOTS_TABLE,
      keepN: DEFAULT_SNAPSHOT_KEEP_N,
      autoCreateIndexes: DEFAULT_MONGO_AUTO_CREATE_INDEXES,
    },
  },
  {
    name: 'readMongoDurableStateStoreOptionsFromConfig',
    read: readMongoDurableStateStoreOptionsFromConfig,
    root: ConfigKeys.persistence.durableState.mongodb.root,
    fromReference: {
      databaseName: DEFAULT_MONGO_DATABASE,
      collection: DEFAULT_DURABLE_STATE_TABLE,
    },
  },
  {
    name: 'readDynamoDbJournalOptionsFromConfig',
    read: readDynamoDbJournalOptionsFromConfig,
    root: ConfigKeys.persistence.journal.dynamodb.root,
    fromReference: { eventsTable: DEFAULT_DYNAMODB_EVENTS_TABLE },
  },
  {
    name: 'readDynamoDbSnapshotStoreOptionsFromConfig',
    read: readDynamoDbSnapshotStoreOptionsFromConfig,
    root: ConfigKeys.persistence.snapshotStore.dynamodb.root,
    fromReference: {
      snapshotsTable: DEFAULT_DYNAMODB_SNAPSHOTS_TABLE,
      keepN: DEFAULT_SNAPSHOT_KEEP_N,
    },
  },
  {
    name: 'readDynamoDbDurableStateStoreOptionsFromConfig',
    read: readDynamoDbDurableStateStoreOptionsFromConfig,
    root: ConfigKeys.persistence.durableState.dynamodb.root,
    fromReference: { table: DEFAULT_DYNAMODB_DURABLE_STATE_TABLE },
  },
  {
    name: 'readCassandraJournalOptionsFromConfig',
    read: readCassandraJournalOptionsFromConfig,
    root: ConfigKeys.persistence.journal.cassandra.root,
    fromReference: {
      localDataCenter: DEFAULT_CASSANDRA_LOCAL_DATA_CENTER,
      port: DEFAULT_CASSANDRA_PORT,
      autoCreateKeyspace: false,
      eventsTable: DEFAULT_EVENTS_TABLE,
      metadataTable: DEFAULT_CASSANDRA_METADATA_TABLE,
      allIdsTable: DEFAULT_CASSANDRA_ALL_IDS_TABLE,
      tagIndexTable: DEFAULT_CASSANDRA_TAG_INDEX_TABLE,
      partitionSize: DEFAULT_CASSANDRA_PARTITION_SIZE,
      autoCreateTables: DEFAULT_AUTO_CREATE_TABLES,
      useTagIndex: false,
      lightweightTransactions: DEFAULT_CASSANDRA_LIGHTWEIGHT_TRANSACTIONS,
    },
  },
  {
    name: 'readCassandraSnapshotStoreOptionsFromConfig',
    read: readCassandraSnapshotStoreOptionsFromConfig,
    root: ConfigKeys.persistence.snapshotStore.cassandra.root,
    fromReference: {
      localDataCenter: DEFAULT_CASSANDRA_LOCAL_DATA_CENTER,
      port: DEFAULT_CASSANDRA_PORT,
      autoCreateKeyspace: false,
      snapshotsTable: DEFAULT_SNAPSHOTS_TABLE,
      keepN: DEFAULT_SNAPSHOT_KEEP_N,
      autoCreateTables: DEFAULT_AUTO_CREATE_TABLES,
    },
  },
];

describe('the non-relational family reads its own block', () => {
  test('every non-relational reader is covered exactly once', () => {
    // Eight, not nine: there is no Cassandra durable-state store in the tree,
    // so that backend has two axes where Mongo and DynamoDB have three.  A
    // reader added to src/ and forgotten here would leave its block asserted by
    // nothing at all.
    expect(nonRelationalReaders).toHaveLength(8);
    expect(new Set(nonRelationalReaders.map((entry) => entry.root)).size).toBe(8);
  });

  test.each(nonRelationalReaders)(
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

  test.each(nonRelationalReaders)('$name yields nothing at all for an absent block', ({ read }) => {
    const options = read(unrelated);

    expect(options).toEqual({});
    expect(ownKeysOf(options)).toEqual([]);
  });

  test.each(nonRelationalReaders)('$name reads only its own root', ({ read, root }) => {
    // Every Mongo block spells `database-name` the same way and every DynamoDB
    // block spells `region` the same way, so a reader pointed at a sibling root
    // reads a real value and looks correct.
    const others = [...relationalReaders, ...nonRelationalReaders]
      .filter((entry) => entry.root !== root);
    const config = Config.parseString(
      others.map((entry) => `${entry.root}.keep-n = 7`).join('\n'),
    );

    expect(read(config)).toEqual({});
  });
});

describe('the non-relational connection halves', () => {
  test('an empty mongodb url is dropped rather than passed through as ""', () => {
    // `assertMongoUrl` runs `new URL('')`, which throws — so a published
    // placeholder forwarded verbatim would refuse every config-built store.
    const options = readMongoJournalOptionsFromConfig(
      Config.parseString(`${ConfigKeys.persistence.journal.mongodb.root}.url = ""`),
    );

    expect(options.url).toBeUndefined();
    expect(ownKeysOf(options)).toEqual([]);
  });

  test('DynamoDB reads region and endpoint, and drops both when empty', () => {
    const set = readDynamoDbJournalOptionsFromConfig(Config.parseString(`
      ${ConfigKeys.persistence.journal.dynamodb.root} {
        region   = "eu-central-1"
        endpoint = "http://localhost:8000"
      }
    `));
    const unset = readDynamoDbJournalOptionsFromConfig(Config.parseString(`
      ${ConfigKeys.persistence.journal.dynamodb.root} {
        region   = ""
        endpoint = ""
      }
    `));

    expect(set).toEqual({ region: 'eu-central-1', endpoint: 'http://localhost:8000' });
    expect(ownKeysOf(unset)).toEqual([]);
  });

  test('an empty cassandra seed list is dropped, a populated one is read', () => {
    // `contactPoints` is the one LIST-shaped placeholder in the reference
    // configuration.  Passed through, `[]` would outrank the seeds the register
    // helper was given and the driver would refuse to connect at all.
    const empty = readCassandraJournalOptionsFromConfig(Config.parseString(`
      ${ConfigKeys.persistence.journal.cassandra.root} {
        contact-points = []
        keyspace = ""
      }
    `));
    const seeded = readCassandraJournalOptionsFromConfig(Config.parseString(`
      ${ConfigKeys.persistence.journal.cassandra.root} {
        contact-points = ["10.0.0.1", "10.0.0.2"]
        keyspace = "app"
      }
    `));

    expect(ownKeysOf(empty)).toEqual([]);
    expect(seeded).toEqual({ contactPoints: ['10.0.0.1', '10.0.0.2'], keyspace: 'app' });
  });

  test('the two cassandra consistency levels are comment-only but read', () => {
    // Neither has a framework default — both read sites branch on `undefined`
    // and hand the choice to the driver — so absence is what keeps that true
    // and `reference.conf` ships them as comments.  Read all the same, so an
    // application.conf can still pin them.
    const shipped = readCassandraJournalOptionsFromConfig(reference);
    const pinned = readCassandraJournalOptionsFromConfig(Config.parseString(`
      ${ConfigKeys.persistence.journal.cassandra.root} {
        consistency = 6
        serial-consistency = 9
      }
    `));

    expect(shipped.consistency).toBeUndefined();
    expect(shipped.serialConsistency).toBeUndefined();
    expect(pinned).toEqual({ consistency: 6, serialConsistency: 9 });
  });

  test('a custom cassandra block root is read instead of the canonical one', () => {
    const config = Config.parseString(`
      actor-ts.persistence.journal.cassandra.keyspace = "canonical"
      actor-ts.persistence.journal.ledger.keyspace    = "custom"
    `);

    expect(readCassandraJournalOptionsFromConfig(config, 'actor-ts.persistence.journal.ledger'))
      .toEqual({ keyspace: 'custom' });
    expect(readCassandraJournalOptionsFromConfig(config)).toEqual({ keyspace: 'canonical' });
  });
});

describe('readInMemorySnapshotStoreOptionsFromConfig', () => {
  test('the shipped reference.conf resolves to unbounded retention', () => {
    // `0` is the whole point: this is the store `PersistenceExtension` installs
    // when nothing is configured, so it keeps every snapshot where the
    // persistent stores keep three.  A published `3` here would silently start
    // discarding snapshots for every unconfigured application in the repo.
    const options = readInMemorySnapshotStoreOptionsFromConfig(reference);

    expect(options).toEqual({ keepN: 0 });
    expect(options.keepN).not.toBe(DEFAULT_SNAPSHOT_KEEP_N);
  });

  test('a bound is read as the number it says', () => {
    const options = readInMemorySnapshotStoreOptionsFromConfig(
      Config.parseString(`${ConfigKeys.persistence.snapshotStore.inMemory.root}.keep-n = 5`),
    );

    expect(options).toEqual({ keepN: 5 });
  });

  test('an absent block yields nothing at all, not a bag of undefined', () => {
    const options = readInMemorySnapshotStoreOptionsFromConfig(unrelated);

    expect(options).toEqual({});
    expect(ownKeysOf(options)).toEqual([]);
  });
});
