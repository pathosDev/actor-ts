/**
 * MariaDB live-integration runner (#324).
 *
 * Boots against the pinned `mariadb` container, waits for the port, then
 * runs the shared SQL persistence contract (journal + snapshot +
 * durable-state) against the real `MariaDbJournal` /
 * `MariaDbSnapshotStore` / `MariaDbDurableStateStore` via the `mariadb`
 * connector.  Discrete pool config (host/port/user/password/database)
 * rather than a URL — bulletproof across connector versions.
 */
import { buildMariaDbPool, type MariaDbPoolLike } from '../../../../src/persistence/journals/MariaDbClient.js';
import { MariaDbJournal } from '../../../../src/persistence/journals/MariaDbJournal.js';
import { MariaDbJournalOptions } from '../../../../src/persistence/journals/MariaDbJournalOptions.js';
import { MariaDbQuery } from '../../../../src/persistence/query/MariaDbQuery.js';
import { MariaDbSnapshotStore } from '../../../../src/persistence/snapshot-stores/MariaDbSnapshotStore.js';
import { MariaDbSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/MariaDbSnapshotStoreOptions.js';
import { MariaDbDurableStateStore } from '../../../../src/persistence/durable-state-stores/MariaDbDurableStateStore.js';
import { MariaDbDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/MariaDbDurableStateStoreOptions.js';
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
 * catalogue.  Only a live server can show that MariaDB *accepts*
 * `SELECT … FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`
 * with the table bound as a parameter, and that it labels the rows
 * `column_name` / `collation_name` as the aliases ask — and, on the silent
 * side, that the server really did honour the `COLLATE utf8mb4_bin` in the
 * dialect's own DDL rather than ignoring the clause.
 *
 * Two scenarios, one per direction.  The folding one spells the collation out
 * instead of leaving the columns on the server default: a stock MariaDB
 * defaults to a `_ci` collation, but an image or a compose flag could change
 * that, and a scenario that quietly stopped testing anything would be worse
 * than one that is explicit about the state it creates.  `events_meta` is
 * left bare on purpose, so the server default is exercised too — it is logged
 * rather than asserted for the same reason.
 */
function collationAdvisoryScenarios(
  poolConfig: Record<string, unknown>,
): ReadonlyArray<BrokerScenario<SqlPersistenceContext>> {
  const openJournal = (events: string): MariaDbJournal => {
    const journalOptions = MariaDbJournalOptions.create()
      .withPoolConfig(poolConfig)
      .withEventsTable(events);
    return new MariaDbJournal(journalOptions);
  };

  return [
    {
      name: 'mariadb:collation — a pre-#707 schema is named at store open',
      async run() {
        const tables = journalTables('folding');
        const rawPool = await buildMariaDbPool({ poolConfig });
        try {
          // The DDL this project shipped before #707: same shape, no COLLATE.
          await rawPool.query(`CREATE TABLE IF NOT EXISTS ${tables.events} (
                 persistence_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
                 sequence_nr    BIGINT NOT NULL,
                 payload        LONGTEXT NOT NULL,
                 tags           TEXT,
                 timestamp      BIGINT NOT NULL,
                 PRIMARY KEY (persistence_id, sequence_nr)
               )`);
          await rawPool.query(`CREATE TABLE IF NOT EXISTS ${tables.tags} (
                 persistence_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
                 sequence_nr    BIGINT NOT NULL,
                 tag            VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
                 timestamp      BIGINT NOT NULL
               )`);
          await rawPool.query(`CREATE TABLE IF NOT EXISTS ${tables.meta} (
                 persistence_id VARCHAR(255) NOT NULL,
                 deleted_to     BIGINT NOT NULL,
                 PRIMARY KEY (persistence_id)
               )`);

          const journal = openJournal(tables.events);
          try {
            const warnings = await captureWarnings(async () => {
              // The store's own `CREATE TABLE IF NOT EXISTS` is a no-op on the
              // tables above — which is the defect — and then it probes.
              await journal.highestSeq('collation-probe');
            });
            const advisory = warnings.find((line) => line.includes('on a case-folding collation'));
            assert(advisory !== undefined,
              `expected a collation advisory, saw ${JSON.stringify(warnings)}`);
            for (const named of [
              `${tables.events}.persistence_id (utf8mb4_general_ci)`,
              `${tables.tags}.persistence_id (utf8mb4_general_ci)`,
              `${tables.tags}.tag (utf8mb4_general_ci)`,
            ]) {
              assert(advisory!.includes(named), `advisory does not name ${named}: ${advisory}`);
            }
            console.log(`[scenario] advisory: ${advisory}`);
          } finally {
            await journal.close();
          }
        } finally {
          await dropTables(rawPool, tables);
          await rawPool.end();
        }
      },
    },
    {
      name: 'mariadb:collation — a schema this framework created is silent',
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
          'the DDL pins utf8mb4_bin, so a schema it created must not be advised about; '
          + `saw ${JSON.stringify(warnings)}`);

        const rawPool = await buildMariaDbPool({ poolConfig });
        try {
          await dropTables(rawPool, tables);
        } finally {
          await rawPool.end();
        }
      },
    },
  ];
}

/** Best-effort cleanup: the names carry a per-run id, so a leftover is inert. */
async function dropTables(pool: MariaDbPoolLike, tables: Record<string, string>): Promise<void> {
  for (const table of Object.values(tables)) {
    try {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    } catch (e) {
      console.warn(`[scenario] could not drop ${table}:`, e);
    }
  }
}

async function main(): Promise<void> {
  const host = requireEnv('MARIADB_HOST');
  const port = Number(process.env.MARIADB_PORT ?? '3306');
  await waitForPort(host, port, { description: 'MariaDB', deadlineMs: 60_000 });

  const poolConfig = {
    host,
    port,
    user: requireEnv('MARIADB_USER'),
    password: requireEnv('MARIADB_PASSWORD'),
    database: requireEnv('MARIADB_DATABASE'),
    connectionLimit: 5,
  };

  // Factories, not instances: every contract scenario builds its own store so
  // the scenarios stay independent (and identical to the in-process suite,
  // where each one gets a fresh fake pool).
  const context: SqlPersistenceContext = {
    env: process.env,
    label: 'mariadb',
    async makeJournal() {
      const journalOptions = MariaDbJournalOptions.create()
        .withPoolConfig(poolConfig);
      return new MariaDbJournal(journalOptions);
    },
    // Where the JOIN meets a real MariaDB — including the collation, which no
    // fake pool can model.  The dialect pins `utf8mb4_bin` on `tag` (#707);
    // that the server actually honoured it, rather than rejecting or ignoring
    // the clause, is something only a live run can show (#391).
    makeQuery: (journal) => new MariaDbQuery(journal as MariaDbJournal),
    async makeSnapshotStore(keepN) {
      const snapshotStoreOptions = MariaDbSnapshotStoreOptions.create()
        .withPoolConfig(poolConfig)
        .withKeepN(keepN ?? 2);
      return new MariaDbSnapshotStore(snapshotStoreOptions);
    },
    async makeDurableStateStore() {
      const durableStateOptions = MariaDbDurableStateStoreOptions.create()
        .withPoolConfig(poolConfig);
      return new MariaDbDurableStateStore(durableStateOptions);
    },
  };

  await runScenarios([...sqlPersistenceScenarios(), ...collationAdvisoryScenarios(poolConfig)], context);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
