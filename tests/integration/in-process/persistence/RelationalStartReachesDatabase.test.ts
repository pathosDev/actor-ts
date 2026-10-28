import { describe, expect, test } from 'bun:test';
import {
  D1DurableStateStore,
  D1DurableStateStoreOptions,
  D1Journal,
  D1JournalOptions,
  D1SnapshotStore,
  D1SnapshotStoreOptions,
  JournalError,
  LibSqlDurableStateStore,
  LibSqlDurableStateStoreOptions,
  LibSqlJournal,
  LibSqlJournalOptions,
  LibSqlSnapshotStore,
  LibSqlSnapshotStoreOptions,
  MariaDbDurableStateStore,
  MariaDbDurableStateStoreOptions,
  MariaDbJournal,
  MariaDbJournalOptions,
  MariaDbSnapshotStore,
  MariaDbSnapshotStoreOptions,
  MsSqlDurableStateStore,
  MsSqlDurableStateStoreOptions,
  MsSqlJournal,
  MsSqlJournalOptions,
  MsSqlSnapshotStore,
  MsSqlSnapshotStoreOptions,
  PostgresDurableStateStore,
  PostgresDurableStateStoreOptions,
  PostgresJournal,
  PostgresJournalOptions,
  PostgresSnapshotStore,
  PostgresSnapshotStoreOptions,
  RelationalJournal,
  SqliteDurableStateStore,
  SqliteDurableStateStoreOptions,
  getSqliteDriver,
  postgresDialect,
  sqliteDialect,
  type SqlDialect,
  type SqlExecutor,
  type SqlPool,
  type SqlResult,
} from '../../../../src/persistence/index.js';
import type { D1ClientLike, D1QueryResult } from '../../../../src/persistence/journals/D1Client.js';
import type {
  LibSqlClientLike,
  LibSqlResultSet,
  LibSqlStatement,
  LibSqlTransactionLike,
} from '../../../../src/persistence/journals/LibSqlClient.js';
import type {
  MariaDbConnectionLike,
  MariaDbPoolLike,
  MariaDbResult,
} from '../../../../src/persistence/journals/MariaDbClient.js';
import type {
  MsSqlPoolLike,
  MsSqlRequestLike,
  MsSqlResult,
  MsSqlTransactionLike,
} from '../../../../src/persistence/journals/MsSqlClient.js';
import type { PgClientLike, PgPoolLike, PgQueryResult } from '../../../../src/persistence/journals/PostgresClient.js';
import type { SqliteDb, SqliteStatement } from '../../../../src/runtime/sqlite/SqliteDriver.js';

/**
 * A relational store's open reaches its database whatever `autoCreateTables`
 * says (#1473).
 *
 * `start()` exists so that a database the node cannot reach fails the startup
 * rather than the first persisted message.  With `autoCreateTables` off — an
 * operator-managed schema, the setup the Postgres page recommends to a role
 * without DDL rights — the open used to send nothing at all: node-postgres and
 * libSQL build their pool or client without connecting, and the collation
 * probe MariaDB and SQL Server run swallows its own failures by design.  So a
 * store over a database that refused every connection started cleanly and
 * failed at its first operation, the late failure `start()` was added to
 * remove.  The open now sends a ping when no DDL ran, and its failure
 * propagates, naming the store.
 *
 * Every backend here records the statements it was sent, so the cases can say
 * what an open cost as well as how it ended: one ping, before anything else,
 * once per open and never per operation — and no ping at all when the DDL
 * already made the round trip.
 */

const REFUSED = 'connect ECONNREFUSED 10.255.255.1:5432';

/**
 * What every store below sends as its ping: none of the in-repo dialects
 * defines `pingSql`, so all of them take the relational stores' default.
 */
const DEFAULT_PING = 'SELECT 1';

/** Every statement a backend was sent, in order — refused ones included. */
type RecordingBackend = {
  readonly statements: ReadonlyArray<string>;
};

