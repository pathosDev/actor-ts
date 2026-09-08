import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Config } from '../../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { getSqliteDriver } from '../../../../src/runtime/sqlite/index.js';
import type { PersistenceExtension } from '../../../../src/persistence/index.js';
import {
  CASSANDRA_JOURNAL_PLUGIN_ID,
  CASSANDRA_SNAPSHOT_PLUGIN_ID,
  D1_DURABLE_STATE_PLUGIN_ID,
  D1_JOURNAL_PLUGIN_ID,
  D1_SNAPSHOT_PLUGIN_ID,
  DYNAMODB_DURABLE_STATE_PLUGIN_ID,
  DYNAMODB_JOURNAL_PLUGIN_ID,
  DYNAMODB_SNAPSHOT_PLUGIN_ID,
  LIBSQL_DURABLE_STATE_PLUGIN_ID,
  LIBSQL_JOURNAL_PLUGIN_ID,
  LIBSQL_SNAPSHOT_PLUGIN_ID,
  MARIADB_DURABLE_STATE_PLUGIN_ID,
  MARIADB_JOURNAL_PLUGIN_ID,
  MARIADB_SNAPSHOT_PLUGIN_ID,
  MONGO_DURABLE_STATE_PLUGIN_ID,
  MONGO_JOURNAL_PLUGIN_ID,
  MONGO_SNAPSHOT_PLUGIN_ID,
  MSSQL_DURABLE_STATE_PLUGIN_ID,
  MSSQL_JOURNAL_PLUGIN_ID,
  MSSQL_SNAPSHOT_PLUGIN_ID,
  POSTGRES_DURABLE_STATE_PLUGIN_ID,
  POSTGRES_JOURNAL_PLUGIN_ID,
  POSTGRES_SNAPSHOT_PLUGIN_ID,
  PersistenceExtensionId,
  SQLITE_DURABLE_STATE_PLUGIN_ID,
  SQLITE_JOURNAL_PLUGIN_ID,
  SQLITE_SNAPSHOT_PLUGIN_ID,
  registerCassandraPlugins,
  registerD1Plugins,
  registerDynamoDbPlugins,
  registerLibSqlPlugins,
  registerMariaDbPlugins,
  registerMongoPlugins,
  registerMsSqlPlugins,
  registerPostgresPlugins,
  registerSqlitePlugins,
} from '../../../../src/persistence/index.js';
import { FakeCassandraClient } from './FakeCassandraClient.js';
import { FakeD1Client } from './FakeD1Client.js';
import { FakeDynamoDb } from './FakeDynamoDb.js';
import { FakeLibSqlClient } from './FakeLibSqlClient.js';
import { FakeMariaDbPool } from './FakeMariaDbPool.js';
import { FakeMongoClient } from './FakeMongoClient.js';
import { FakeMsSqlPool } from './FakeMsSqlPool.js';
import { FakePgPool } from './FakePgPool.js';

/**
 * #872 — the proof that a persistence plug-in's HOCON block reaches the store
 * the plug-in constructs, for **every** backend rather than for SQLite alone.
 *
 * `PersistenceConfigDefaults.test.ts` pins each `read*OptionsFromConfig` to the
 * object it returns, and that is a real gate — but a reader is only half a
 * binding.  The other half is the factory registered by `register*Plugins`
 * layering that object under the caller's own options and handing the result to
 * a store constructor, and until this file nothing asserted it anywhere except
 * `SqlitePlugin.test.ts`.  Measured, not assumed: replacing all 23 reader calls
 * in the eight non-SQLite plug-ins with `{}` left the whole suite green.
 *
 * **One suite over nine backends, not nine copies.**  The property does not
 * vary by backend — a block names a container, the store addresses that
 * container — so what varies is only the vocabulary (`events-table` /
 * `events-collection`), the live object that stands in for a driver, and how
 * the backend records what it was asked to do.  Those three go in the case
 * table below; the two tests are written once.  It is the shape
 * `PersistenceContract.test.ts` already uses for the storage contracts, and the
 * reason is the same: a ninth copy of an assertion is a ninth place for it to
 * be quietly weakened.
 *
 * **Why a fake driver and not a live one.**  Eight of the nine backends need a
 * driver the root install deliberately does not carry — see
 * `tests/integration/brokers/package.json` and `tsconfig.dev.json`'s exclude
 * entry — so the test cannot connect.  What it can do is watch what the store
 * *addresses*, which is exactly where a config leaf ends up: every composite
 * takes a shared live object (`pool` / `client` / `operations`), and every fake
 * in this directory already records the statements it is handed.  SQLite keeps
 * its real file, because it can.
 *
 * **A container name is the witness for the whole reader.**  Each factory
 * layers one object — everything `read*OptionsFromConfig` returned — under the
 * caller's options and hands the result to one constructor, so a leaf reaching
 * the store is not a per-leaf question: either that object arrived or it did
 * not.  The container name is simply the leaf whose arrival is *observable*
 * without a live database, which is why `keep-n`, `auto-create-tables` and the
 * connection halves are left to `PersistenceConfigDefaults.test.ts` rather than
 * asserted a second time here.
 *
 * The container names below are deliberately prefixed rather than merely
 * different: `hocon_events` and the built-in `events` differ by a prefix, so
 * {@link mentions} matches whole words only — a substring probe would report
 * every arm green whether or not anything bound.
 */

