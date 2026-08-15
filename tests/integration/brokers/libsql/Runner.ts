/**
 * libSQL / Turso live-integration runner (#400).
 *
 * Boots against the `sqld` container, waits for it to be ready, then runs the
 * shared persistence contract (journal + snapshot + durable-state) against the
 * real `LibSqlJournal` / `LibSqlSnapshotStore` / `LibSqlDurableStateStore` over
 * HTTP via `@libsql/client`.  Exit 0 / 1 like the other broker runners.
 *
 * This is the suite that verifies the parts a fake cannot: real hrana
 * interactive transactions over HTTP, the server's own `SQLITE_CONSTRAINT`
 * error shapes feeding the concurrency backstop, and that the SQLite DDL the
 * dialect emits is accepted verbatim by libSQL.
 */
import { LibSqlDurableStateStore } from '../../../../src/persistence/durable-state-stores/LibSqlDurableStateStore.js';
import { LibSqlDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/LibSqlDurableStateStoreOptions.js';
import { LibSqlJournal } from '../../../../src/persistence/journals/LibSqlJournal.js';
import { LibSqlJournalOptions } from '../../../../src/persistence/journals/LibSqlJournalOptions.js';
import { LibSqlSnapshotStore } from '../../../../src/persistence/snapshot-stores/LibSqlSnapshotStore.js';
import { LibSqlSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/LibSqlSnapshotStoreOptions.js';
import { waitForHttp, waitForPort } from '../lib/WaitForPort.js';
import { runScenarios } from '../lib/Scenario.js';
import { sqlPersistenceScenarios, type SqlPersistenceContext } from '../lib/PersistenceContract.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  const url = requireEnv('LIBSQL_URL');
  const parsedUrl = new URL(url);
  await waitForPort(parsedUrl.hostname, Number(parsedUrl.port || '8080'), {
    description: 'libSQL (sqld)',
    deadlineMs: 60_000,
  });
  // The port opens before sqld finishes opening its database, and the image has
  // no shell for a compose healthcheck — so poll its health endpoint too.
  await waitForHttp(`${parsedUrl.origin}/health`, {
    description: 'libSQL (sqld) health',
    deadlineMs: 60_000,
  });

  // Factories, not instances: every contract scenario builds its own store, so
  // the scenarios stay independent and each closes the client it opened.
  const context: SqlPersistenceContext = {
    env: process.env,
    label: 'libsql',
    async makeJournal() {
      const journalOptions = LibSqlJournalOptions.create()
        .withUrl(url);
      return new LibSqlJournal(journalOptions);
    },
    async makeSnapshotStore(keepN) {
      const snapshotStoreOptions = LibSqlSnapshotStoreOptions.create()
        .withUrl(url)
        .withKeepN(keepN ?? 2);
      return new LibSqlSnapshotStore(snapshotStoreOptions);
    },
    async makeDurableStateStore() {
      const durableStateOptions = LibSqlDurableStateStoreOptions.create()
        .withUrl(url);
      return new LibSqlDurableStateStore(durableStateOptions);
    },
  };

  await runScenarios(sqlPersistenceScenarios(), context);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
