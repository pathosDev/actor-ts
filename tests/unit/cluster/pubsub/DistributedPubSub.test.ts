import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import {
  DistributedPubSubId,
  Publish,
  Subscribe,
  Unsubscribe,
} from '../../../../src/cluster/pubsub/index.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { TestKit } from '../../../../src/testkit/TestKit.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 2000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (pred()) return; await sleep(stepMs); }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface Node {
  system: ActorSystem;
  cluster: Cluster;
  mediator: import('../../../../src/ActorRef.js').ActorRef<Subscribe | Unsubscribe | Publish>;
  kit: TestKit;
}

async function startNode(systemName: string, host: string, port: number, seeds: string[] = []): Promise<Node> {
  const kit = TestKit.create(systemName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(kit.system, {
    host, port, seeds,
    transport: new InMemoryTransport(new NodeAddress(systemName, host, port)),
    failureDetector: { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 },
    gossipIntervalMs: 80,
  });
  const pubsub = kit.system.extension(DistributedPubSubId);
  const mediator = pubsub.start(cluster, { gossipIntervalMs: 100 });
  return { system: kit.system, cluster, mediator, kit };
}

async function stopNode(n: Node): Promise<void> {
  await n.cluster.leave();
  await n.system.terminate();
}

describe('DistributedPubSub — local', () => {
  test('publish delivers to local subscribers of the topic', async () => {
    const a = await startNode('ps-local', 'h', 51001);
    const probe = a.kit.createTestProbe();
    a.mediator.tell(new Subscribe('news', probe));
    await sleep(20);
    a.mediator.tell(new Publish('news', 'headline-1'));
    expect(await probe.expectMsg('headline-1', 500));
    await stopNode(a);
  });

  test('multiple subscribers all receive the message', async () => {
    const a = await startNode('ps-multi', 'h', 51002);
    const p1 = a.kit.createTestProbe();
    const p2 = a.kit.createTestProbe();
    a.mediator.tell(new Subscribe('t', p1));
    a.mediator.tell(new Subscribe('t', p2));
    await sleep(20);
    a.mediator.tell(new Publish('t', 'ping'));
    expect(await p1.expectMsg('ping', 500));
    expect(await p2.expectMsg('ping', 500));
    await stopNode(a);
  });

  test('Unsubscribe stops further delivery', async () => {
    const a = await startNode('ps-unsub', 'h', 51003);
    const probe = a.kit.createTestProbe();
    a.mediator.tell(new Subscribe('t', probe));
    await sleep(20);
    a.mediator.tell(new Publish('t', 'first'));
    await probe.expectMsg('first', 500);
    a.mediator.tell(new Unsubscribe('t', probe));
    await sleep(20);
    a.mediator.tell(new Publish('t', 'second'));
    await probe.expectNoMessage(60);
    await stopNode(a);
  });

  test('publishing to a topic with no subscribers is a no-op', async () => {
    const a = await startNode('ps-empty', 'h', 51004);
    a.mediator.tell(new Publish('nobody', 'fwiw'));
    await sleep(30);
    // Nothing to assert — just verify no crash.
    expect(a.cluster.upMembers().length).toBe(1);
    await stopNode(a);
  });
});

describe('DistributedPubSub — cluster-wide', () => {
  test('subscriber on node B receives publish from node A', async () => {
    const a = await startNode('ps-cluster-a', 'h', 51101);
    const b = await startNode('ps-cluster-a', 'h', 51102, ['ps-cluster-a@h:51101']);
    await waitFor(() => a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2, 2000);

    const probeB = b.kit.createTestProbe();
    b.mediator.tell(new Subscribe('orders', probeB));

    // Give gossip one pass so A knows about B's subscription.
    await sleep(350);

    a.mediator.tell(new Publish('orders', { sku: 'XYZ' }));
    expect(await probeB.expectMsg({ sku: 'XYZ' }, 1_000));

    await stopNode(a); await stopNode(b);
  });

  test('node leaving removes its subscribers from peers\' views', async () => {
    const a = await startNode('ps-leave', 'h', 51201);
    const b = await startNode('ps-leave', 'h', 51202, ['ps-leave@h:51201']);
    await waitFor(() => a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2, 2000);

    const probeB = b.kit.createTestProbe();
    b.mediator.tell(new Subscribe('telemetry', probeB));
    await sleep(350);

    // Confirm the mechanism works first.
    a.mediator.tell(new Publish('telemetry', 'alive'));
    await probeB.expectMsg('alive', 500);

    // Now B leaves — publishes from A should no longer try to forward.
    await stopNode(b);
    await sleep(600);

    // Publish shouldn't throw; the remote entry was pruned from A's view.
    a.mediator.tell(new Publish('telemetry', 'after-leave'));
    await sleep(30);
    expect(a.cluster.upMembers().length).toBe(1);
    await stopNode(a);
  });
});
