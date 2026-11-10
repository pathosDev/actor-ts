/**
 * #857 — the `actor-ts.cluster.pub-sub.*` leaves, driven through the entry
 * point an application actually calls: `DistributedPubSub.start`.
 *
 * The reader test proves each leaf parses, and the caps suites spawn their
 * mediators with builder options.  Neither passes through the layer between
 * the two — the extension merging `readDistributedPubSubOptionsFromConfig`
 * under the caller's options — so dropping that layer left every test green
 * while every pub-sub key in a deployment's HOCON silently stopped applying.
 * The receptionist has had this end-to-end shape since its caps landed
 * (`ReceptionistSubscriberCaps.test.ts`); this is the mediator's.
 *
 * Every node runs on a {@link ManualScheduler}.  The gossip cases count timer
 * ticks, which only virtual time can do exactly; the dead-letter cases need no
 * time at all, because absence is shown by mailbox order rather than by a wait
 * (see {@link publishUnroutedThenSentinel}).
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import {
  DistributedPubSubId,
  DistributedPubSubOptions,
  Publish,
  Subscribe,
  SubscribeAcknowledgment,
  type MediatorMessage,
} from '../../../src/cluster/pubsub/index.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const HOST = 'h';
/** The observer's own topic; a publish to it is the sentinel. */
const PRESENT_TOPIC = 'present';
const SENTINEL = 'sentinel';
const UNROUTED_TOPIC = 'nobody-subscribed';

/** A frame the node handed to its transport: what kind, and where to. */
type RecordedFrame = {
  readonly kind: string;
  readonly to: string;
};

type Node = {
  readonly system: ActorSystem;
  readonly scheduler: ManualScheduler;
  readonly cluster: Cluster;
  readonly frames: RecordedFrame[];
};

type Mediator = {
  readonly ref: ActorRef<MediatorMessage>;
  /** Everything the observer received, in arrival order: acknowledgments, topic messages, dead letters. */
  readonly received: unknown[];
};

/** The private surface these cases reach through: the entry point a peer's frame takes, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
}

/** Keeps every message it receives, so a case can read the order they came in. */
class Observer extends Actor<unknown> {
  constructor(private readonly received: unknown[]) { super(); }
  override onReceive(message: unknown): void { this.received.push(message); }
}

/**
 * Record every frame the node hands to its transport before passing it on.
 * The peer these cases gossip to is a claim with no process behind it, and
 * `InMemoryTransport.send` drops a frame for an address nobody listens on, so
 * the send is the one place a gossip push can be observed.
 */
function recordFrames(transport: InMemoryTransport): RecordedFrame[] {
  const recorded: RecordedFrame[] = [];
  const send = transport.send.bind(transport);
  transport.send = (to: NodeAddress, message: WireMessage): void => {
    recorded.push({ kind: message.kind, to: to.toString() });
    send(to, message);
  };
  return recorded;
}

async function startNode(systemName: string, port: number, hocon?: string): Promise<Node> {
  const scheduler = new ManualScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler);
  if (hocon !== undefined) systemOptions.withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new InMemoryTransport(new NodeAddress(systemName, HOST, port));
  const frames = recordFrames(transport);
  const clusterOptions = ClusterOptions.create()
    .withHost(HOST)
    .withPort(port)
    .withTransport(transport)
    // Far past every case, so the detector never takes the peer out of `upMembers()`.
    .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 120_000, downAfterMs: 240_000 });
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, scheduler, cluster, frames };
}

async function stopNode(node: Node): Promise<void> {
  try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
  await node.system.terminate();
}

/**
 * A peer announcing itself `up` in its own gossip frame, which is the one claim
 * `maySpeakFor` never refuses.  From then on it is in `upMembers()`, the set
 * the mediator gossips to.
 */
function introducePeer(node: Node, port: number): NodeAddress {
  const peer = new NodeAddress(node.system.name, HOST, port);
  const stamp = Date.now();
  (node.cluster as unknown as ClusterInternals).handleWire(peer, {
    kind: 'gossip',
    from: peer.toJSON(),
    sequence: stamp,
    members: [{ address: peer.toJSON(), status: 'up', version: stamp, roles: [] }],
  });
  return peer;
}

/**
 * Start the mediator through the extension, with an observer that sees dead
 * letters and holds a subscription of its own.  Returns once that subscription
 * is acknowledged: the mediator is past `preStart`, so its gossip timer is
 * armed at the scheduler's current instant, which every gossip case counts from.
 */
async function startMediator(node: Node, options?: DistributedPubSubOptions): Promise<Mediator> {
  const extension = node.system.extension(DistributedPubSubId);
  const ref = options === undefined ? extension.start(node.cluster) : extension.start(node.cluster, options);
  const received: unknown[] = [];
  const observer = node.system.spawnAnonymous(() => new Observer(received));
  node.system.eventStream.subscribe(observer, DeadLetter);
  ref.tell(new Subscribe(PRESENT_TOPIC, observer, observer));
  await awaitCondition(() => received.some((message) => message instanceof SubscribeAcknowledgment), {
    label: 'the mediator acknowledged the observer subscription',
  });
  return { ref, received };
}