/** What the start cases call on a store, whichever contract it implements. */
type OpenableStore = {
  start(): Promise<void>;
  close(): Promise<void>;
};

/** One store over one fresh backend, and a first operation to run through it. */
type OpenedStore = {
  readonly backend: RecordingBackend;
  readonly store: OpenableStore;
  readonly operate: () => Promise<unknown>;
  /** Release what the case opened beside the store — a handle the store does not own. */
  readonly dispose?: () => void;
};

type StoreCase = {
  readonly label: string;
  /** `refusal` set: the backend throws it from every statement and every connection checkout. */
  readonly open: (refusal: Error | null, autoCreateTables: boolean) => OpenedStore;
};

/* -------------------------------- backends --------------------------------- */

class RecordingPgPool implements PgPoolLike {
  readonly statements: string[] = [];

  constructor(private readonly refusal: Error | null) {}

  async query(text: string): Promise<PgQueryResult> {
    this.statements.push(text);
    if (this.refusal !== null) throw this.refusal;
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<PgClientLike> {
    if (this.refusal !== null) throw this.refusal;
    return { query: (text) => this.query(text), release: () => undefined };
  }

  async end(): Promise<void> {}
}

class RecordingMariaDbPool implements MariaDbPoolLike {
  readonly statements: string[] = [];

  constructor(private readonly refusal: Error | null) {}

  async query(sql: string): Promise<MariaDbResult> {
    this.statements.push(sql);
    if (this.refusal !== null) throw this.refusal;
    return [];
  }

  async getConnection(): Promise<MariaDbConnectionLike> {
    if (this.refusal !== null) throw this.refusal;
    return {
      query: (sql) => this.query(sql),
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    };
  }

  async end(): Promise<void> {}
}

class RecordingMsSqlPool implements MsSqlPoolLike {
  readonly statements: string[] = [];

  constructor(private readonly refusal: Error | null) {}

  request(): MsSqlRequestLike {
    return {
      input: () => undefined,
      query: async (sql: string): Promise<MsSqlResult> => {
        this.statements.push(sql);
        if (this.refusal !== null) throw this.refusal;
        return { recordset: [], rowsAffected: [0] };
      },
    };
  }

  transaction(): MsSqlTransactionLike {
    return {
      begin: async () => {
        if (this.refusal !== null) throw this.refusal;
      },
      commit: async () => undefined,
      rollback: async () => undefined,
      request: () => this.request(),
    };
  }

  async close(): Promise<void> {}
}

class RecordingLibSqlClient implements LibSqlClientLike {
  readonly statements: string[] = [];

  constructor(private readonly refusal: Error | null) {}

  async execute(statement: LibSqlStatement): Promise<LibSqlResultSet> {
    this.statements.push(statement.sql);
    if (this.refusal !== null) throw this.refusal;
    return { rows: [], rowsAffected: 0 };
  }

  async transaction(): Promise<LibSqlTransactionLike> {
    if (this.refusal !== null) throw this.refusal;
    return {
      execute: (statement) => this.execute(statement),
      commit: async () => undefined,
      rollback: async () => undefined,
      close: () => undefined,
    };
  }

  close(): void {}
}

class RecordingD1Client implements D1ClientLike {
  readonly statements: string[] = [];

  constructor(private readonly refusal: Error | null) {}

  async query(sql: string): Promise<D1QueryResult> {
    this.statements.push(sql);
    if (this.refusal !== null) throw this.refusal;
    return { rows: [], changes: 0 };
  }

  async close(): Promise<void> {}
}

/**
 * A SQLite handle that records every statement it prepares or executes.  With
 * no refusal it runs them on a real in-memory database, so a ping the engine
 * does not accept fails here, not in production.
 */
class RecordingSqliteDb implements SqliteDb {
  readonly statements: string[] = [];

  constructor(private readonly refusal: Error | null, private readonly database: SqliteDb) {}

