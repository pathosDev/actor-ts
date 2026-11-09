/**
 * #940, end to end over three live nodes: a node the other two removed while
 * it was not listening stands down once it hears them again.
 *
 * The state is the one a resumed process finds. Both survivors hold the victim
 * as a `removed` tombstone — they downed it, as their strategy would have
 * after a pause — while the victim still holds both of them `up` and goes on
 * heartbeating them. Before the fix that state was permanent: the survivors
 * acknowledged every heartbeat, the acknowledgment counted as liveness, and the
 * victim ran as a member of a three-node cluster that no longer had it.
 *
 * The stability window is left at its shipped 20 s and the test allows a few
 * seconds, so a pass also says the provider was asked without waiting it out —
 * every peer refusing the node is a settled view. `run-coordinated-shutdown-when-down`
 * is left unset, so the shipped default decides what the self-down ends in.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { SelfRemoved, type ClusterEvent } from '../../../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { KeepMajority } from '../../../../../src/cluster/downing/index.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

type Node = {
  readonly sys: ActorSystem;
  readonly cluster: Cluster;
  readonly events: ClusterEvent[];
};

let nodes: Node[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.sys.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

/** Fast enough that a heartbeat round is a few tens of milliseconds; far from `down-after`. */
const DETECTOR = { heartbeatIntervalMs: 50, unreachableAfterMs: 400, downAfterMs: 5_000 };

async function startNode(systemName: string, port: number, seedPort?: number): Promise<Node> {
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(systemName, systemOptions);
  let clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector(DETECTOR)
    .withGossipIntervalMs(50)
    .withDowning(new KeepMajority());
  if (seedPort !== undefined) clusterOptions = clusterOptions.withSeeds([`${systemName}@h:${seedPort}`]);
  const cluster = await Cluster.join(sys, clusterOptions);
  const events: ClusterEvent[] = [];
  cluster.subscribe((event) => events.push(event), { replayMode: 'snapshot' });
  const node = { sys, cluster, events };
  nodes.push(node);
  return node;
}

async function formTrio(systemName: string, basePort: number): Promise<[Node, Node, Node]> {
  const first = await startNode(systemName, basePort);
  const second = await startNode(systemName, basePort + 1, basePort);
  const third = await startNode(systemName, basePort + 2, basePort);
  const trio: [Node, Node, Node] = [first, second, third];
  await awaitCondition(() => trio.every((node) => node.cluster.upMembers().length === 3), {
    timeoutMs: 5_000, intervalMs: 20, label: 'all three nodes saw a three-member cluster',
  });
  return trio;
}

describe('a node the others removed stands down once it hears them (#940)', () => {
  test('both survivors removed it: it announces SelfRemoved within a few heartbeat rounds and its system ends', async () => {
    const [survivorA, victim, survivorB] = await formTrio('removed-stands-down', 64_951);
    const victimAddress = victim.cluster.selfAddress;
    victim.events.length = 0;

    // What the survivors' strategy did while the victim could not hear them.
    expect(survivorA.cluster.down(victimAddress)).toBe(true);
    expect(survivorB.cluster.down(victimAddress)).toBe(true);

    await awaitCondition(() => victim.events.some((event) => event instanceof SelfRemoved), {
      timeoutMs: 4_000, intervalMs: 20, label: 'the removed node announced SelfRemoved',
    });
    expect(victim.cluster.selfMember()?.status).toBe('removed');
    // The shipped `run-coordinated-shutdown-when-down = on`: nothing of the
    // node keeps running beside the survivors.
    await awaitCondition(() => victim.sys.isTerminated, {
      timeoutMs: 4_000, intervalMs: 20, label: 'the removed node ended its ActorSystem',
    });

    // The survivors carry on as a two-node cluster, and never take it back.
    for (const survivor of [survivorA, survivorB]) {
      expect(survivor.cluster.upMembers().map((member) => member.address.toString()).sort())
        .toEqual([survivorA.cluster.selfAddress.toString(), survivorB.cluster.selfAddress.toString()].sort());
      expect(survivor.cluster.selfMember()?.status).toBe('up');
    }
  }, 15_000);

  test('an operator down on one node reaches the downed node too: the removal gossips, and both survivors refuse it', async () => {
    // `Cluster.down` — what `POST /cluster/down` calls — used to tombstone the
    // node on the cluster's side only, while the node itself ran on. The
    // tombstone gossips to the other survivor, so both end up refusing it.
    const [survivorA, victim, survivorB] = await formTrio('removed-by-operator', 64_961);
    const victimAddress = victim.cluster.selfAddress;
    victim.events.length = 0;

    expect(survivorA.cluster.down(victimAddress)).toBe(true);

    await awaitCondition(() => victim.events.some((event) => event instanceof SelfRemoved), {
      timeoutMs: 4_000, intervalMs: 20, label: 'the downed node announced SelfRemoved',
    });
    await awaitCondition(() => victim.sys.isTerminated, {
      timeoutMs: 4_000, intervalMs: 20, label: 'the downed node ended its ActorSystem',
    });
    expect(survivorB.cluster.upMembers().some((member) => member.address.equals(victimAddress))).toBe(false);
  }, 15_000);
});
