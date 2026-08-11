import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import {
  Publish,
  Subscribe,
  SubscribeAcknowledgment,
  SubscribeRejected,
  Unsubscribe,
} from '../../../../../src/cluster/pubsub/index.js';
import { DistributedPubSubMediator } from '../../../../../src/cluster/pubsub/DistributedPubSubMediator.js';
import {
  DistributedPubSubOptions,
  type DistributedPubSubOptionsBuilder,
} from '../../../../../src/cluster/pubsub/DistributedPubSubOptions.js';
import { DeadLetter } from '../../../../../src/SystemMessages.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { BidirectionalMultiMap } from '../../../../../src/util/BidirectionalMultiMap.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/**
 * #139 — three registries in the mediator grew without a bound: local
 * subscribers per topic, distinct topics, and the remote nodes claiming a
 * topic.  Publish fan-out walks all three, so bounding them is a latency
 * guarantee as much as a memory one.  #857 adds the HOCON knobs and the
 * dead-letter escape for a publish that reached nobody.
 *
 * Every case here runs against a **directly spawned** mediator rather than
 * the extension's: the caps are per-mediator options, and holding the
 * instance is also what gives the gossip case a handle on the private
 * `handleGossip` the wire hook would otherwise own.
 */

type Node = {
  readonly kit: TestKit;
  readonly cluster: Cluster;
};

/** A spawned mediator plus the private surface the cap assertions read. */
type Mediator = {
  readonly ref: ActorRef<unknown>;
  readonly internals: MediatorInternals;
};

/** Private surface the cap assertions need — read-only, never mutated here. */
interface MediatorInternals {
  readonly topics: Map<string, { remoteNodes: Set<string> }>;
  /** topic ↔ subscriber path (#1037) — local membership lives here now. */
  readonly subscriptions: BidirectionalMultiMap<string, string>;
  readonly subscriberRefs: Map<string, unknown>;
  handleGossip(
    message: { kind: 'pubsub-gossip'; from: unknown; entries: ReadonlyArray<string>; version: number },
    from: NodeAddress,
  ): void;
}

class Subscriber extends Actor<unknown> {
  override onReceive(): void {}
}

async function startNode(systemName: string, port: number): Promise<Node> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(systemName, kitOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { kit, cluster };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.kit.system.terminate();
}

/**
 * Spawn a mediator we hold the instance of.  The extension owns the one at
 * the well-known path and hands back only a ref, which is not enough to read
 * the topic map or drive gossip directly.
 */
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

/** Subscribe to the system's dead letters so an unrouted publish is visible. */
function watchDeadLetters(node: Node): TestProbe {
  const probe = node.kit.createTestProbe();
  node.kit.system.eventStream.subscribe(probe, DeadLetter);
  return probe;
}