  exec(sql: string): void {
    this.statements.push(sql);
    if (this.refusal !== null) throw this.refusal;
    this.database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    this.statements.push(sql);
    if (this.refusal !== null) throw this.refusal;
    return this.database.prepare(sql);
  }

  transaction<F extends (...args: never[]) => unknown>(body: F): F {
    return this.database.transaction(body);
  }

  close(): void {
    this.database.close();
  }
}

/* ------------------------------- store cases ------------------------------- */

const sqliteDriver = await getSqliteDriver();
const SQLITE_DURABLE_STATE_TABLE = 'durable_state';

const storeCases: StoreCase[] = [
  {
    label: 'PostgresJournal',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingPgPool(refusal);
      const journalOptions = PostgresJournalOptions.create()
        .withPool(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new PostgresJournal(journalOptions);
      return { backend, store, operate: () => store.highestSeq('p-1') };
    },
  },
  {
    label: 'PostgresSnapshotStore',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingPgPool(refusal);
      const snapshotStoreOptions = PostgresSnapshotStoreOptions.create()
        .withPool(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new PostgresSnapshotStore(snapshotStoreOptions);
      return { backend, store, operate: () => store.loadLatest('p-1') };
    },
  },
  {
    label: 'PostgresDurableStateStore',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingPgPool(refusal);
      const durableStateStoreOptions = PostgresDurableStateStoreOptions.create()
        .withPool(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new PostgresDurableStateStore(durableStateStoreOptions);
      return { backend, store, operate: () => store.load('p-1') };
    },
  },
  {
    label: 'MariaDbJournal',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingMariaDbPool(refusal);
      const journalOptions = MariaDbJournalOptions.create()
        .withPool(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new MariaDbJournal(journalOptions);
      return { backend, store, operate: () => store.highestSeq('p-1') };
    },
  },
  {
    label: 'MariaDbSnapshotStore',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingMariaDbPool(refusal);
      const snapshotStoreOptions = MariaDbSnapshotStoreOptions.create()
        .withPool(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new MariaDbSnapshotStore(snapshotStoreOptions);
      return { backend, store, operate: () => store.loadLatest('p-1') };
    },
  },
  {
    label: 'MariaDbDurableStateStore',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingMariaDbPool(refusal);
      const durableStateStoreOptions = MariaDbDurableStateStoreOptions.create()
        .withPool(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new MariaDbDurableStateStore(durableStateStoreOptions);
      return { backend, store, operate: () => store.load('p-1') };
    },
  },
  {
    label: 'MsSqlJournal',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingMsSqlPool(refusal);
      const journalOptions = MsSqlJournalOptions.create()
        .withPool(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new MsSqlJournal(journalOptions);
      return { backend, store, operate: () => store.highestSeq('p-1') };
    },
  },
  {
    label: 'MsSqlSnapshotStore',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingMsSqlPool(refusal);
      const snapshotStoreOptions = MsSqlSnapshotStoreOptions.create()
        .withPool(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new MsSqlSnapshotStore(snapshotStoreOptions);
      return { backend, store, operate: () => store.loadLatest('p-1') };
    },
  },
  {
    label: 'MsSqlDurableStateStore',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingMsSqlPool(refusal);
      const durableStateStoreOptions = MsSqlDurableStateStoreOptions.create()
        .withPool(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new MsSqlDurableStateStore(durableStateStoreOptions);
      return { backend, store, operate: () => store.load('p-1') };
    },
  },
  {
    label: 'LibSqlJournal',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingLibSqlClient(refusal);
      const journalOptions = LibSqlJournalOptions.create()
        .withClient(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new LibSqlJournal(journalOptions);
      return { backend, store, operate: () => store.highestSeq('p-1') };
    },
  },
  {
    label: 'LibSqlSnapshotStore',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingLibSqlClient(refusal);
      const snapshotStoreOptions = LibSqlSnapshotStoreOptions.create()
        .withClient(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new LibSqlSnapshotStore(snapshotStoreOptions);
      return { backend, store, operate: () => store.loadLatest('p-1') };
    },
  },
  {
    label: 'LibSqlDurableStateStore',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingLibSqlClient(refusal);
      const durableStateStoreOptions = LibSqlDurableStateStoreOptions.create()
        .withClient(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new LibSqlDurableStateStore(durableStateStoreOptions);
      return { backend, store, operate: () => store.load('p-1') };
    },
  },
  {
    label: 'D1Journal',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingD1Client(refusal);
      const journalOptions = D1JournalOptions.create()
        .withClient(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new D1Journal(journalOptions);
      return { backend, store, operate: () => store.highestSeq('p-1') };
    },
  },
  {
    label: 'D1SnapshotStore',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingD1Client(refusal);
      const snapshotStoreOptions = D1SnapshotStoreOptions.create()
        .withClient(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new D1SnapshotStore(snapshotStoreOptions);
      return { backend, store, operate: () => store.loadLatest('p-1') };
    },
  },
  {
    label: 'D1DurableStateStore',
    open: (refusal, autoCreateTables) => {
      const backend = new RecordingD1Client(refusal);
      const durableStateStoreOptions = D1DurableStateStoreOptions.create()
        .withClient(backend)
        .withAutoCreateTables(autoCreateTables);
      const store = new D1DurableStateStore(durableStateStoreOptions);
      return { backend, store, operate: () => store.load('p-1') };
    },
  },
  {
    label: 'SqliteDurableStateStore',
    open: (refusal, autoCreateTables) => {
      const database = sqliteDriver.open(':memory:');
      // The schema an operator manages when autoCreateTables is off, created
      // beside the store rather than through it, as an operator would.
      for (const statement of sqliteDialect.durableStateDdl(SQLITE_DURABLE_STATE_TABLE)) database.exec(statement);
      const backend = new RecordingSqliteDb(refusal, database);
      const durableStateStoreOptions = SqliteDurableStateStoreOptions.create()
        .withDatabase(backend)
        .withTable(SQLITE_DURABLE_STATE_TABLE)
        .withAutoCreateTables(autoCreateTables);
      const store = new SqliteDurableStateStore(durableStateStoreOptions);
      // An injected handle stays the caller's, so the store's close() leaves it open.
      return { backend, store, operate: () => store.load('p-1'), dispose: () => database.close() };
    },
  },
];

/** The rejection a promise settled with, or `null` when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e as Error;
  }
}

function countOf(statements: ReadonlyArray<string>, statement: string): number {
  return statements.filter((candidate) => candidate === statement).length;
}

/** Open one case, run `body` against it, and release everything it opened, whatever `body` did. */
async function withOpened(opened: OpenedStore, body: (opened: OpenedStore) => Promise<void>): Promise<void> {
  try {
    await body(opened);
  } finally {
    await opened.store.close();
    opened.dispose?.();
  }
}

describe('a relational store reaches its database on open, whatever autoCreateTables says (#1473)', () => {
  test.each(storeCases)(
    '$label: with autoCreateTables off, start() over a database that refuses every connection rejects, naming the store',
    async ({ label, open }) => {
      const refusal = new Error(REFUSED);
      await withOpened(open(refusal, false), async ({ backend, store }) => {
        const error = await rejectionOf(store.start());

        expect(error?.message ?? 'resolved').toBe(`${label}.open failed: ${REFUSED}`);
        expect(error).toBeInstanceOf(JournalError);
        expect((error as JournalError).cause).toBe(refusal);
        // One statement was attempted, and it was the ping — the collation
        // probe, which would have swallowed this refusal, never ran.
        expect(backend.statements).toEqual([DEFAULT_PING]);
      });
    },
  );

  test.each(storeCases)(
    '$label: with autoCreateTables off, the open costs one ping, and neither a second start() nor an operation repeats it',
    async ({ open }) => {
      await withOpened(open(null, false), async ({ backend, store, operate }) => {
        await store.start();
        expect(backend.statements[0]).toBe(DEFAULT_PING);
        expect(countOf(backend.statements, DEFAULT_PING)).toBe(1);

        const afterOpen = backend.statements.length;
        await store.start();
        expect(backend.statements.length).toBe(afterOpen);

        await operate();
        // The operation reached the backend, so "no further ping" is measured
        // against real traffic rather than against silence.
        expect(backend.statements.length).toBeGreaterThan(afterOpen);
        expect(countOf(backend.statements, DEFAULT_PING)).toBe(1);
      });
    },
  );

  test.each(storeCases)(
    '$label: with autoCreateTables on, the DDL is the round trip and no ping is sent',
    async ({ open }) => {
      await withOpened(open(null, true), async ({ backend, store }) => {
        await store.start();
        expect(backend.statements.length).toBeGreaterThan(0);
        expect(backend.statements).not.toContain(DEFAULT_PING);
      });
    },
  );

  test.each(storeCases)(
    '$label: with autoCreateTables on, start() over a database that refuses every connection rejects too',
    async ({ open }) => {
      const refusal = new Error(REFUSED);
      await withOpened(open(refusal, true), async ({ store }) => {
        const error = await rejectionOf(store.start());
        expect(error?.message ?? 'resolved').toContain(REFUSED);
      });
    },
  );
});

/**
 * A `SqlPool` below any driver, for a dialect that is not one of the in-repo
 * four: it records every statement and answers with no rows, or refuses every
 * statement and every transaction.
 */
class RecordingSqlPool implements SqlPool {
  readonly statements: string[] = [];

