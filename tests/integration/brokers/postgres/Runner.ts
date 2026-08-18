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
import { PostgresQuery } from '../../../../src/persistence/query/PostgresQuery.js';
import { PostgresSnapshotStore } from '../../../../src/persistence/snapshot-stores/PostgresSnapshotStore.js';
import { PostgresSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/PostgresSnapshotStoreOptions.js';
import { PostgresDurableStateStore } from '../../../../src/persistence/durable-state-stores/PostgresDurableStateStore.js';
import { PostgresDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/PostgresDurableStateStoreOptions.js';
import { waitForPort } from '../lib/WaitForPort.js';
import { runScenarios } from '../lib/Scenario.js';
import { sqlPersistenceScenarios, type SqlPersistenceContext } from '../lib/PersistenceContract.js';

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
    // The read side of the `events_tags` join table, against the planner it was
    // written for (#391).  `PgWireRunner` already drives the same query class,
    // but CockroachDB and YugabyteDB *emulate* Postgres — and the constraint
    // that shaped the any-tag statement is a genuine PostgreSQL rule: `SELECT
    // DISTINCT` restricts `ORDER BY` to the select list, so the ordering is
    // spelled on the `e.` columns rather than the `t.` ones
    // (`RelationalQuery.anyTagSql`).  Only this suite proves the rule is
    // satisfied where it originates.  Left unset — as it was until now — the
    // scenario logs `SKIP … backend has no query implementation` and is then
    // reported as `PASS … (0ms)`, so nothing about the green job said the check
    // had not run.  `tests/unit/ci/LiveBrokerQueryWiring.test.ts` gates it now.
    makeQuery: (journal) => new PostgresQuery(journal as PostgresJournal),
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
