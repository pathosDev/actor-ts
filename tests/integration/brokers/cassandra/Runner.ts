/**
 * Cassandra live-integration runner (#676, refs #1169).
 *
 * Boots against the Cassandra container, waits until the node actually answers
 * CQL, then runs the scenarios against the real `CassandraJournal`,
 * `CassandraQuery` and `CassandraSnapshotStore` through the real
 * `cassandra-driver`.  Exit 0 / 1 like the other broker runners.
 *
 * **Why this suite is not the shared persistence contract.**  The eight
 * persistence suites hand three factories to `sqlPersistenceScenarios()`, and
 * one of them is `makeDurableStateStore`.  There is no Cassandra
 * durable-state store — the backend is a journal, a query and a snapshot store
 * — so a context built for that contract would have to fail or fake its third
 * factory, and the durable-state scenarios would then either go red or assert
 * nothing.  Own scenarios instead, kept few and pointed at the seams a fake
 * cannot reach:
 *
 *   1. the module shape `CassandraClient.ts` destructures, and the `[applied]`
 *      marker every lightweight transaction is decoded through;
 *   2. the LWT append serializer against real Paxos, across partitions;
 *   3. the `events_by_tag` side table, written by the journal and read by
 *      `CassandraQuery`, including compaction reaching it (#654);
 *   4. the snapshot store sharing one client — and one storage identity —
 *      with the journal over the same keyspace (#1358).
 *
 * The tag-index and snapshot paths are the ones `FakeCassandraClient` answers
 * out of a JS map: it never parses CQL, so a clustering-order or
 * primary-key mistake in the DDL is invisible to it and fatal here.
 */
import {
  createCassandraClient,
  type CassandraClientLike,
  type CassandraConnection,
} from '../../../../src/persistence/journals/CassandraClient.js';
import { CassandraJournal } from '../../../../src/persistence/journals/CassandraJournal.js';
import { CassandraJournalOptions } from '../../../../src/persistence/journals/CassandraJournalOptions.js';
import { CassandraSnapshotStore } from '../../../../src/persistence/snapshot-stores/CassandraSnapshotStore.js';
import { CassandraSnapshotStoreOptions } from '../../../../src/persistence/snapshot-stores/CassandraSnapshotStoreOptions.js';
import { runScenarios, type BrokerScenario, type BrokerScenarioContext } from '../lib/Scenario.js';
import { scenario as driverShapeScenario } from './scenarios/01-driver-shape.js';
import { scenario as journalRoundTripScenario } from './scenarios/02-journal-round-trip.js';
import { scenario as tagIndexScenario } from './scenarios/03-tag-index.js';
import { scenario as snapshotScenario } from './scenarios/04-snapshot-store.js';

/**
 * `types.consistencies.localQuorum` and `.localSerial` from `cassandra-driver`.
 *
 * The options take a bare number — the driver's enum is not importable from
 * `src/`, since the library reaches the whole module through a structural stub
 * — so the two values the docs tell users to pass are transcribed here, and
 * scenario 01 asserts them back against `types.consistencies` on the real
 * module.  That is what makes hardcoding them safe rather than a second copy
 * waiting to drift.
 */
export const CONSISTENCY_LOCAL_QUORUM = 6;
export const SERIAL_CONSISTENCY_LOCAL_SERIAL = 9;

/**
 * `NetworkTopologyStrategy`, not the `SimpleStrategy` the adapter defaults to
 * when `autoCreateKeyspace` is on.
 *
 * `LOCAL_QUORUM` and `LOCAL_SERIAL` are defined in terms of a *data center*,
 * so pointing them at a SimpleStrategy keyspace — which has no DC-aware
 * replica map — is at best ill-defined and at worst rejected outright. NTS
 * makes both mean exactly what the options' JSDoc says they mean, and it
 * exercises the branch of `keyspaceDdl` that has only ever run against a fake.
 *
 * `datacenter1` is the name the image's default `SimpleSnitch` reports, and
 * the suite already depends on it either way: `createCassandraClient` passes
 * it as `localDataCenter`, without which the driver's DC-aware load-balancing
 * policy has no host to route to. So naming it here couples to nothing new.
 */
const KEYSPACE_REPLICATION = {
  class: 'NetworkTopologyStrategy',
  dataCenters: { datacenter1: 1 },
} as const;

/** How long the node gets to start answering CQL before the run gives up. */
const CQL_READY_DEADLINE_MS = 180_000;
/** Gap between readiness attempts — Cassandra boots in tens of seconds, not milliseconds. */
const CQL_READY_INTERVAL_MS = 2_000;

export interface CassandraContext extends BrokerScenarioContext {
  readonly contactPoint: string;
  readonly port: number;
  readonly keyspace: string;
  /**
   * Namespace a persistence id.  The keyspace survives a re-run without
   * `docker compose down -v`, and a journal's high-water mark deliberately
   * survives compaction, so "delete everything and start at 0" is not a valid
   * reset — fresh ids per run are (the same reasoning
   * `lib/PersistenceContract.ts` states at length).
   */
  pid(name: string): string;
}

/** Optional overrides a scenario needs; everything else is the suite default. */
export type JournalOverrides = {
  readonly useTagIndex?: boolean;
  readonly partitionSize?: number;
  readonly client?: CassandraClientLike;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`runner: missing env var ${name}`);
  return value;
}

