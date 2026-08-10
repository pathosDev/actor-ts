import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../src/ActorRef.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import {
  Publish,
  Subscribe,
  SubscribeAcknowledgment,
} from '../../../src/cluster/pubsub/index.js';
import { DistributedPubSubMediator } from '../../../src/cluster/pubsub/DistributedPubSubMediator.js';
import {
  DistributedPubSubOptions,
  type DistributedPubSubOptionsBuilder,
} from '../../../src/cluster/pubsub/DistributedPubSubOptions.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * #155 — `Publish` with `delivery = 'one-subscriber'`: anycast, so a topic
 * can carry a work queue instead of only a broadcast.
 *
 * The selection is a rotation, not a draw, and that is what makes these tests
 * assertions rather than samples: a random pick can only be checked by running
 * it often enough for a distribution to show, which is both slow and flaky at
 * the volumes a unit test can afford.
 *
 * Every case runs against a **directly spawned** mediator: the rotation cursor
 * and the remote claim set live in the private `topics` map, and the extension
 * hands back only a ref.
 */

type Node = {
  readonly kit: TestKit;
  readonly cluster: Cluster;
  readonly transport: InMemoryTransport;
};

/** A spawned mediator plus the private surface these assertions read. */
type Mediator = {
  readonly ref: ActorRef<unknown>;
  readonly internals: MediatorInternals;
};

/** Private surface — read-only here, except for the gossip the peer case drives. */
interface MediatorInternals {
  readonly topics: Map<string, {
    local: Map<string, unknown>;
    remoteNodes: Set<string>;
    nextCandidateIndex: number;
  }>;
  handleGossip(
    message: { kind: 'pubsub-gossip'; from: unknown; entries: ReadonlyArray<string>; version: number },
    from: NodeAddress,
  ): void;
}

/** A `pubsub-publish-one` frame the mediator handed to the transport. */
type RecordedAnycast = {
  readonly to: string;
  readonly body: unknown;
};

async function startNode(systemName: string, port: number): Promise<Node> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(systemName, kitOptions);
  const transport = new InMemoryTransport(new NodeAddress(systemName, 'h', port));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(transport)
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { kit, cluster, transport };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.kit.system.terminate();
}

/** Spawn a mediator we hold the instance of, exactly as the cap suite does. */
async function spawnMediator(
  node: Node,
  name: string,
  mediatorOptions: DistributedPubSubOptionsBuilder,
): Promise<Mediator> {
  let captured: DistributedPubSubMediator | null = null;
  const ref = node.kit.system.spawn(() => {
    captured = new DistributedPubSubMediator(mediatorOptions);
    return captured;
  }, name);
  await awaitCondition(() => captured !== null, {
    timeoutMs: 4_000, label: `the ${name} instance was captured`,
  });
  return { ref: ref as ActorRef<unknown>, internals: captured! as unknown as MediatorInternals };
}

/** Register `probe` on `topic` and wait for the mediator to confirm it. */
async function subscribed(mediator: Mediator, topic: string, probe: TestProbe): Promise<void> {
  mediator.ref.tell(new Subscribe(topic, probe, probe));
  await probe.expectMessageType(SubscribeAcknowledgment, 500);
}

/** Subscribe to the system's dead letters so an unrouted publish is visible. */
function watchDeadLetters(node: Node): TestProbe {
  const probe = node.kit.createTestProbe();
  node.kit.system.eventStream.subscribe(probe, DeadLetter);
  return probe;
}

/**
 * Record every anycast frame the mediator hands to the transport.
 *
 * The remote half of the rotation has no other observable on a single node:
 * the chosen peer is a gossip claim, not a running system, and
 * `InMemoryTransport.send` drops a frame for an unregistered address without
 * a trace.  Watching the send is watching the decision.
 */
function recordAnycastFrames(transport: InMemoryTransport): RecordedAnycast[] {
  const recorded: RecordedAnycast[] = [];
  const send = transport.send.bind(transport);
  transport.send = (to: NodeAddress, message: WireMessage): void => {
    const envelope = message as { kind: string; body?: { kind?: string; body?: unknown } };
    if (envelope.kind === 'envelope' && envelope.body?.kind === 'pubsub-publish-one') {
      recorded.push({ to: to.toString(), body: envelope.body.body });
    }
    send(to, message);
  };
  return recorded;
}

