/**
 * #1500 — the join give-up of a node with no seed to contact names the fault
 * it actually has.
 *
 * The give-up's line carries the cold-start stall remedy, and for a node that
 * nobody has answered that remedy reads "no seed has answered at all. Seeds:
 * [...]. Check that these are the addresses those nodes advertise ...".  For
 * a node whose seed list is empty — or names only itself, which the join
 * drops — every word of it is wrong: nobody was asked, and the checklist
 * points at addresses that do not exist.  The stall report never reaches that
 * shape, because it runs from the seed loop an empty list never starts; the
 * give-up does, at its deadline.
 *
 * What is true instead depends on the policy: `'never'` may not found a
 * cluster and has nobody to join, while any other policy did found one, whose
 * self-election the membership threshold is holding.
 *
 * Driven by a {@link ManualScheduler}, so the deadline is a call, not a wait.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { SelfElectionPolicy } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { ClusterJoinUnsuccessfulReason, CoordinatedShutdownId, Phases, type Reason } from '../../../src/index.js';
import { LogLevel } from '../../../src/Logger.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/** One seed round of virtual time; the deadline has to be at least one. */
const RETRY_INTERVAL_MS = 100;
const DEADLINE_MS = RETRY_INTERVAL_MS * 10;

const SYSTEM = 'give-up-without-seeds';
const HOST = '10.0.194.1';
const SEED_HOST = '10.0.194.2';

type NodeSpec = {
  readonly seeds: ReadonlyArray<string>;
  readonly selfElection?: SelfElectionPolicy;
  readonly minimumMembersBeforeUp?: number;
};

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly scheduler: ManualScheduler;
  readonly logger: RecordingLogger;
  /** The reason of every pipeline run, as a `before-service-unbind` task saw it. */
  readonly reasons: Reason[];
};

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

async function startNode(port: number, spec: NodeSpec): Promise<NodeHandle> {
  const address = new NodeAddress(SYSTEM, HOST, port);
  const logger = new RecordingLogger();
  const scheduler = new ManualScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Debug)
    .withScheduler(scheduler);
  const system = ActorSystem.create(SYSTEM, systemOptions);
  const reasons: Reason[] = [];
  system.extension(CoordinatedShutdownId).addTask(Phases.BeforeServiceUnbind, 'record-the-reason', (reason) => {
    reasons.push(reason);
  });
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withSeeds([...spec.seeds])
    .withSeedRetryIntervalMs(RETRY_INTERVAL_MS)
    .withShutdownAfterUnsuccessfulJoinMs(DEADLINE_MS)
    .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 120_000, downAfterMs: 240_000 })
    .withGossipIntervalMs(60_000);
  if (spec.selfElection !== undefined) clusterOptions.withSelfElection(spec.selfElection);
  if (spec.minimumMembersBeforeUp !== undefined) clusterOptions.withMinimumMembersBeforeUp(spec.minimumMembersBeforeUp);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, scheduler, logger, reasons };
  nodes.push(node);
  return node;
}

function giveUpLine(node: NodeHandle): string {
  const lines = node.logger.records
    .filter((record) => record.level === 'warn' && record.message.includes('giving up the join'))
    .map((record) => record.message);
  expect(lines).toHaveLength(1);
  expect(node.reasons).toEqual([ClusterJoinUnsuccessfulReason.instance]);
  return lines[0] ?? '';
}

/** The unanswered-seeds remedy: right for a node that asked and heard nothing, wrong for one that asked nobody. */
function expectNoUnansweredSeedRemedy(line: string): void {
  expect(line).not.toContain('no seed has answered at all');
  expect(line).not.toContain('Check that these are the addresses');
}

describe('a node with no seed to contact gives up naming its real fault (#1500)', () => {
  test("'never' with an empty seed list: nobody to join, and not allowed to found", async () => {
    const node = await startNode(9_401, { seeds: [], selfElection: 'never' });

    node.scheduler.advance(DEADLINE_MS);

    const line = giveUpLine(node);
    expectNoUnansweredSeedRemedy(line);
    expect(line).toContain('no seed to contact');
    expect(line).toContain("selfElection: 'never'");
    expect(line).toContain('only a peer that lists it as a seed can bring it in');
  });

  test("'never' whose only seed is its own address: the same, since the join drops it", async () => {
    const node = await startNode(9_402, { seeds: [`${HOST}:9402`], selfElection: 'never' });

    node.scheduler.advance(DEADLINE_MS);

    const line = giveUpLine(node);
    expectNoUnansweredSeedRemedy(line);
    expect(line).toContain('no seed to contact');
    expect(line).toContain("selfElection: 'never'");
  });

  test('a founder the membership threshold holds names the threshold, not unanswered seeds', async () => {
    // `'immediate'` on an empty list founds the cluster — and the threshold
    // holds that self-election until enough members are present.
    const node = await startNode(9_403, { seeds: [], minimumMembersBeforeUp: 2 });

    node.scheduler.advance(DEADLINE_MS);

    const line = giveUpLine(node);
    expectNoUnansweredSeedRemedy(line);
    expect(line).toContain('no seed to contact');
    expect(line).toContain('actor-ts.cluster.minimum-members-before-up');
    expect(line).toContain('1 of 2 member(s) present');
    expect(line).not.toContain("selfElection: 'never'");
  });

  test("'never' with a seed nobody answers still names that seed: the policy alone is not the fault", async () => {
    // The control: this node did ask, and nobody answered — the
    // unanswered-seeds remedy is the right one here, policy or not.
    const node = await startNode(9_404, { seeds: [`${SEED_HOST}:9404`], selfElection: 'never' });

    node.scheduler.advance(DEADLINE_MS);

    const line = giveUpLine(node);
    expect(line).toContain('no seed has answered at all');
    expect(line).toContain(`${SYSTEM}@${SEED_HOST}:9404`);
    expect(line).not.toContain('no seed to contact');
  });
});
