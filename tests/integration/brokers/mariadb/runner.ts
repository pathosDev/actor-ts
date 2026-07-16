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
import { MariaDbSnapshotStore } from '../../../../src/persistence/snapshot-stores/MariaDbSnapshotStore.js';
import { MariaDbSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/MariaDbSnapshotStoreOptions.js';
import { MariaDbDurableStateStore } from '../../../../src/persistence/durable-state-stores/MariaDbDurableStateStore.js';
import { MariaDbDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/MariaDbDurableStateStoreOptions.js';
import { waitForPort } from '../lib/wait-for-port.js';
import { runScenarios } from '../lib/scenario.js';
import { sqlPersistenceScenarios, type SqlPersistenceContext } from '../lib/persistence-contract.js';

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

  const journalOptions = MariaDbJournalOptions.create()
    .withPoolConfig(poolConfig);
  const snapshotStoreOptions = MariaDbSnapshotStoreOptions.create()
    .withPoolConfig(poolConfig)
    .withKeepN(2);
  const durableStateOptions = MariaDbDurableStateStoreOptions.create()
    .withPoolConfig(poolConfig);
  const ctx: SqlPersistenceContext = {
    env: process.env,
    label: 'mariadb',
    journal: new MariaDbJournal(journalOptions),
    snapshotStore: new MariaDbSnapshotStore(snapshotStoreOptions),
    durableState: new MariaDbDurableStateStore(durableStateOptions),
  };

  await runScenarios(sqlPersistenceScenarios(), ctx);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