describe('DistributedPubSub — anycast among local subscribers (#155)', () => {
  test('one subscriber of the topic receives the message, not all of them', async () => {
    const node = await startNode('ps-anycast-one', 51501);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100);
    const mediator = await spawnMediator(node, 'anycast-one', mediatorOptions);

    const first = node.kit.createTestProbe();
    const second = node.kit.createTestProbe();
    const third = node.kit.createTestProbe();
    await subscribed(mediator, 'work', first);
    await subscribed(mediator, 'work', second);
    await subscribed(mediator, 'work', third);

    mediator.ref.tell(new Publish('work', 'task', 'one-subscriber'));

    await first.expectMessage('task', 500);
    await second.expectNoMessage(60);
    await third.expectNoMessage(60);

    await stopNode(node);
  });

  test('consecutive anycasts rotate through the subscribers in registration order', async () => {
    const node = await startNode('ps-anycast-rotate', 51502);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100);
    const mediator = await spawnMediator(node, 'anycast-rotate', mediatorOptions);

    const workers = [
      node.kit.createTestProbe(),
      node.kit.createTestProbe(),
      node.kit.createTestProbe(),
    ];
    for (const worker of workers) await subscribed(mediator, 'queue', worker);

    // Two full turns of the rotation: worker i owns tasks i and i + 3.
    for (let task = 0; task < 6; task++) {
      mediator.ref.tell(new Publish('queue', `task-${task}`, 'one-subscriber'));
    }

    for (const [index, worker] of workers.entries()) {
      await worker.expectMessage(`task-${index}`, 500);
      await worker.expectMessage(`task-${index + 3}`, 500);
      await worker.expectNoMessage(60);
    }

    await stopNode(node);
  });

  test('a broadcast on the same topic still reaches everybody', async () => {
    // The two modes share one subscriber set; only the selection differs.
    const node = await startNode('ps-anycast-mixed', 51503);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100);
    const mediator = await spawnMediator(node, 'anycast-mixed', mediatorOptions);

    const first = node.kit.createTestProbe();
    const second = node.kit.createTestProbe();
    await subscribed(mediator, 'events', first);
    await subscribed(mediator, 'events', second);

    mediator.ref.tell(new Publish('events', 'announcement'));
    await first.expectMessage('announcement', 500);
    await second.expectMessage('announcement', 500);

    mediator.ref.tell(new Publish('events', 'one-off', 'one-subscriber'));
    await first.expectMessage('one-off', 500);
    await second.expectNoMessage(60);

    await stopNode(node);
  });

  test('an anycast with no candidate anywhere goes to dead letters', async () => {
    const node = await startNode('ps-anycast-orphan', 51504);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100);
    const mediator = await spawnMediator(node, 'anycast-orphan', mediatorOptions);
    const deadLetters = watchDeadLetters(node);

    mediator.ref.tell(new Publish('nobody-works-here', 'orphan', 'one-subscriber'));

    const deadLetter = await deadLetters.expectMessageType(DeadLetter, 1_000);
    expect(deadLetter.message).toBe('orphan');

    await stopNode(node);
  });
});

describe('DistributedPubSub — anycast across nodes (#155)', () => {
  test('a remote claimant is one candidate in the rotation and receives a frame', async () => {
    const node = await startNode('ps-anycast-remote', 51505);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100);
    const mediator = await spawnMediator(node, 'anycast-remote', mediatorOptions);
    const frames = recordAnycastFrames(node.transport);

    const local = node.kit.createTestProbe();
    await subscribed(mediator, 'work', local);

    // One peer claims the topic: candidates are now [local subscriber, peer].
    const peer = new NodeAddress('ps-anycast-remote', 'h', 51599);
    mediator.internals.handleGossip(
      { kind: 'pubsub-gossip', from: peer.toJSON(), entries: ['work'], version: 1 },
      peer,
    );
    expect(mediator.internals.topics.get('work')?.remoteNodes.size).toBe(1);

    mediator.ref.tell(new Publish('work', 'stays-here', 'one-subscriber'));
    mediator.ref.tell(new Publish('work', 'crosses-a-hop', 'one-subscriber'));

    await local.expectMessage('stays-here', 500);
    await local.expectNoMessage(60);
    expect(frames).toEqual([{ to: peer.toString(), body: 'crosses-a-hop' }]);

    await stopNode(node);
  });

  test('an anycast that crossed a hop picks one of the receiving node\'s subscribers', async () => {
    // The inbound frame is what a peer's mediator sends: the sender already
    // chose this node, so the only decision left is which local subscriber.
    const node = await startNode('ps-anycast-inbound', 51506);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100);
    const mediator = await spawnMediator(node, 'anycast-inbound', mediatorOptions);
    const deadLetters = watchDeadLetters(node);

    const first = node.kit.createTestProbe();
    const second = node.kit.createTestProbe();
    await subscribed(mediator, 'inbound', first);
    await subscribed(mediator, 'inbound', second);

    mediator.ref.tell({ kind: 'pubsub-publish-one', topic: 'inbound', body: 'hop-1' });
    mediator.ref.tell({ kind: 'pubsub-publish-one', topic: 'inbound', body: 'hop-2' });
    await first.expectMessage('hop-1', 500);
    await second.expectMessage('hop-2', 500);

    // A claim the sender routed on but this node no longer honours: the body
    // travelled a hop and reached nobody, which is the dead-letter case.
    mediator.ref.tell({ kind: 'pubsub-publish-one', topic: 'gone', body: 'stale' });
    const deadLetter = await deadLetters.expectMessageType(DeadLetter, 1_000);
    expect(deadLetter.message).toBe('stale');

    await stopNode(node);
  });
});