describe('DistributedPubSub — subscriber and topic caps (#139)', () => {
  test('a Subscribe past maxSubscribersPerTopic is answered with SubscribeRejected', async () => {
    const node = await startNode('ps-cap-topic', 51401);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100)
      .withMaxSubscribersPerTopic(1);
    const mediator = await spawnMediator(node, 'capped-per-topic', mediatorOptions);

    const first = node.kit.createTestProbe();
    const second = node.kit.createTestProbe();
    mediator.ref.tell(new Subscribe('news', first, first));
    await first.expectMessageType(SubscribeAcknowledgment, 500);

    mediator.ref.tell(new Subscribe('news', second, second));
    const rejected = await second.expectMessageType(SubscribeRejected, 500);
    expect(rejected.topic).toBe('news');
    expect(rejected.reason).toBe('maxSubscribersPerTopic');
    expect(rejected.limit).toBe(1);

    // Refused means refused: a publish must not reach the second probe.
    mediator.ref.tell(new Publish('news', 'headline'));
    await first.expectMessage('headline', 500);
    await second.expectNoMessage(60);

    await stopNode(node);
  });

  test('a Subscribe to a new topic past maxTopics is answered with SubscribeRejected', async () => {
    const node = await startNode('ps-cap-topics', 51402);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100)
      .withMaxTopics(1);
    const mediator = await spawnMediator(node, 'capped-topics', mediatorOptions);

    const probe = node.kit.createTestProbe();
    mediator.ref.tell(new Subscribe('first-topic', probe, probe));
    await probe.expectMessageType(SubscribeAcknowledgment, 500);

    mediator.ref.tell(new Subscribe('second-topic', probe, probe));
    const rejected = await probe.expectMessageType(SubscribeRejected, 500);
    expect(rejected.reason).toBe('maxTopics');
    expect(rejected.limit).toBe(1);

    // Joining a topic that already exists still works — the cap is on how
    // many topics exist, not on how often the map is touched.
    const other = node.kit.createTestProbe();
    mediator.ref.tell(new Subscribe('first-topic', other, other));
    await other.expectMessageType(SubscribeAcknowledgment, 500);

    await stopNode(node);
  });

  test('gossiped topic claims are capped too — a peer cannot allocate topics at will', async () => {
    // The axis that needs no local Subscribe at all: `handleGossip` used to
    // create an entry for every topic name a peer sent.
    const node = await startNode('ps-cap-gossip', 51403);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100)
      .withMaxTopics(3);
    const mediator = await spawnMediator(node, 'capped-gossip', mediatorOptions);

    const peer = new NodeAddress('ps-cap-gossip', 'h', 51499);
    const flood = Array.from({ length: 500 }, (_, i) => `fake-topic-${i}`);
    mediator.internals.handleGossip(
      { kind: 'pubsub-gossip', from: peer.toJSON(), entries: flood, version: 1 },
      peer,
    );

    expect(mediator.internals.topics.size).toBe(3);

    await stopNode(node);
  });

  test('a stopped subscriber is dropped by death watch, freeing its slot', async () => {
    const node = await startNode('ps-death-watch', 51404);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100)
      .withMaxSubscribersPerTopic(1);
    const mediator = await spawnMediator(node, 'watched-mediator', mediatorOptions);

    const doomed = node.kit.system.spawn(Subscriber, 'doomed-subscriber');
    const waiting = node.kit.createTestProbe();
    // Mailbox order makes this deterministic — `doomed` takes the only slot.
    mediator.ref.tell(new Subscribe('watched', doomed));
    mediator.ref.tell(new Subscribe('watched', waiting, waiting));
    await waiting.expectMessageType(SubscribeRejected, 500);

    doomed.stop();

    // Retrying the subscribe *is* the probe for "the stopped subscriber is
    // gone" — there is no other observable, and a fixed sleep would guess.
    let accepted: unknown = null;
    await awaitCondition(async () => {
      mediator.ref.tell(new Subscribe('watched', waiting, waiting));
      const reply = await waiting.receiveOne(1_000);
      if (reply instanceof SubscribeAcknowledgment) { accepted = reply; return true; }
      return false;
    }, { timeoutMs: 4_000, intervalMs: 25, label: 'death watch released the stopped subscriber' });
    expect(accepted).toBeInstanceOf(SubscribeAcknowledgment);
    expect(mediator.internals.subscriptions.get('watched').size).toBe(1);
    // The stopped subscriber left nothing on either side (#1037): the slot
    // coming back proves only that the forward entry went.
    expect(mediator.internals.subscriptions.size).toBe(1);
    expect(mediator.internals.subscriberRefs.size).toBe(1);

    await stopNode(node);
  });

  test('Unsubscribe frees the slot the cap was holding', async () => {
    const node = await startNode('ps-cap-release', 51405);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100)
      .withMaxSubscribersPerTopic(1);
    const mediator = await spawnMediator(node, 'release-mediator', mediatorOptions);

    const holder = node.kit.createTestProbe();
    const waiting = node.kit.createTestProbe();
    mediator.ref.tell(new Subscribe('slot', holder, holder));
    await holder.expectMessageType(SubscribeAcknowledgment, 500);
    mediator.ref.tell(new Subscribe('slot', waiting, waiting));
    await waiting.expectMessageType(SubscribeRejected, 500);

    mediator.ref.tell(new Unsubscribe('slot', holder));
    mediator.ref.tell(new Subscribe('slot', waiting, waiting));
    await waiting.expectMessageType(SubscribeAcknowledgment, 500);

    await stopNode(node);
  });
});

describe('DistributedPubSub — dead letters for an unrouted publish (#857)', () => {
  test('a publish with no subscribers lands in dead letters', async () => {
    const node = await startNode('ps-dead-letters', 51406);
    const mediatorOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100);
    const mediator = await spawnMediator(node, 'dead-letter-mediator', mediatorOptions);
    const deadLetters = watchDeadLetters(node);

    mediator.ref.tell(new Publish('nobody-listens', 'orphan'));

    const deadLetter = await deadLetters.expectMessageType(DeadLetter, 1_000);
    expect(deadLetter.message).toBe('orphan');
    expect(deadLetter.recipient.path.toString()).toContain('dead-letter-mediator');

    await stopNode(node);
  });

  test('the toggle turns it off, and a delivered publish never dead-letters', async () => {
    const node = await startNode('ps-dead-letters-off', 51407);
    const silentOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100)
      .withSendToDeadLettersWhenNoSubscribers(false);
    const silent = await spawnMediator(node, 'silent-mediator', silentOptions);
    const deadLetters = watchDeadLetters(node);

    silent.ref.tell(new Publish('nobody-listens', 'orphan'));
    await deadLetters.expectNoMessage(120);

    // And with the default (on), a publish that *is* delivered stays quiet —
    // the escape hatch must not fire on the happy path.
    const loudOptions = DistributedPubSubOptions.create()
      .withCluster(node.cluster)
      .withGossipIntervalMs(100);
    const loud = await spawnMediator(node, 'loud-mediator', loudOptions);
    const subscriber = node.kit.createTestProbe();
    loud.ref.tell(new Subscribe('heard', subscriber, subscriber));
    await subscriber.expectMessageType(SubscribeAcknowledgment, 500);
    loud.ref.tell(new Publish('heard', 'delivered'));
    await subscriber.expectMessage('delivered', 500);
    await deadLetters.expectNoMessage(120);

    await stopNode(node);
  });
});
