import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../src/ActorRef.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { MemberRemoved, MemberUp } from '../../../src/cluster/ClusterEvents.js';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Subscribe, SubscribeAcknowledgment } from '../../../src/cluster/pubsub/index.js';
import { DistributedPubSubMediator } from '../../../src/cluster/pubsub/DistributedPubSubMediator.js';
import {
  DistributedPubSubOptions,
  type DistributedPubSubOptionsBuilder,
} from '../../../src/cluster/pubsub/DistributedPubSubOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * #1193 — how a mediator's subscriber registry reaches the peers that need it.
 *
 * The registry only ever learns from a frame that arrives, so a node's claims
 * spread by being *sent*.  Two paths sent them and neither covered the case
 * that matters: `eagerGossip` broadcasts on a local subscribe, to whichever
 * peers happen to be up and listening at that instant, and `gossipTick` pushes
 * to one random peer per interval as anti-entropy.  A mediator whose peers
 * were not yet listening when it subscribed had therefore told nobody, and was
 * never asked again — until the coin landed.
 *
 * Every case here runs with a mediator gossip interval far longer than the
 * test, so nothing it observes can be owed to the periodic round.  That is the
 * point: the old code did converge eventually, and "eventually" is the defect.
 *
 * The mediator is spawned directly, as the anycast and cap suites do — the
 * claim sets live in a private map and the extension hands back only a ref.
 */

const SYSTEM = 'ps-membership';
const HOST = 'h';

/** Longer than any case here runs, so `gossipTick` cannot be the sender. */
const NO_ANTI_ENTROPY_MS = 600_000;

type Node = {
  readonly kit: TestKit;
  readonly cluster: Cluster;
  readonly transport: InMemoryTransport;
};

type Mediator = {
  readonly ref: ActorRef<unknown>;
  readonly internals: MediatorInternals;
};

/** Private surface — only the gossip entry point these cases drive. */
interface MediatorInternals {
  handleGossip(
    message: { kind: 'pubsub-gossip'; from: unknown; entries: ReadonlyArray<string>; version: number },
    from: NodeAddress,
  ): void;
}

/** A `pubsub-gossip` frame the mediator handed to the transport. */
type RecordedGossip = {
  readonly to: string;
  readonly entries: ReadonlyArray<string>;
};

async function startNode(port: number, seeds: ReadonlyArray<string>): Promise<Node> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(SYSTEM, kitOptions);
  const transport = new InMemoryTransport(new NodeAddress(SYSTEM, HOST, port));
  const clusterOptions = ClusterOptions.create()
    .withHost(HOST)
    .withPort(port)
    .withSeeds([...seeds])
    .withTransport(transport)
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(60)
    .withSeedRetryIntervalMs(60);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { kit, cluster, transport };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.kit.system.terminate();
}

async function spawnMediator(node: Node, name: string): Promise<Mediator> {
  const mediatorOptions: DistributedPubSubOptionsBuilder = DistributedPubSubOptions.create()
    .withCluster(node.cluster)
    .withGossipIntervalMs(NO_ANTI_ENTROPY_MS);
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
  await probe.expectMessageType(SubscribeAcknowledgment, 2_000);
}

/**
 * Record every gossip frame the mediator hands to the transport.
 *
 * Watching the send is the only observable these cases have: the peer is
 * either a claim with no mediator behind it or a second node that never
 * spawned one, and `InMemoryTransport.send` drops a frame for an address that
 * is not listening without a trace — which is, not by coincidence, the exact
 * failure mode the fix is about.
 */
function recordGossipFrames(transport: InMemoryTransport): RecordedGossip[] {
  const recorded: RecordedGossip[] = [];
  const send = transport.send.bind(transport);
  transport.send = (to: NodeAddress, message: WireMessage): void => {
    const frame = message as { kind: string; entries?: ReadonlyArray<string> };
    if (frame.kind === 'pubsub-gossip') {
      recorded.push({ to: to.toString(), entries: [...(frame.entries ?? [])] });
    }
    send(to, message);
  };
  return recorded;
}

/** As `handleGossip` sees a frame arriving from `peer`. */
function gossipFrom(mediator: Mediator, peer: NodeAddress, topics: string[]): void {
  mediator.internals.handleGossip(
    { kind: 'pubsub-gossip', from: peer.toJSON(), entries: topics, version: 1 },
    peer,
  );
}