/** Named only in the block, and never a built-in default of any backend. */
const HOCON_EVENTS = 'hocon_events';
/**
 * A **second** container in the journal's own block — the tags table for the
 * relational family, the database for Mongo, the metadata table for Cassandra.
 * It is what makes the precedence assertion per *field* rather than per store:
 * a factory that took the caller's options wholesale whenever they are present
 * would still address `code_events` and would lose this one.
 */
const HOCON_JOURNAL_SIBLING = 'hocon_sibling';
const HOCON_SNAPSHOTS = 'hocon_snapshots';
const HOCON_STATE = 'hocon_state';
/** The one container named in code rather than in the block. */
const CODE_EVENTS = 'code_events';

/** The three axis selectors, spelled out — this file is what pins them. */
const JOURNAL_PLUGIN_KEY = 'actor-ts.persistence.journal.plugin';
const SNAPSHOT_PLUGIN_KEY = 'actor-ts.persistence.snapshot-store.plugin';
const DURABLE_STATE_PLUGIN_KEY = 'actor-ts.persistence.durable-state.plugin';

/**
 * Everything a backend was asked to do, as text: the statement log of a fake
 * driver, or — for SQLite — the tables that ended up in the file.
 */
type BackendTranscript = () => Promise<readonly string[]>;

/** One backend's arm, rebuilt per test so no two tests share a recorder. */
type BackendArm = {
  /** Selects all three axes and names every container. */
  readonly hocon: string;
  /**
   * Register the plug-ins with the recorder injected.  `eventsInCode` names the
   * journal's event container in code instead of leaving it to the block.
   */
  readonly register: (persistence: PersistenceExtension, eventsInCode?: string) => void;
  readonly transcript: BackendTranscript;
};

type PluginBindingCase = {
  readonly name: string;
  readonly arm: () => BackendArm;
  /** False for Cassandra: the tree ships no Cassandra durable-state store. */
  readonly hasDurableStateStore: boolean;
  /** True where the journal's block holds a second container to fall through on. */
  readonly journalHasSiblingContainer: boolean;
  /** What the stores address when nothing binds the block — must stay untouched. */
  readonly builtInContainers: readonly string[];
};

/** Select an axis and open that plug-in's own block — a plug-in id *is* its config section. */
function axis(selectorKey: string, pluginId: string, body: string): string {
  return `${selectorKey} = "${pluginId}"\n${pluginId} {\n${body}\n}\n`;
}

/** The five relational backends share one leaf vocabulary; so does their HOCON. */
function relationalHocon(journalId: string, snapshotId: string, durableStateId: string): string {
  return [
    axis(JOURNAL_PLUGIN_KEY, journalId, [
      `events-table = "${HOCON_EVENTS}"`,
      `tags-table = "${HOCON_JOURNAL_SIBLING}"`,
    ].join('\n')),
    axis(SNAPSHOT_PLUGIN_KEY, snapshotId, `snapshots-table = "${HOCON_SNAPSHOTS}"`),
    axis(DURABLE_STATE_PLUGIN_KEY, durableStateId, `table = "${HOCON_STATE}"`),
  ].join('\n');
}

/** The containers every relational backend falls back to with nothing bound. */
const RELATIONAL_BUILT_IN = ['events', 'snapshots', 'durable_state'] as const;

