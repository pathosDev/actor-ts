/**
 * MariaDB live-integration runner (#324).
 *
 * Boots against the mariadb:latest container, waits for the port, then
 * runs the shared SQL persistence contract (journal + snapshot +
 * durable-state) against the real `MariaDbJournal` /
 * `MariaDbSnapshotStore` / `MariaDbDurableStateStore` via the `mariadb`
 * connector.  Discrete pool config (host/port/user/password/database)
 * rather than a URL — bulletproof across connector versions.
 */
import { MariaDbJournal } from '../../../../src/persistence/journals/MariaDbJournal.js';
import { MariaDbJournalOptions } from '../../../../src/persistence/journals/MariaDbJournalOptions.js';
import { MariaDbQuery } from '../../../../src/persistence/query/MariaDbQuery.js';
import { MariaDbSnapshotStore } from '../../../../src/persistence/snapshot-stores/MariaDbSnapshotStore.js';
import { MariaDbSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/MariaDbSnapshotStoreOptions.js';
import { MariaDbDurableStateStore } from '../../../../src/persistence/durable-state-stores/MariaDbDurableStateStore.js';
import { MariaDbDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/MariaDbDurableStateStoreOptions.js';
import { waitForPort } from '../lib/WaitForPort.js';
import { runScenarios } from '../lib/Scenario.js';
import { sqlPersistenceScenarios, type SqlPersistenceContext } from '../lib/PersistenceContract.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
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

  await runScenarios(sqlPersistenceScenarios(), context);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
