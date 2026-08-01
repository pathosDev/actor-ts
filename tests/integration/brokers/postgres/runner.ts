/**
 * PostgreSQL live-integration runner (#323).
 *
 * Boots against the postgres:latest container, waits for the port, then
 * runs the shared SQL persistence contract (journal + snapshot +
 * durable-state) against the real `PostgresJournal` /
 * `PostgresSnapshotStore` / `PostgresDurableStateStore` via the `pg`
 * driver.  Exit 0 / 1 like the other broker runners.
 */
import { PostgresJournal } from '../../../../src/persistence/journals/PostgresJournal.js';
import { PostgresJournalOptions } from '../../../../src/persistence/journals/PostgresJournalOptions.js';
import { PostgresSnapshotStore } from '../../../../src/persistence/snapshot-stores/PostgresSnapshotStore.js';
import { PostgresSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/PostgresSnapshotStoreOptions.js';
import { PostgresDurableStateStore } from '../../../../src/persistence/durable-state-stores/PostgresDurableStateStore.js';
import { PostgresDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/PostgresDurableStateStoreOptions.js';
import { waitForPort } from '../lib/wait-for-port.js';
import { runScenarios } from '../lib/scenario.js';
import { sqlPersistenceScenarios, type SqlPersistenceContext } from '../lib/persistence-contract.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  const url = requireEnv('PG_URL');
  const parsedUrl = new URL(url);
  await waitForPort(parsedUrl.hostname, Number(parsedUrl.port || '5432'), {
    description: 'PostgreSQL',
    deadlineMs: 60_000,
  });

  // Factories, not instances: every contract scenario builds its own store so
  // the scenarios stay independent (and identical to the in-process suite,
  // where each one gets a fresh fake pool).
  const context: SqlPersistenceContext = {
    env: process.env,
    label: 'pg',
    async makeJournal() {
      const journalOptions = PostgresJournalOptions.create()
        .withUrl(url);
      return new PostgresJournal(journalOptions);
    },
    async makeSnapshotStore(keepN) {
      const snapshotStoreOptions = PostgresSnapshotStoreOptions.create()
        .withUrl(url)
        .withKeepN(keepN ?? 2);
      return new PostgresSnapshotStore(snapshotStoreOptions);
    },
    async makeDurableStateStore() {
      const durableStateOptions = PostgresDurableStateStoreOptions.create()
        .withUrl(url);
      return new PostgresDurableStateStore(durableStateOptions);
    },
  };

  await runScenarios(sqlPersistenceScenarios(), context);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
