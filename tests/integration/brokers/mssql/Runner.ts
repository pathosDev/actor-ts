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
import { MsSqlJournal } from '../../../../src/persistence/journals/MsSqlJournal.js';
import { MsSqlJournalOptions } from '../../../../src/persistence/journals/MsSqlJournalOptions.js';
import { MsSqlSnapshotStore } from '../../../../src/persistence/snapshot-stores/MsSqlSnapshotStore.js';
import { MsSqlSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/MsSqlSnapshotStoreOptions.js';
import { waitForPort } from '../lib/WaitForPort.js';
import { runScenarios } from '../lib/Scenario.js';
import { sqlPersistenceScenarios, type SqlPersistenceContext } from '../lib/PersistenceContract.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
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

  await runScenarios(sqlPersistenceScenarios(), context);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