/**
 * Whole-word match.  `_` counts as a word character, so a probe for the
 * built-in `events` does **not** match `hocon_events`, and a probe for
 * `hocon_events` does not match the derived `hocon_events_tags`.  Every name
 * here is `[a-z_]+`, so it needs no escaping.
 */
function mentions(lines: readonly string[], container: string): boolean {
  const wholeWord = new RegExp(`\\b${container}\\b`);
  return lines.some((line) => wholeWord.test(line));
}

const temporaryRoots: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'actor-ts-binding-'));
  temporaryRoots.push(directory);
  return join(directory, 'binding.db');
}

afterAll(() => {
  // Best-effort, for the reason `SqlitePlugin.test.ts` gives: Windows refuses
  // to unlink a file another handle still has open.
  for (const directory of temporaryRoots) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* still locked */ }
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

const BACKENDS: readonly PluginBindingCase[] = [
  {
    name: 'postgres',
    hasDurableStateStore: true,
    journalHasSiblingContainer: true,
    builtInContainers: RELATIONAL_BUILT_IN,
    arm: () => {
      const pool = new FakePgPool();
      return {
        hocon: relationalHocon(
          POSTGRES_JOURNAL_PLUGIN_ID, POSTGRES_SNAPSHOT_PLUGIN_ID, POSTGRES_DURABLE_STATE_PLUGIN_ID,
        ),
        register: (persistence, eventsInCode) => registerPostgresPlugins(persistence, {
          pool,
          journal: eventsInCode === undefined ? undefined : { eventsTable: eventsInCode },
        }),
        transcript: async () => pool.log,
      };
    },
  },
  {
    name: 'mariadb',
    hasDurableStateStore: true,
    journalHasSiblingContainer: true,
    builtInContainers: RELATIONAL_BUILT_IN,
    arm: () => {
      const pool = new FakeMariaDbPool();
      return {
        hocon: relationalHocon(
          MARIADB_JOURNAL_PLUGIN_ID, MARIADB_SNAPSHOT_PLUGIN_ID, MARIADB_DURABLE_STATE_PLUGIN_ID,
        ),
        register: (persistence, eventsInCode) => registerMariaDbPlugins(persistence, {
          pool,
          journal: eventsInCode === undefined ? undefined : { eventsTable: eventsInCode },
        }),
        transcript: async () => pool.log,
      };
    },
  },
  {
    name: 'mssql',
    hasDurableStateStore: true,
    journalHasSiblingContainer: true,
    builtInContainers: RELATIONAL_BUILT_IN,
    arm: () => {
      const pool = new FakeMsSqlPool();
      return {
        hocon: relationalHocon(
          MSSQL_JOURNAL_PLUGIN_ID, MSSQL_SNAPSHOT_PLUGIN_ID, MSSQL_DURABLE_STATE_PLUGIN_ID,
        ),
        register: (persistence, eventsInCode) => registerMsSqlPlugins(persistence, {
          pool,
          journal: eventsInCode === undefined ? undefined : { eventsTable: eventsInCode },
        }),
        transcript: async () => pool.log,
      };
    },
  },
  {
    name: 'libsql',
    hasDurableStateStore: true,
    journalHasSiblingContainer: true,
    builtInContainers: RELATIONAL_BUILT_IN,
    arm: () => {
      const client = new FakeLibSqlClient();
      return {
        hocon: relationalHocon(
          LIBSQL_JOURNAL_PLUGIN_ID, LIBSQL_SNAPSHOT_PLUGIN_ID, LIBSQL_DURABLE_STATE_PLUGIN_ID,
        ),
        register: (persistence, eventsInCode) => registerLibSqlPlugins(persistence, {
          client,
          journal: eventsInCode === undefined ? undefined : { eventsTable: eventsInCode },
        }),
        transcript: async () => client.log,
      };
    },
  },
  {
    name: 'cloudflare-d1',
    hasDurableStateStore: true,
    journalHasSiblingContainer: true,
    builtInContainers: RELATIONAL_BUILT_IN,
    arm: () => {
      const client = new FakeD1Client();
      return {
        hocon: relationalHocon(
          D1_JOURNAL_PLUGIN_ID, D1_SNAPSHOT_PLUGIN_ID, D1_DURABLE_STATE_PLUGIN_ID,
        ),
        register: (persistence, eventsInCode) => registerD1Plugins(persistence, {
          client,
          journal: eventsInCode === undefined ? undefined : { eventsTable: eventsInCode },
        }),
        transcript: async () => client.log,
      };
    },
  },
  {
    name: 'mongodb',
    hasDurableStateStore: true,
    journalHasSiblingContainer: true,
    // `actor_ts`, the built-in database, is deliberately absent: only the
    // journal's block renames it here, so the other two legitimately keep it.
    builtInContainers: RELATIONAL_BUILT_IN,
    arm: () => {
      const client = new FakeMongoClient();
      return {
        hocon: [
          axis(JOURNAL_PLUGIN_KEY, MONGO_JOURNAL_PLUGIN_ID, [
            `events-collection = "${HOCON_EVENTS}"`,
            `database-name = "${HOCON_JOURNAL_SIBLING}"`,
          ].join('\n')),
          axis(SNAPSHOT_PLUGIN_KEY, MONGO_SNAPSHOT_PLUGIN_ID, `snapshots-collection = "${HOCON_SNAPSHOTS}"`),
          axis(DURABLE_STATE_PLUGIN_KEY, MONGO_DURABLE_STATE_PLUGIN_ID, `collection = "${HOCON_STATE}"`),
        ].join('\n'),
        register: (persistence, eventsInCode) => registerMongoPlugins(persistence, {
          client,
          journal: eventsInCode === undefined ? undefined : { eventsCollection: eventsInCode },
        }),
        transcript: async () => client.log,
      };
    },
  },
  {
    name: 'dynamodb',
    hasDurableStateStore: true,
    // The DynamoDB journal's block names exactly one container; the fall-through
    // half of the precedence property is carried by the other two axes.
    journalHasSiblingContainer: false,
    builtInContainers: ['actor_ts_events', 'actor_ts_snapshots', 'actor_ts_durable_state'],
    arm: () => {
      const operations = new FakeDynamoDb();
      return {
        hocon: [
          axis(JOURNAL_PLUGIN_KEY, DYNAMODB_JOURNAL_PLUGIN_ID, `events-table = "${HOCON_EVENTS}"`),
          axis(SNAPSHOT_PLUGIN_KEY, DYNAMODB_SNAPSHOT_PLUGIN_ID, `snapshots-table = "${HOCON_SNAPSHOTS}"`),
          axis(DURABLE_STATE_PLUGIN_KEY, DYNAMODB_DURABLE_STATE_PLUGIN_ID, `table = "${HOCON_STATE}"`),
        ].join('\n'),
        register: (persistence, eventsInCode) => registerDynamoDbPlugins(persistence, {
          operations,
          journal: eventsInCode === undefined ? undefined : { eventsTable: eventsInCode },
        }),
        transcript: async () => operations.log,
      };
    },
  },
  {
    name: 'cassandra',
    // No Cassandra durable-state store ships, so this axis is two wide.
    hasDurableStateStore: false,
    journalHasSiblingContainer: true,
    builtInContainers: ['events', 'snapshots', 'metadata'],
    arm: () => {
      const client = new FakeCassandraClient();
      // The seed list and the keyspace are leaves too, and both ship as the
      // "not set" placeholder, so the block has to supply them for the store to
      // be usable at all.
      const reach = ['contact-points = ["fake"]', 'keyspace = "hocon_keyspace"'].join('\n');
      return {
        hocon: [
          axis(JOURNAL_PLUGIN_KEY, CASSANDRA_JOURNAL_PLUGIN_ID, [
            reach,
            `events-table = "${HOCON_EVENTS}"`,
            `metadata-table = "${HOCON_JOURNAL_SIBLING}"`,
          ].join('\n')),
          axis(SNAPSHOT_PLUGIN_KEY, CASSANDRA_SNAPSHOT_PLUGIN_ID, [
            reach,
            `snapshots-table = "${HOCON_SNAPSHOTS}"`,
          ].join('\n')),
        ].join('\n'),
        register: (persistence, eventsInCode) => registerCassandraPlugins(persistence, {
          client,
          journal: eventsInCode === undefined ? undefined : { eventsTable: eventsInCode },
        }),
        transcript: async () => client.log,
      };
    },
  },
  {
    name: 'sqlite',
    hasDurableStateStore: true,
    // The tags table is derived from `events-table`, so the journal's block has
    // no second container of its own to fall through on.
    journalHasSiblingContainer: false,
    builtInContainers: RELATIONAL_BUILT_IN,
    arm: () => {
      // The one backend that runs against a real database in-process, so its
      // transcript is the file itself rather than a fake's log.  A fresh file
      // per arm: two arms sharing one would let the first test's tables satisfy
      // the second test's assertions.
      const file = temporaryDatabase();
      const at = (leaf: string): string => `path = ${JSON.stringify(file)}\n${leaf}`;
      return {
        hocon: [
          axis(JOURNAL_PLUGIN_KEY, SQLITE_JOURNAL_PLUGIN_ID, at(`events-table = "${HOCON_EVENTS}"`)),
          axis(SNAPSHOT_PLUGIN_KEY, SQLITE_SNAPSHOT_PLUGIN_ID, at(`snapshots-table = "${HOCON_SNAPSHOTS}"`)),
          axis(DURABLE_STATE_PLUGIN_KEY, SQLITE_DURABLE_STATE_PLUGIN_ID, at(`table = "${HOCON_STATE}"`)),
        ].join('\n'),
        register: (persistence, eventsInCode) => registerSqlitePlugins(persistence, {
          journal: eventsInCode === undefined ? undefined : { eventsTable: eventsInCode },
        }),
        transcript: () => tablesOf(file),
      };
    },
  },
];

function systemWith(name: string, hocon: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(Config.parseString(hocon));
  return ActorSystem.create(`plugin-binding-${name}`, options);
}

/** One write through each axis the backend offers — enough to address every container. */
async function exercise(persistence: PersistenceExtension, hasDurableStateStore: boolean): Promise<void> {
  await persistence.journal.append('binding-1', [{ event: { n: 1 } }], 0);
  await persistence.snapshotStore.save('binding-1', 1, { n: 1 });
  if (hasDurableStateStore) await persistence.durableStateStore.upsert('binding-1', 0, { n: 1 });
}

for (const backend of BACKENDS) {
  describe(`${backend.name} — the plug-in's HOCON block reaches its stores (#872)`, () => {
    test('a container named only in the block is the one the store addresses', async () => {
      const arm = backend.arm();
      const system = systemWith(backend.name, arm.hocon);
      const persistence = system.extension(PersistenceExtensionId);
      arm.register(persistence);
      await exercise(persistence, backend.hasDurableStateStore);
      await system.terminate();

      const transcript = await arm.transcript();
      expect(mentions(transcript, HOCON_EVENTS)).toBe(true);
      expect(mentions(transcript, HOCON_SNAPSHOTS)).toBe(true);
      if (backend.hasDurableStateStore) expect(mentions(transcript, HOCON_STATE)).toBe(true);
      if (backend.journalHasSiblingContainer) {
        expect(mentions(transcript, HOCON_JOURNAL_SIBLING)).toBe(true);
      }
      // The load-bearing half: a block that is merely published rather than
      // read would leave every store on its built-in container, and every
      // assertion above would still be about a store that works.
      expect(backend.builtInContainers.filter((c) => mentions(transcript, c))).toEqual([]);
    });

    test('an explicit option beats the block per field, and an unset field falls through', async () => {
      const arm = backend.arm();
      const system = systemWith(backend.name, arm.hocon);
      const persistence = system.extension(PersistenceExtensionId);
      arm.register(persistence, CODE_EVENTS);
      await exercise(persistence, backend.hasDurableStateStore);
      await system.terminate();

      const transcript = await arm.transcript();
      expect(mentions(transcript, CODE_EVENTS)).toBe(true);
      expect(mentions(transcript, HOCON_EVENTS)).toBe(false);
      // Named nowhere in code, so the block still applies rather than being
      // shadowed by the `undefined` a partial options object carries.
      expect(mentions(transcript, HOCON_SNAPSHOTS)).toBe(true);
      if (backend.hasDurableStateStore) expect(mentions(transcript, HOCON_STATE)).toBe(true);
      if (backend.journalHasSiblingContainer) {
        expect(mentions(transcript, HOCON_JOURNAL_SIBLING)).toBe(true);
      }
      expect(backend.builtInContainers.filter((c) => mentions(transcript, c))).toEqual([]);
    });
  });
}