  constructor(private readonly refusal: Error | null) {}

  async query(sql: string): Promise<SqlResult> {
    this.statements.push(sql);
    if (this.refusal !== null) throw this.refusal;
    return { rows: [], affectedRows: 0 };
  }

  async withTransaction<T>(body: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.refusal !== null) throw this.refusal;
    return body(this);
  }

  async end(): Promise<void> {}
}

/** A journal over `pool` with an operator-managed schema, so its open runs no DDL. */
function operatorManagedJournal(pool: RecordingSqlPool, dialect: SqlDialect): RelationalJournal {
  return new RelationalJournal({
    storeName: 'OutOfTreeJournal',
    dialect,
    ownsPool: false,
    autoCreateTables: false,
    openPool: async () => pool,
  });
}

describe('a dialect written outside the repository and its ping (#1473)', () => {
  // A dialect that never heard of `pingSql` — one written before it existed.
  const dialectWithoutPing: SqlDialect = { ...postgresDialect, pingSql: undefined };

  test('a dialect that does not define pingSql still has its store send SELECT 1 when it opens', async () => {
    const pool = new RecordingSqlPool(null);
    const journal = operatorManagedJournal(pool, dialectWithoutPing);
    try {
      await journal.start();
      expect(pool.statements).toEqual(['SELECT 1']);
    } finally {
      await journal.close();
    }
  });

  test('a dialect that does not define pingSql fails the open over a database that refuses every connection', async () => {
    const refusal = new Error(REFUSED);
    const pool = new RecordingSqlPool(refusal);
    const journal = operatorManagedJournal(pool, dialectWithoutPing);
    try {
      const error = await rejectionOf(journal.start());
      expect(error?.message ?? 'resolved').toBe(`OutOfTreeJournal.open failed: ${REFUSED}`);
      expect((error as JournalError).cause).toBe(refusal);
      expect(pool.statements).toEqual(['SELECT 1']);
    } finally {
      await journal.close();
    }
  });

  test('a dialect that defines pingSql has its store send that statement instead', async () => {
    const pool = new RecordingSqlPool(null);
    const dialectWithDual: SqlDialect = { ...postgresDialect, pingSql: () => 'SELECT 1 FROM DUAL' };
    const journal = operatorManagedJournal(pool, dialectWithDual);
    try {
      await journal.start();
      expect(pool.statements).toEqual(['SELECT 1 FROM DUAL']);
    } finally {
      await journal.close();
    }
  });
});