describe('DistributedPubSub — the registry reaches a peer that joins later (#1193)', () => {
  test('a member reaching up is told this node topics, without waiting for a tick', async () => {
    const first = await startNode(51_601, []);
    const mediator = await spawnMediator(first, 'member-up');
    const frames = recordGossipFrames(first.transport);

    await subscribed(mediator, 'orders', first.kit.createTestProbe());

    // The precondition, asserted rather than assumed: alone in the cluster,
    // the subscribe-time broadcast has nobody to broadcast to.  This is the
    // state every node under `tests/integration/` passes through, and the one
    // the old code never revisited.
    expect(frames).toEqual([]);

    // A real join, because the mediator reads `upMembers()` — which is also
    // the ordering this depends on: `updateMember` writes the member before it
    // emits the event, so the new peer is already there when the arm runs.
    const second = await startNode(51_602, [`${SYSTEM}@${HOST}:51601`]);
    await awaitCondition(() => frames.length > 0, {
      timeoutMs: 5_000, intervalMs: 20,
      label: 'the joining member was told about the topic',
    });

    expect(frames[0]?.entries).toEqual(['orders']);
    expect(frames[0]?.to).toBe(second.cluster.selfAddress.toString());

    await stopNode(second);
    await stopNode(first);
    // A real join has to happen inside the budget, so the budget is above bun's
    // default per-test timeout and the test declares its own — see
    // `tests/unit/ci/AwaitConditionBudgets.test.ts`.
  }, 6_000);

  test('this node reaching up is not a peer to gossip to', async () => {
    // `cluster.subscribe` replays the membership it already has, self
    // included, so the arm runs for this node on every mediator start.  A
    // frame addressed here would enter this node as a *remote* claimant of its
    // own topics, which `remoteCandidatesOf` then has to filter back out.
    const node = await startNode(51_603, []);
    const mediator = await spawnMediator(node, 'member-up-self');
    const frames = recordGossipFrames(node.transport);

    await subscribed(mediator, 'orders', node.kit.createTestProbe());
    node.cluster._publishClusterEvent(new MemberUp(new Member(node.cluster.selfAddress, 'up', 1)));

    expect(frames).toEqual([]);

    await stopNode(node);
  });

  test('a peer first gossip is answered, and only its first', async () => {
    // The answer is what makes the exchange survive the ordering a broadcast
    // cannot: a node joins its cluster before it starts the extension that
    // registers the pub/sub wire hook, so anything aimed into that window is
    // dropped.  A frame that *arrives* proves the sender is listening, so
    // handing our state back along it always lands.
    const node = await startNode(51_604, []);
    const mediator = await spawnMediator(node, 'answer-once');
    const frames = recordGossipFrames(node.transport);

    await subscribed(mediator, 'orders', node.kit.createTestProbe());
    expect(frames).toEqual([]);

    const first = new NodeAddress(SYSTEM, HOST, 51_605);
    gossipFrom(mediator, first, ['news']);
    expect(frames).toEqual([{ to: first.toString(), entries: ['orders'] }]);

    // Answering every frame would double the steady gossip rate for no gain —
    // the peer already holds this state, and `gossipTick` is what corrects it
    // if it somehow does not.
    gossipFrom(mediator, first, ['news']);
    gossipFrom(mediator, first, ['news', 'weather']);
    expect(frames).toHaveLength(1);

    const second = new NodeAddress(SYSTEM, HOST, 51_606);
    gossipFrom(mediator, second, ['news']);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ to: second.toString(), entries: ['orders'] });

    await stopNode(node);
  });

  test('a peer that left and came back is answered again', async () => {
    // A rejoining node restarted with an empty registry, so treating it as
    // already answered would leave it exactly as blind as the bug this fixes —
    // and `12-pubsub-fanout` runs after two scenarios that make a node leave.
    const node = await startNode(51_607, []);
    const mediator = await spawnMediator(node, 'answer-rejoin');
    const frames = recordGossipFrames(node.transport);

    await subscribed(mediator, 'orders', node.kit.createTestProbe());

    const peer = new NodeAddress(SYSTEM, HOST, 51_608);
    gossipFrom(mediator, peer, ['news']);
    expect(frames).toHaveLength(1);

    node.cluster._publishClusterEvent(new MemberRemoved(new Member(peer, 'removed', 2)));
    gossipFrom(mediator, peer, ['news']);

    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ to: peer.toString(), entries: ['orders'] });

    await stopNode(node);
  });
});
