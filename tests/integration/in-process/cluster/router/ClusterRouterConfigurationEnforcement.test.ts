/**
 * `configuration-compatibility-check.enforce` seen from the only place it is
 * wired to change anything: routee selection (#844).
 *
 * `Cluster.placementCandidates()` has exactly one production consumer —
 * `ClusterRouter.rebuildRoutees` — and reverting that call site to
 * `upMembers()` left every cluster and router suite green, because the four
 * cases that touch the candidate set call it directly on the `Cluster` and
 * never through a router.  So the documented consequence of enforcement ("this
 * node has stopped placing work on that peer") rested on a line nothing
 * exercised.  These two cases route real messages over a real transport and
 * assert where they land.
 *
 * Two real in-process nodes rather than a stubbed cluster: what is under test
 * is the join between the candidate set and the router, and a stub would let
 * the router read `upMembers()` and still pass.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { ClusterRouter, ClusterRouterOptions } from '../../../../../src/cluster/router/index.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

const SYSTEM = 'router-enforcement';
const HOST = 'h';
const ROUTEE_PATH = '/user/worker';
const SIXTEEN_MEBIBYTES = 16 * 1024 * 1024;
const ONE_MEBIBYTE = 1024 * 1024;
const MESSAGES = 6;

type WorkMessage = { kind: 'work'; id: string };

type Delivery = { readonly node: string; readonly id: string };

let delivered: Delivery[] = [];

/**
 * Both nodes run one of these at the same path, so where a message landed is
 * the only thing that separates them — the constructor argument is what the
 * factory form of a spawn slot exists for.
 */
class Worker extends Actor<WorkMessage> {
  constructor(private readonly node: string) { super(); }

  override onReceive(message: WorkMessage): void {
    delivered.push({ node: this.node, id: message.id });
  }
}

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
};

const running: Node[] = [];

async function startNode(
  port: number, maxFrameBytes: number, seeds: string[], enforce: boolean,
): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(SYSTEM, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(HOST)
    .withPort(port)
    .withSeeds(seeds)
    .withMaxFrameBytes(maxFrameBytes)
    .withConfigurationCompatibilityEnforce(enforce)
    .withTransport(new InMemoryTransport(new NodeAddress(SYSTEM, HOST, port)))
    .withGossipIntervalMs(30)
    .withSeedRetryIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);
  const node: Node = { system, cluster };
  running.push(node);
  return node;
}

async function stopAll(): Promise<void> {
  for (const node of running.splice(0)) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
}

function addressOf(port: number): string {
  return `${SYSTEM}@${HOST}:${port}`;
}

/**
 * The router builds its routee set in `preStart` and rebuilds it only on
 * `MemberUp` / `MemberRemoved`, and a divergence is neither.  So the cluster's
 * own view has to have settled before the router is spawned, or "routed only
 * to self" is indistinguishable from "the peer had not joined yet".
 */
function awaitCandidates(node: Node, upCount: number, candidateCount: number): Promise<void> {
  return awaitCondition(
    () => node.cluster.upMembers().length === upCount
      && node.cluster.placementCandidates().length === candidateCount,
    {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: `${upCount} up-members and ${candidateCount} placement candidate(s)`,
    },
  );
}

function spawnRouter(node: Node): ReturnType<ActorSystem['spawn']> {
  const routerOptions = ClusterRouterOptions.create<WorkMessage>()
    .withCluster(node.cluster)
    .withRouterType('round-robin')
    .withRouteePath(ROUTEE_PATH);
  return node.system.spawn(ClusterRouter.factory<WorkMessage>(routerOptions), 'work-router');
}

describe('enforcement is what a ClusterRouter selects on (#844)', () => {
  test('a diverging peer receives none of the routed work', async () => {
    delivered = [];
    const first = await startNode(89_201, SIXTEEN_MEBIBYTES, [], true);
    const second = await startNode(89_202, ONE_MEBIBYTE, [addressOf(89_201)], false);
    try {
      first.system.spawn(() => new Worker('first'), 'worker');
      second.system.spawn(() => new Worker('second'), 'worker');
      await awaitCandidates(first, 2, 1);
      // The peer is not enforcing, so it keeps this node as a candidate: the
      // view is per-node and asymmetric, which is why nothing *elected* reads
      // it.  Awaited rather than asserted after the fact so the peer is fully
      // up before any work is routed — otherwise "it received nothing" could
      // mean it had not joined.
      await awaitCandidates(second, 2, 2);

      const router = spawnRouter(first);
      for (let index = 0; index < MESSAGES; index++) {
        router.tell({ kind: 'work', id: `w${index}` });
      }
      await awaitCondition(() => delivered.length === MESSAGES, {
        timeoutMs: 4_000, intervalMs: 20, label: 'every message was delivered somewhere',
      });

      // Round-robin over two up-members would have put half of these on the
      // diverging node.  It is still `up` and still reachable — enforcement
      // never downs anyone — so a delivery there is a live routing decision,
      // not a message that had nowhere else to go.
      expect(delivered.map((entry) => entry.node)).toEqual(Array(MESSAGES).fill('first'));
    } finally {
      await stopAll();
    }
  }, 10_000);

  test('an agreeing peer takes its half — the control', async () => {
    // Without this, "the diverging peer got nothing" is satisfied by a router
    // that never routes off-node at all.
    delivered = [];
    const first = await startNode(89_203, SIXTEEN_MEBIBYTES, [], true);
    const second = await startNode(89_204, SIXTEEN_MEBIBYTES, [addressOf(89_203)], false);
    try {
      first.system.spawn(() => new Worker('first'), 'worker');
      second.system.spawn(() => new Worker('second'), 'worker');
      await awaitCandidates(first, 2, 2);

      const router = spawnRouter(first);
      for (let index = 0; index < MESSAGES; index++) {
        router.tell({ kind: 'work', id: `w${index}` });
      }
      await awaitCondition(() => delivered.length === MESSAGES, {
        timeoutMs: 4_000, intervalMs: 20, label: 'every message was delivered somewhere',
      });

      expect(delivered.filter((entry) => entry.node === 'second').length)
        .toBe(MESSAGES / 2);
    } finally {
      await stopAll();
    }
  }, 10_000);
});
