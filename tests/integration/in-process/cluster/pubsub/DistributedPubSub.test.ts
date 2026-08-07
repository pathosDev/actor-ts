import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import {
  DistributedPubSubId,
  Publish,
  Subscribe,
  Unsubscribe,
} from '../../../../../src/cluster/pubsub/index.js';
import { DistributedPubSubMediator } from '../../../../../src/cluster/pubsub/DistributedPubSubMediator.js';
import { DistributedPubSubOptions } from '../../../../../src/cluster/pubsub/DistributedPubSubOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 2000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (pred()) return; await sleep(stepMs); }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Cross-node delivery depends on a gossip round having carried the
 * remote subscription, and there is no handle on the extension-owned
 * mediator's view of that.  Re-publishing until the subscriber sees
 * something is the observable the test does have: it returns on the
 * first gossip round that worked instead of betting a fixed number of
 * rounds fits in a fixed number of milliseconds (#418).  The payload is
 * identical every time, so the assertion that follows is unchanged.
 */
async function awaitPublishReaches(
  publish: () => void,
  probe: { hasMessage(): boolean },
  label: string,
): Promise<void> {
  await awaitCondition(
    async () => { publish(); await sleep(25); return probe.hasMessage(); },
    { timeoutMs: 4_000, intervalMs: 25, label },
  );
}

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  mediator: import('../../../../../src/ActorRef.js').ActorRef<Subscribe | Unsubscribe | Publish>;
  kit: TestKit;
};

async function startNode(systemName: string, host: string, port: number, seeds: string[] = []): Promise<Node> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(systemName, kitOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, host, port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  const pubsub = kit.system.extension(DistributedPubSubId);
  const pubsubOptions = DistributedPubSubOptions.create().withGossipIntervalMs(100);
  const mediator = pubsub.start(cluster, pubsubOptions);
  return { system: kit.system, cluster, mediator, kit };
}

async function stopNode(n: Node): Promise<void> {
  await n.cluster.leave();
  await n.system.terminate();
}

describe('DistributedPubSub — local', () => {
  test('publish delivers to local subscribers of the topic', async () => {
    const nodeA = await startNode('ps-local', 'h', 51001);
    const probe = nodeA.kit.createTestProbe();
    nodeA.mediator.tell(new Subscribe('news', probe));
    await sleep(20);
    nodeA.mediator.tell(new Publish('news', 'headline-1'));
    expect(await probe.expectMessage('headline-1', 500));
    await stopNode(nodeA);
  });

  test('multiple subscribers all receive the message', async () => {
    const nodeA = await startNode('ps-multi', 'h', 51002);
    const p1 = nodeA.kit.createTestProbe();
    const p2 = nodeA.kit.createTestProbe();
    nodeA.mediator.tell(new Subscribe('t', p1));
    nodeA.mediator.tell(new Subscribe('t', p2));
    await sleep(20);
    nodeA.mediator.tell(new Publish('t', 'ping'));
    expect(await p1.expectMessage('ping', 500));
    expect(await p2.expectMessage('ping', 500));
    await stopNode(nodeA);
  });

  test('Unsubscribe stops further delivery', async () => {
    const nodeA = await startNode('ps-unsub', 'h', 51003);
    const probe = nodeA.kit.createTestProbe();
    nodeA.mediator.tell(new Subscribe('t', probe));
    await sleep(20);
    nodeA.mediator.tell(new Publish('t', 'first'));
    await probe.expectMessage('first', 500);
    nodeA.mediator.tell(new Unsubscribe('t', probe));
    await sleep(20);
    nodeA.mediator.tell(new Publish('t', 'second'));
    await probe.expectNoMessage(60);
    await stopNode(nodeA);
  });

  test('publishing to a topic with no subscribers is a no-op', async () => {
    const nodeA = await startNode('ps-empty', 'h', 51004);
    nodeA.mediator.tell(new Publish('nobody', 'fwiw'));
    await sleep(30);
    // Nothing to assert — just verify no crash.
    expect(nodeA.cluster.upMembers().length).toBe(1);
    await stopNode(nodeA);
  });
});