/**
 * Publish `body` to a topic nobody subscribed to, then the sentinel to the
 * observer's own topic, and wait for the sentinel.
 *
 * The dead-letter office publishes onto the event stream synchronously, and the
 * event stream `tell`s its subscribers synchronously, so a dead letter for the
 * first publish is in the observer's mailbox before the mediator has read the
 * second.  The sentinel arriving therefore proves the first publish was
 * handled: whatever dead letter it was going to produce has already arrived.
 */
async function publishUnroutedThenSentinel(mediator: Mediator, body: string): Promise<void> {
  mediator.ref.tell(new Publish(UNROUTED_TOPIC, body));
  mediator.ref.tell(new Publish(PRESENT_TOPIC, SENTINEL));
  await awaitCondition(() => mediator.received.includes(SENTINEL), {
    label: 'the sentinel publish reached the observer',
  });
}

/**
 * The bodies of the dead letters the observer received.  Bodies rather than
 * the letters themselves, so a failure prints a short list instead of every
 * ref a letter holds.
 */
function deadLetteredBodies(mediator: Mediator): unknown[] {
  return mediator.received
    .filter((message): message is DeadLetter => message instanceof DeadLetter)
    .map((letter) => letter.message);
}

function framesOfKind(node: Node, kind: string): RecordedFrame[] {
  return node.frames.filter((frame) => frame.kind === kind);
}

describe('DistributedPubSub.start applies actor-ts.cluster.pub-sub.* (#857)', () => {
  test('send-to-dead-letters-when-no-subscribers = off silences an unrouted publish', async () => {
    const node = await startNode('pubsub-config-silenced', 64_711,
      'actor-ts.cluster.pub-sub.send-to-dead-letters-when-no-subscribers = off');
    const mediator = await startMediator(node);

    await publishUnroutedThenSentinel(mediator, 'orphan-silenced');

    expect(deadLetteredBodies(mediator)).not.toContain('orphan-silenced');

    await stopNode(node);
  });

  test('an explicit option outranks the HOCON leaf', async () => {
    const node = await startNode('pubsub-config-explicit', 64_712,
      'actor-ts.cluster.pub-sub.send-to-dead-letters-when-no-subscribers = off');
    const pubSubOptions = DistributedPubSubOptions.create().withSendToDeadLettersWhenNoSubscribers(true);
    const mediator = await startMediator(node, pubSubOptions);

    await publishUnroutedThenSentinel(mediator, 'orphan-routed');

    // Also the control for the case above: the same observer and the same
    // mailbox order, and here the dead letter is in it.
    expect(deadLetteredBodies(mediator).filter((body) => body === 'orphan-routed')).toEqual(['orphan-routed']);

    await stopNode(node);
  });

  test('pub-sub.gossip-interval paces the mediator gossip', async () => {
    const node = await startNode('pubsub-config-interval', 64_713,
      'actor-ts.cluster.pub-sub.gossip-interval = 250ms');
    introducePeer(node, 64_714);
    await startMediator(node);
    // The pushes so far are the eager ones a subscribe and a member reaching
    // `up` set off.  Only the timer adds to them from here.
    const before = framesOfKind(node, 'pubsub-gossip').length;

    node.scheduler.advance(249);
    expect(framesOfKind(node, 'pubsub-gossip').length).toBe(before);
    node.scheduler.advance(1);
    expect(framesOfKind(node, 'pubsub-gossip').length).toBe(before + 1);
    node.scheduler.advance(750);
    expect(framesOfKind(node, 'pubsub-gossip').length).toBe(before + 4);

    await stopNode(node);
  });

  test('the cluster gossip-interval does not pace it', async () => {
    // The mediator has a timer of its own, at its own key's 1 s default, and
    // does not follow the cluster's cadence.
    const node = await startNode('pubsub-config-own-timer', 64_715,
      'actor-ts.cluster.gossip-interval = 100ms');
    introducePeer(node, 64_716);
    await startMediator(node);
    const pubSubBefore = framesOfKind(node, 'pubsub-gossip').length;
    const clusterBefore = framesOfKind(node, 'gossip').length;

    node.scheduler.advance(999);

    // Time did pass on this node: the cluster pushed its nine rounds meanwhile.
    expect(framesOfKind(node, 'gossip').length - clusterBefore).toBe(9);
    expect(framesOfKind(node, 'pubsub-gossip').length).toBe(pubSubBefore);
    node.scheduler.advance(1);
    expect(framesOfKind(node, 'pubsub-gossip').length).toBe(pubSubBefore + 1);

    await stopNode(node);
  });
});
