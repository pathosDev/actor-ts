/**
 * DynamoDB live-integration runner (#398).
 *
 * Boots against the `dynamodb-local` container, waits for the port, then runs the
 * shared persistence contract (journal + snapshot + durable-state) against the
 * real `DynamoDbJournal` / `DynamoDbSnapshotStore` / `DynamoDbDurableStateStore`
 * via `@aws-sdk/client-dynamodb`.  Exit 0 / 1 like the other broker runners.
 *
 * This is the suite that verifies what the fake cannot: that DynamoDB really
 * enforces `attribute_not_exists` on a transactional put, that a cancelled
 * transaction reports `ConditionalCheckFailed` in `CancellationReasons`, that
 * `CreateTable` + the ACTIVE wait behave as assumed, and that the ranged queries
 * and batch deletes are accepted as written.
 */
import { DynamoDbDurableStateStore } from '../../../../src/persistence/durable-state-stores/DynamoDbDurableStateStore.js';
import { DynamoDbDurableStateStoreOptions } from '../../../../src/persistence/durable-state-stores/DynamoDbDurableStateStoreOptions.js';
import { DynamoDbJournal } from '../../../../src/persistence/journals/DynamoDbJournal.js';
import { DynamoDbJournalOptions } from '../../../../src/persistence/journals/DynamoDbJournalOptions.js';
import { DynamoDbSnapshotStore } from '../../../../src/persistence/snapshot-stores/DynamoDbSnapshotStore.js';
import { DynamoDbSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/DynamoDbSnapshotStoreOptions.js';
import { waitForPort } from '../lib/WaitForPort.js';
import { runScenarios } from '../lib/Scenario.js';
import { sqlPersistenceScenarios, type SqlPersistenceContext } from '../lib/PersistenceContract.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

async function main(): Promise<void> {
  const endpoint = requireEnv('DYNAMODB_ENDPOINT');
  const region = requireEnv('AWS_REGION');
  const parsedEndpoint = new URL(endpoint);
  await waitForPort(parsedEndpoint.hostname, Number(parsedEndpoint.port || '8000'), {
    description: 'DynamoDB Local',
    deadlineMs: 60_000,
  });

  // dynamodb-local ignores credentials, but the SDK refuses to sign a request
  // without them, so they are passed explicitly rather than relying on the
  // ambient provider chain (which would try IMDS and stall).
  const credentials = {
    accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
  };

  // Factories, not instances: every contract scenario builds its own store, so
  // the scenarios stay independent and each closes the client it opened.
  const context: SqlPersistenceContext = {
    env: process.env,
    label: 'dynamodb',
    async makeJournal() {
      const journalOptions = DynamoDbJournalOptions.create()
        .withRegion(region)
        .withEndpoint(endpoint)
        .withClientConfig({ credentials });
      return new DynamoDbJournal(journalOptions);
    },
    async makeSnapshotStore(keepN) {
      const snapshotStoreOptions = DynamoDbSnapshotStoreOptions.create()
        .withRegion(region)
        .withEndpoint(endpoint)
        .withClientConfig({ credentials })
        .withKeepN(keepN ?? 2);
      return new DynamoDbSnapshotStore(snapshotStoreOptions);
    },
    async makeDurableStateStore() {
      const durableStateOptions = DynamoDbDurableStateStoreOptions.create()
        .withRegion(region)
        .withEndpoint(endpoint)
        .withClientConfig({ credentials });
      return new DynamoDbDurableStateStore(durableStateOptions);
    },
  };

  await runScenarios(sqlPersistenceScenarios(), context);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
