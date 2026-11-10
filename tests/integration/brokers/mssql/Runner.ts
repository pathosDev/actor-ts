/**
 * Microsoft SQL Server live-integration runner (#399).
 *
 * Boots against the SQL Server container, waits for the port, then runs the
 * shared persistence contract (journal + snapshot + durable-state) against the
 * real `MsSqlJournal` / `MsSqlSnapshotStore` / `MsSqlDurableStateStore` via the
 * `mssql` (tedious) driver.  Exit 0 / 1 like the other broker runners.
 *
 * This is the suite that verifies what a fake cannot: that SQL Server actually
 * accepts the T-SQL the dialect emits — the guarded DDL, both `MERGE`
 * statements, `TOP (@p2)` inside the prune subquery, `OFFSET/FETCH` row
 * limiting, and the 1700-byte nonclustered key on the tags table — and that its
 * own error 2627 feeds the concurrency backstop.
 */
import { MsSqlDurableStateStore } from '../../../../src/persistence/durable-state-stores/MsSqlDurableStateStore.js';
import { MsSqlDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/MsSqlDurableStateStoreOptions.js';
import { buildMsSqlPool, type MsSqlPoolLike } from '../../../../src/persistence/journals/MsSqlClient.js';
import { MsSqlJournal } from '../../../../src/persistence/journals/MsSqlJournal.js';
import { MsSqlJournalOptions } from '../../../../src/persistence/journals/MsSqlJournalOptions.js';
import { MsSqlSnapshotStore } from '../../../../src/persistence/snapshot-stores/MsSqlSnapshotStore.js';
import { MsSqlSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/MsSqlSnapshotStoreOptions.js';
import { waitForPort } from '../lib/WaitForPort.js';
import { runScenarios, type BrokerScenario } from '../lib/Scenario.js';
import { sqlPersistenceScenarios, type SqlPersistenceContext } from '../lib/PersistenceContract.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

/* ------------------- the startup collation advisory (#1412) ---------------- */

/**
 * Unique per process, so a re-run without `docker compose down -v` does not
 * collide with the tables the previous run left behind.
 */
const collationRunId = Date.now().toString(36);

/** The three tables one journal owns, under a name this run owns. */
function journalTables(label: string): { events: string; tags: string; meta: string } {
  const events = `collation_${label}_${collationRunId}`;
  return { events, tags: `${events}_tags`, meta: `${events}_meta` };
}

/**
 * Swap `console.warn` for the duration of one call and hand back what it saw.
 * The advisory has no `ActorSystem` to log through — an operator-built store
 * holds none — so the console is the observable here exactly as it is in
 * `CachedSnapshotStore.test.ts`.
 */
async function captureWarnings(body: () => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => { captured.push(String(args[0])); };
  try { await body(); } finally { console.warn = original; }
  return captured;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * What the fake pools cannot show (#1412).
 *
 * `tests/unit/persistence/CollationAdvisory.test.ts` pins the statement text,
 * the classification and the message; the in-process fakes replay a recorded
 * catalogue.  Only a live instance can show that SQL Server *accepts*
 * `SELECT c.name, c.collation_name FROM sys.columns c WHERE c.object_id =
 * OBJECT_ID(@p1)` — with the table name arriving through `request.input`
 * rather than spliced into the text — and that it labels the rows as the
 * aliases ask.  On the silent side it shows the instance really did honour the
 * `COLLATE Latin1_General_100_BIN2` in the dialect's DDL.
 *
 * Two scenarios, one per direction.  The folding one spells the collation out
 * instead of leaving the columns on the instance default: a stock instance
 * defaults to `SQL_Latin1_General_CP1_CI_AS`, but the image's `MSSQL_COLLATION`
 * could change that, and a scenario that quietly stopped testing anything
 * would be worse than one that is explicit about the state it creates.
 * `events_meta` is left bare on purpose, so the instance default is exercised
 * too — it is logged rather than asserted for the same reason.
 */
function collationAdvisoryScenarios(
  poolConfig: Record<string, unknown>,
): ReadonlyArray<BrokerScenario<SqlPersistenceContext>> {
  const openJournal = (events: string): MsSqlJournal => {
    const journalOptions = MsSqlJournalOptions.create()
      .withPoolConfig(poolConfig)
      .withEventsTable(events);
    return new MsSqlJournal(journalOptions);
  };

  return [
    {
      name: 'mssql:collation — a pre-#707 schema is named at store open',
      async run() {
        const tables = journalTables('folding');
        const rawPool = await buildMsSqlPool({ poolConfig });
        try {
          // The DDL this project shipped before #707: same shape, no BIN2.
          // `[timestamp]` stays bracketed — bare, T-SQL reads it as the
          // deprecated type alias.
          await execute(rawPool, `IF OBJECT_ID(N'[${tables.events}]', N'U') IS NULL
                 CREATE TABLE [${tables.events}] (
                   [persistence_id] NVARCHAR(255) COLLATE SQL_Latin1_General_CP1_CI_AS NOT NULL,
                   [sequence_nr]    BIGINT NOT NULL,
                   [payload]        NVARCHAR(MAX) NOT NULL,
                   [tags]           NVARCHAR(MAX) NULL,
                   [timestamp]      BIGINT NOT NULL,
                   CONSTRAINT [PK_${tables.events}] PRIMARY KEY ([persistence_id], [sequence_nr])
                 )`);
          await execute(rawPool, `IF OBJECT_ID(N'[${tables.tags}]', N'U') IS NULL
                 CREATE TABLE [${tables.tags}] (
                   [persistence_id] NVARCHAR(255) COLLATE SQL_Latin1_General_CP1_CI_AS NOT NULL,
                   [sequence_nr]    BIGINT NOT NULL,
                   [tag]            NVARCHAR(255) COLLATE SQL_Latin1_General_CP1_CI_AS NOT NULL,
                   [timestamp]      BIGINT NOT NULL
                 )`);
          await execute(rawPool, `IF OBJECT_ID(N'[${tables.meta}]', N'U') IS NULL
                 CREATE TABLE [${tables.meta}] (
                   [persistence_id] NVARCHAR(255) NOT NULL,
                   [deleted_to]     BIGINT NOT NULL,
                   CONSTRAINT [PK_${tables.meta}] PRIMARY KEY ([persistence_id])
                 )`);

          const journal = openJournal(tables.events);
          try {
            const warnings = await captureWarnings(async () => {
              // The store's own guarded `CREATE TABLE` is a no-op on the
              // tables above — which is the defect — and then it probes.
              await journal.highestSeq('collation-probe');
            });
            const advisory = warnings.find((line) => line.includes('on a case-folding collation'));
            assert(advisory !== undefined,
              `expected a collation advisory, saw ${JSON.stringify(warnings)}`);
            for (const named of [
              `${tables.events}.persistence_id (SQL_Latin1_General_CP1_CI_AS)`,
              `${tables.tags}.persistence_id (SQL_Latin1_General_CP1_CI_AS)`,
              `${tables.tags}.tag (SQL_Latin1_General_CP1_CI_AS)`,
            ]) {
              assert(advisory!.includes(named), `advisory does not name ${named}: ${advisory}`);
            }
            console.log(`[scenario] advisory: ${advisory}`);
          } finally {
            await journal.close();
          }
        } finally {
          await dropTables(rawPool, tables);
          await rawPool.close();
        }
      },
    },
    {
      name: 'mssql:collation — a schema this framework created is silent',
      async run() {
        const tables = journalTables('pinned');
        const journal = openJournal(tables.events);
        let warnings: string[] = [];
        try {
          warnings = await captureWarnings(async () => {
            await journal.highestSeq('collation-probe');
          });
        } finally {
          await journal.close();
        }
        assert(warnings.length === 0,
          'the DDL pins Latin1_General_100_BIN2, so a schema it created must not be advised '
          + `about; saw ${JSON.stringify(warnings)}`);

        const rawPool = await buildMsSqlPool({ poolConfig });
        try {
          await dropTables(rawPool, tables);
        } finally {
          await rawPool.close();
        }
      },
    },
  ];
}

/** One statement on a fresh Request — `mssql` rejects reusing one that ran. */
async function execute(pool: MsSqlPoolLike, sql: string): Promise<void> {
  await pool.request().query(sql);
}

/** Best-effort cleanup: the names carry a per-run id, so a leftover is inert. */
async function dropTables(pool: MsSqlPoolLike, tables: Record<string, string>): Promise<void> {
  for (const table of Object.values(tables)) {
    try {
      await execute(pool, `DROP TABLE IF EXISTS [${table}]`);
    } catch (e) {
      console.warn(`[scenario] could not drop ${table}:`, e);
    }
  }
}

async function main(): Promise<void> {
  const host = requireEnv('MSSQL_HOST');
  const port = Number(process.env.MSSQL_PORT ?? '1433');
  await waitForPort(host, port, { description: 'SQL Server', deadlineMs: 120_000 });

  const poolConfig = {
    server: host,
    port,
    user: requireEnv('MSSQL_USER'),
    password: requireEnv('MSSQL_PASSWORD'),
    database: requireEnv('MSSQL_DATABASE'),
    // The container serves a self-signed certificate, so encryption stays on
    // but the chain is not verified — a test-only relaxation.
    options: { encrypt: true, trustServerCertificate: true },
    pool: { max: 5 },
  };

  // Factories, not instances: every contract scenario builds its own store, so
  // the scenarios stay independent and each closes the pool it opened.
  const context: SqlPersistenceContext = {
    env: process.env,
    label: 'mssql',
    async makeJournal() {
      const journalOptions = MsSqlJournalOptions.create()
        .withPoolConfig(poolConfig);
      return new MsSqlJournal(journalOptions);
    },
    async makeSnapshotStore(keepN) {
      const snapshotStoreOptions = MsSqlSnapshotStoreOptions.create()
        .withPoolConfig(poolConfig)
        .withKeepN(keepN ?? 2);
      return new MsSqlSnapshotStore(snapshotStoreOptions);
    },
    async makeDurableStateStore() {
      const durableStateOptions = MsSqlDurableStateStoreOptions.create()
        .withPoolConfig(poolConfig);
      return new MsSqlDurableStateStore(durableStateOptions);
    },
  };

  await runScenarios([...sqlPersistenceScenarios(), ...collationAdvisoryScenarios(poolConfig)], context);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