describe('DistributedPubSub — cluster-wide', () => {
  test('subscriber on node B receives publish from node A', async () => {
    const nodeA = await startNode('ps-cluster-a', 'h', 51101);
    const nodeB = await startNode('ps-cluster-a', 'h', 51102, ['ps-cluster-a@h:51101']);
    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2, 2000);

    const probeB = nodeB.kit.createTestProbe();
    nodeB.mediator.tell(new Subscribe('orders', probeB));

    await awaitPublishReaches(
      () => nodeA.mediator.tell(new Publish('orders', { sku: 'XYZ' })),
      probeB,
      "gossip carried B's subscription so A's publish reaches it",
    );
    expect(await probeB.expectMessage({ sku: 'XYZ' }, 1_000));

    await stopNode(nodeA); await stopNode(nodeB);
  });

  test('node leaving removes its subscribers from peers\' views', async () => {
    const nodeA = await startNode('ps-leave', 'h', 51201);
    const nodeB = await startNode('ps-leave', 'h', 51202, ['ps-leave@h:51201']);
    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2, 2000);

    const probeB = nodeB.kit.createTestProbe();
    nodeB.mediator.tell(new Subscribe('telemetry', probeB));

    // Confirm the mechanism works first.
    await awaitPublishReaches(
      () => nodeA.mediator.tell(new Publish('telemetry', 'alive')),
      probeB,
      "gossip carried B's telemetry subscription",
    );
    await probeB.expectMessage('alive', 500);

    // Now B leaves — publishes from A should no longer try to forward.
    await stopNode(nodeB);
    await awaitCondition(() => nodeA.cluster.upMembers().length === 1, {
      timeoutMs: 4_000, intervalMs: 25, label: "B's leave landed in A's membership view",
    });

    // Publish shouldn't throw; the remote entry was pruned from A's view.
    nodeA.mediator.tell(new Publish('telemetry', 'after-leave'));
    await sleep(30);
    expect(nodeA.cluster.upMembers().length).toBe(1);
    await stopNode(nodeA);
  });
});

/* ----------------------------- audit (#80) ------------------------------ */

/**
 * Type-only escape hatch so the audit can read the mediator's private
 * `topics` map and call its private `buildGossip` builder.  We don't
 * mutate either — strictly read-only introspection to assert the
 * boundedness contract.
 */
interface MediatorInternals {
  readonly topics: Map<string, { local: Map<string, unknown>; remoteNodes: Set<string> }>;
  buildGossip(): { entries: ReadonlyArray<string> };
}

