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
import { PostgresSnapshotStore } from '../../../../src/persistence/snapshot-stores/PostgresSnapshotStore.js';
import { PostgresDurableStateStore } from '../../../../src/persistence/durable-state-stores/PostgresDurableStateStore.js';
import { waitForPort } from '../lib/wait-for-port.js';
import { runScenarios } from '../lib/scenario.js';
import { sqlPersistenceScenarios, type SqlPersistenceCtx } from '../lib/persistence-contract.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`runner: missing env var ${name}`);
  return v;
}

async function main(): Promise<void> {
  const url = requireEnv('PG_URL');
  const u = new URL(url);
  await waitForPort(u.hostname, Number(u.port || '5432'), {
    description: 'PostgreSQL',
    deadlineMs: 60_000,
  });

  const ctx: SqlPersistenceCtx = {
    env: process.env,
    label: 'pg',
    journal: new PostgresJournal({ url }),
    snapshotStore: new PostgresSnapshotStore({ url, keepN: 2 }),
    durableState: new PostgresDurableStateStore({ url }),
  };

  await runScenarios(sqlPersistenceScenarios(), ctx);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
