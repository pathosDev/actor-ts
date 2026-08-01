/**
 * Shared entry point for the PostgreSQL-wire-compatibility suites (#401).
 *
 * CockroachDB and YugabyteDB are certifications, not backends: they run the
 * **existing** `PostgresJournal` / `PostgresSnapshotStore` /
 * `PostgresDurableStateStore` against a different server that speaks the same
 * wire protocol.  Since nothing but the URL and the label differ, both runners
 * are one call into this function rather than two copies of the Postgres runner
 * — a copy would be the thing most likely to drift out of sync with it.
 *
 * What the suites actually certify, beyond "it connects":
 *   - the full journal / snapshot / durable-state contract, including the
 *     compaction high-water mark and the `keepN` prune;
 *   - that the optimistic-concurrency backstop still fires.  That matters most
 *     for Yugabyte, which reworks some Postgres error *messages*
 *     (yugabyte/yugabyte-db#9294) — harmless only because `postgresDialect`
 *     classifies a duplicate key by SQLSTATE `23505` and never by text.  The
 *     contract's concurrent-append scenario is what exercises that path.
 */
import { PostgresDurableStateStore } from '../../../../src/persistence/durable-state-stores/PostgresDurableStateStore.js';
import { PostgresDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/PostgresDurableStateStoreOptions.js';
import { PostgresJournal } from '../../../../src/persistence/journals/PostgresJournal.js';
import { PostgresJournalOptions } from '../../../../src/persistence/journals/PostgresJournalOptions.js';
import { PostgresSnapshotStore } from '../../../../src/persistence/snapshot-stores/PostgresSnapshotStore.js';
import { PostgresSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/PostgresSnapshotStoreOptions.js';
import { waitForPort } from './wait-for-port.js';
import { runScenarios } from './scenario.js';
import { sqlPersistenceScenarios, type SqlPersistenceContext } from './persistence-contract.js';

export type PgWireSuiteOptions = {
  /** Display name for the readiness wait ("CockroachDB", "YugabyteDB"). */
  readonly description: string;
  /** Port to fall back to when the URL carries none. */
  readonly defaultPort: number;
  /** How long the server may take to accept connections — Yugabyte is slow. */
  readonly readinessDeadlineMs?: number;
};

/**
 * Run the shared SQL persistence contract against a Postgres-wire server.
 * Reads `PG_URL` and `WIRE_LABEL` from the environment; exits 0 / 1 like the
 * other broker runners.
 */
export async function runPgWireSuite(options: PgWireSuiteOptions): Promise<void> {
  const url = requireEnv('PG_URL');
  const label = requireEnv('WIRE_LABEL');
  const parsedUrl = new URL(url);
  await waitForPort(parsedUrl.hostname, Number(parsedUrl.port || String(options.defaultPort)), {
    description: options.description,
    deadlineMs: options.readinessDeadlineMs ?? 60_000,
  });

  // Factories, not instances: every contract scenario builds its own store, so
  // the scenarios stay independent and each closes the pool it opened.
  const context: SqlPersistenceContext = {
    env: process.env,
    label,
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}