describe('DistributedPubSub — gossip-payload audit (#80)', () => {
  test('100 sub/unsub cycles leave the topics map empty and the gossip frame minimal', async () => {
    // Single-node setup: no peers means eagerGossip / gossipTick early-
    // return, but the local-state path still runs.  We bypass the
    // extension's auto-spawned mediator so we can capture the actor
    // instance via the factory closure and read its private
    // `topics` map / `buildGossip()` directly.
    const nodeA = await startNode('ps-audit-cycles', 'h', 51301);

    let captured: DistributedPubSubMediator | null = null;
    const mediatorOptions = DistributedPubSubOptions.create().withCluster(nodeA.cluster).withGossipIntervalMs(100);
    const auditMediator = nodeA.system.spawn(
      () => {
        captured = new DistributedPubSubMediator(mediatorOptions);
        return captured;
      },
      'audit-mediator',
    );
    // Wait for preStart to land (the factory ran synchronously, but
    // the actor cell needs one tick to register).
    await awaitCondition(() => captured !== null, {
      timeoutMs: 4_000, label: 'the audit mediator instance was captured',
    });
    const internals = captured! as unknown as MediatorInternals;

    const probe = nodeA.kit.createTestProbe();

    // 100 cycles of subscribe-then-unsubscribe to the same topic.  No pacing
    // sleeps: one mediator, one mailbox, so the cycles are ordered anyway,
    // and pacing them only moved the finish line further from the assertion.
    for (let i = 0; i < 100; i++) {
      auditMediator.tell(new Subscribe('hot-topic', probe));
      auditMediator.tell(new Unsubscribe('hot-topic', probe));
    }

    // `topics.size === 0` is also the map's *initial* state, so polling for
    // it directly would return before a single cycle had run.  A sentinel
    // queued behind the 100 cycles turns the drain into a real transition:
    // it can only appear once every cycle has been processed, and removing
    // it can only drop the map to empty if the cycles left no residue.
    auditMediator.tell(new Subscribe('drain-sentinel', probe));
    await awaitCondition(() => internals.topics.has('drain-sentinel'), {
      timeoutMs: 4_000, label: 'the mediator drained all 100 sub/unsub cycles',
    });
    auditMediator.tell(new Unsubscribe('drain-sentinel', probe));
    await awaitCondition(() => internals.topics.size === 0, {
      timeoutMs: 4_000, label: 'the topics map dropped back to empty',
    });

    // The contract: when a cycle drops `local` and `remoteNodes` to
    // empty, the topic entry is removed from `topics` (mediator
    // line 131) and from the gossip frame's `entries` (build-side
    // skip on `set.local.size === 0`).  100 in/out pairs must
    // therefore leave zero residue in either.  The version counter
    // grows monotonically — that's intentional and bounded (it's a
    // single integer, not a leak).
    expect(internals.topics.size).toBe(0);
    expect(internals.buildGossip().entries.length).toBe(0);

    await stopNode(nodeA);
  });

  test('gossip frame size stays proportional to topic count, not subscriber count', async () => {
    // Wire-bytes audit: the receiver only uses topic names from the
    // gossip frame (DistributedPubSubMediator.handleGossip discards
    // the per-topic subscriber lists), so the sender shouldn't pay
    // bytes for them.  Verifies #80's "audit + optional optimization":
    // adding 50 subscribers to one topic must not blow up the frame.
    const nodeA = await startNode('ps-audit-bytes', 'h', 51302);

    let captured: DistributedPubSubMediator | null = null;
    const mediatorOptions = DistributedPubSubOptions.create().withCluster(nodeA.cluster).withGossipIntervalMs(100);
    const auditMediator = nodeA.system.spawn(
      () => {
        captured = new DistributedPubSubMediator(mediatorOptions);
        return captured;
      },
      'audit-mediator-bytes',
    );
    await awaitCondition(() => captured !== null, {
      timeoutMs: 4_000, label: 'the byte-audit mediator instance was captured',
    });
    const internals = captured! as unknown as MediatorInternals;

    // One topic, one subscriber → baseline.  We measure the bytes
    // contributed by `entries` specifically (the rest of the frame
    // includes the version counter, whose decimal-string length
    // grows logarithmically — irrelevant to the audit).
    const probe1 = nodeA.kit.createTestProbe();
    auditMediator.tell(new Subscribe('busy', probe1));
    await awaitCondition(() => internals.topics.get('busy')?.local.size === 1, {
      timeoutMs: 4_000, label: 'the baseline subscriber joined the busy topic',
    });
    const oneSubEntries = JSON.stringify(internals.buildGossip().entries);

    // Same topic, 49 more subscribers (50 total).  `entries` must
    // stay identical — paths are not part of the gossip payload.
    for (let i = 0; i < 49; i++) {
      auditMediator.tell(new Subscribe('busy', nodeA.kit.createTestProbe()));
    }
    await awaitCondition(() => internals.topics.get('busy')?.local.size === 50, {
      timeoutMs: 4_000, label: 'all fifty subscribers joined the busy topic',
    });
    const fiftySubEntries = JSON.stringify(internals.buildGossip().entries);

    expect(fiftySubEntries).toBe(oneSubEntries);

    await stopNode(nodeA);
  });

  test('gossip frame entries field is a flat string array of topic names', async () => {
    // Wire-protocol shape assertion: the receiver only consumes topic
    // names, so the wire schema is `entries: string[]` — not a map of
    // topic → subscriber list.  Locks the schema in so a future
    // "let's also gossip the subscribers" change has to update this
    // test deliberately.
    const nodeA = await startNode('ps-audit-schema', 'h', 51303);

    let captured: DistributedPubSubMediator | null = null;
    const mediatorOptions = DistributedPubSubOptions.create().withCluster(nodeA.cluster).withGossipIntervalMs(100);
    const auditMediator = nodeA.system.spawn(
      () => {
        captured = new DistributedPubSubMediator(mediatorOptions);
        return captured;
      },
      'audit-mediator-schema',
    );
    await awaitCondition(() => captured !== null, {
      timeoutMs: 4_000, label: 'the schema-audit mediator instance was captured',
    });
    const internals = captured! as unknown as MediatorInternals;

    const probe = nodeA.kit.createTestProbe();
    auditMediator.tell(new Subscribe('topic-a', probe));
    auditMediator.tell(new Subscribe('topic-b', probe));
    await awaitCondition(() => internals.topics.size === 2, {
      timeoutMs: 4_000, label: 'both subscriptions landed in the topics map',
    });

    const frame = internals.buildGossip();
    expect(Array.isArray(frame.entries)).toBe(true);
    expect([...frame.entries].sort()).toEqual(['topic-a', 'topic-b']);

    await stopNode(nodeA);
  });
});
