import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import {
  DistributedPubSubId,
  Publish,
  Subscribe,
  type MediatorMessage,
} from '../../../../../src/cluster/pubsub/index.js';
import { DistributedPubSubOptions } from '../../../../../src/cluster/pubsub/DistributedPubSubOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/**
 * #155 — the cross-node half of anycast: a `Publish` with
 * `delivery = 'one-subscriber'` counts every remote node claiming the topic
 * as one candidate, and the chosen node picks a subscriber of its own.
 *
 * The rotation itself is asserted in `tests/unit/cluster/
 * DistributedPubSubAnycast.test.ts` against a mediator whose peers are
 * injected claims.  What only a real pair of nodes can show is that the frame
 * survives the round trip: envelope out, well-known path in, one local
 * delivery on the far side.
 */

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly mediator: ActorRef<MediatorMessage>;
  readonly kit: TestKit;
};

async function startNode(systemName: string, port: number, seeds: string[] = []): Promise<Node> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(systemName, kitOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  const pubsub = kit.system.extension(DistributedPubSubId);
  const pubsubOptions = DistributedPubSubOptions.create().withGossipIntervalMs(100);
  const mediator = pubsub.start(cluster, pubsubOptions);
  return { system: kit.system, cluster, mediator, kit };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.system.terminate();
}

/**
 * Re-publish until the far side sees something.  The observable for "gossip
 * carried the remote claim" is the delivery itself — there is no handle on
 * the extension-owned mediator's view — so this returns on the first round
 * that worked instead of betting a fixed number of rounds fits a fixed
 * number of milliseconds (#418).
 */
async function awaitAnycastReaches(publish: () => void, probe: TestProbe, label: string): Promise<void> {
  await awaitCondition(
    async () => { publish(); await sleep(25); return probe.hasMessage(); },
    { timeoutMs: 8_000, intervalMs: 25, label },
  );
}

/**
 * Drop everything the convergence loop published, including whatever is still
 * in flight.  Clearing once is not enough: the loop stops on the first frame
 * that arrived, and the ones behind it are still crossing the transport's
 * microtask hop.  There is no state to wait on here — the point is precisely
 * that nothing more should arrive — so a settle is the honest instrument.
 */
async function drain(...probes: TestProbe[]): Promise<void> {
  for (const probe of probes) probe.clearInbox();
  await sleep(120);
  for (const probe of probes) probe.clearInbox();
}

describe('DistributedPubSub — anycast across nodes (#155)', () => {
  test('an anycast reaches a subscriber on another node when this one has none', async () => {
    const nodeA = await startNode('ps-anycast-hop', 51601);
    const nodeB = await startNode('ps-anycast-hop', 51602, ['ps-anycast-hop@h:51601']);
    await awaitCondition(
      () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      { timeoutMs: 4_000, intervalMs: 25, label: 'both nodes see a two-member cluster' },
    );

    const worker = nodeB.kit.createTestProbe();
    nodeB.mediator.tell(new Subscribe('work', worker));

    // A has no local subscriber, so the only candidate is the node B claim.
    await awaitAnycastReaches(
      () => nodeA.mediator.tell(new Publish('work', 'task', 'one-subscriber')),
      worker,
      "gossip carried B's claim so A's anycast reaches it",
    );
    expect(await worker.expectMessage('task', 1_000));

    await stopNode(nodeA); await stopNode(nodeB);
  });

  test('local subscribers and a remote node share one rotation', async () => {
    const nodeA = await startNode('ps-anycast-share', 51611);
    const nodeB = await startNode('ps-anycast-share', 51612, ['ps-anycast-share@h:51611']);
    await awaitCondition(
      () => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      { timeoutMs: 4_000, intervalMs: 25, label: 'both nodes see a two-member cluster' },
    );

    const localWorker = nodeA.kit.createTestProbe();
    const remoteWorker = nodeB.kit.createTestProbe();
    nodeA.mediator.tell(new Subscribe('queue', localWorker));
    nodeB.mediator.tell(new Subscribe('queue', remoteWorker));

    await awaitAnycastReaches(
      () => nodeA.mediator.tell(new Publish('queue', 'warm-up', 'one-subscriber')),
      remoteWorker,
      "gossip carried B's claim into A's candidate list",
    );
    await drain(localWorker, remoteWorker);

    // Two candidates — A's own subscriber and the node B claim — so four
    // tasks split two and two whatever phase the cursor is in.  Node
    // granularity for the remote half is deliberate: #80 dropped per-node
    // subscriber counts from the gossip frame, so weighting is not available.
    for (let task = 0; task < 4; task++) {
      nodeA.mediator.tell(new Publish('queue', `task-${task}`, 'one-subscriber'));
    }

    expect(await localWorker.receiveN(2, 2_000)).toHaveLength(2);
    expect(await remoteWorker.receiveN(2, 2_000)).toHaveLength(2);
    await localWorker.expectNoMessage(120);
    await remoteWorker.expectNoMessage(120);

    await stopNode(nodeA); await stopNode(nodeB);
  });
});