/**
 * A journal against the live keyspace.
 *
 * `autoCreateKeyspace` and `autoCreateTables` are both on, so the DDL in
 * `CassandraJournal.ensureTables()` is executed by the server rather than
 * accepted by a fake — which is the only place a wrong clustering order or a
 * mistyped column would ever surface.
 */
export function makeJournal(
  context: CassandraContext,
  overrides: JournalOverrides = {},
): CassandraJournal {
  const journalOptions = CassandraJournalOptions.create()
    .withContactPoints([context.contactPoint])
    .withPort(context.port)
    .withKeyspace(context.keyspace)
    .withAutoCreateKeyspace(true)
    .withReplication(KEYSPACE_REPLICATION)
    .withConsistency(CONSISTENCY_LOCAL_QUORUM)
    .withSerialConsistency(SERIAL_CONSISTENCY_LOCAL_SERIAL);
  if (overrides.useTagIndex !== undefined) journalOptions.withUseTagIndex(overrides.useTagIndex);
  if (overrides.partitionSize !== undefined) journalOptions.withPartitionSize(overrides.partitionSize);
  if (overrides.client !== undefined) journalOptions.withClient(overrides.client);
  return new CassandraJournal(journalOptions);
}

/** A snapshot store against the live keyspace, optionally sharing the journal's client. */
export function makeSnapshotStore(
  context: CassandraContext,
  keepN: number,
  client?: CassandraClientLike,
): CassandraSnapshotStore {
  const snapshotStoreOptions = CassandraSnapshotStoreOptions.create()
    .withContactPoints([context.contactPoint])
    .withPort(context.port)
    .withKeyspace(context.keyspace)
    .withAutoCreateKeyspace(true)
    .withReplication(KEYSPACE_REPLICATION)
    .withConsistency(CONSISTENCY_LOCAL_QUORUM)
    .withKeepN(keepN);
  if (client !== undefined) snapshotStoreOptions.withClient(client);
  return new CassandraSnapshotStore(snapshotStoreOptions);
}

/**
 * The bare connection both stores are built on.
 *
 * Exported so `01-driver-shape.ts` can bootstrap its probe keyspace through
 * the library's own `keyspaceDdl()` rather than hand-rolling a second
 * `CREATE KEYSPACE` — two spellings of one replication clause is exactly the
 * pair that drifts, and the first scenario to run is the one that would decide
 * which of them the keyspace ends up with.
 */
export function connectionFor(context: CassandraContext): CassandraConnection {
  return {
    contactPoints: [context.contactPoint],
    port: context.port,
    keyspace: context.keyspace,
    autoCreateKeyspace: true,
    replication: KEYSPACE_REPLICATION,
    consistency: CONSISTENCY_LOCAL_QUORUM,
  };
}

/** A bare client on the same connection the stores use — for shared-client scenarios. */
export function makeClient(context: CassandraContext): Promise<CassandraClientLike> {
  return createCassandraClient(connectionFor(context));
}

/**
 * Block until the node answers a CQL statement.
 *
 * The compose healthcheck already gates `depends_on`, and this is deliberately
 * the second layer rather than a duplicate of it: a `waitForPort` would return
 * as soon as 9042 accepts, which Cassandra does well before it will serve a
 * query, and the failure that produces is a `NoHostAvailableError` inside the
 * first scenario rather than a readiness timeout naming the container.
 */
async function waitForCql(context: CassandraContext): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + CQL_READY_DEADLINE_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const client = await makeClient(context);
    try {
      await client.connect();
      await client.execute('SELECT release_version FROM system.local');
      await client.shutdown();
      console.log(`[runner] Cassandra answered CQL after ${Date.now() - startedAt}ms`);
      return;
    } catch (e) {
      lastError = e;
      try { await client.shutdown(); } catch { /* the connect is what failed */ }
    }
    // Backoff between attempts, not a wait for a state something else can be
    // polled for: the state here IS "does the server answer yet", and the
    // attempt above is the poll.  Retrying without a gap would hammer a
    // booting node for ninety seconds and log a wall of connect failures.
    await new Promise((resolve) => setTimeout(resolve, CQL_READY_INTERVAL_MS));
  }
  throw new Error(
    `runner: Cassandra at ${context.contactPoint}:${context.port} did not answer CQL within `
    + `${Math.round(CQL_READY_DEADLINE_MS / 1000)}s`
    + (lastError ? ` — last error: ${(lastError as Error).message}` : ''),
  );
}

async function main(): Promise<void> {
  const contactPoint = requireEnv('CASSANDRA_CONTACT_POINT');
  const port = Number(requireEnv('CASSANDRA_PORT'));
  const keyspace = requireEnv('CASSANDRA_KEYSPACE');
  const runId = Date.now().toString(36);

  const context: CassandraContext = {
    env: process.env,
    contactPoint,
    port,
    keyspace,
    pid: (name) => `cassandra:${runId}:${name}`,
  };

  await waitForCql(context);

  const scenarios: BrokerScenario<CassandraContext>[] = [
    driverShapeScenario,
    journalRoundTripScenario,
    tagIndexScenario,
    snapshotScenario,
  ];
  await runScenarios(scenarios, context);
}

main().catch((e) => {
  console.error('[runner] fatal:', e);
  process.exit(2);
});
