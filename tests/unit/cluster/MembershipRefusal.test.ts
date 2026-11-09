/**
 * #940 — a node the cluster removed learns of it and takes itself out.
 *
 * Reported from a downstream deployment: a node paused past the downing window
 * (SIGSTOP, a suspended VM, a long GC pause) was removed by the majority, which
 * took its shards and singleton over; on resume it went on running them. The
 * survivors acknowledged its heartbeats, the acknowledgment counted as
 * liveness, so the node never saw the peers that had removed it as anything
 * but healthy — no partition for its downing provider to decide on, and no
 * `SelfRemoved`.
 *
 * Both halves are driven here through `handleWire`, the entry point every
 * transport calls, with the periodic ticks pushed past the test's lifetime and
 * `failureDetectionTick` called by hand:
 *
 * - the survivor answers a heartbeat from the run it holds as `removed` with a
 *   `membership-refused`, and still acknowledges any other run at the address;
 * - the removed node parks a refusing peer at `unreachable`, credits nothing it
 *   sends, and — once every peer refuses it — asks its own provider at once,
 *   which ends in `removed` and `SelfRemoved`;
 * - a refusal is never a claim about the node's own status, and the real peer's
 *   gossip withdraws a forged one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { MemberRemoved, SelfRemoved, type ClusterEvent } from '../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { KeepMajority, type DowningProvider } from '../../../src/cluster/downing/index.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, MemberStatus, WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/** Self sorts below every peer, so the leader never moves while a test runs. */
const SELF_HOST = '10.0.148.1';
const PEER_HOSTS = ['10.0.148.2', '10.0.148.3'] as const;

/** The private surface these tests drive — the wire entry point and the detection tick, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
  failureDetectionTick(): void;
  readonly members: Map<string, Member>;
}

const internals = (cluster: Cluster): ClusterInternals => cluster as unknown as ClusterInternals;

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly sent: WireMessage[];
  readonly events: ClusterEvent[];
};

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

/**
 * A one-node cluster that records what it sends and what it announces. The
 * stability window is left at its shipped 20 s, so a decision inside a test is
 * one that did not wait for it.
 */
async function startNode(systemName: string, port: number, downing?: DowningProvider): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new InMemoryTransport(address);
  const sent: WireMessage[] = [];
  const send = transport.send.bind(transport);
  transport.send = (to: NodeAddress, message: WireMessage): void => {
    sent.push(message);
    send(to, message);
  };
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(transport)
    .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 2_000, downAfterMs: 5_000 })
    .withGossipIntervalMs(60_000)
    .withPublishStatsIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000)
    .withRunCoordinatedShutdownWhenDown(false);
  if (downing !== undefined) clusterOptions.withDowning(downing);
  const cluster = await Cluster.join(system, clusterOptions);
  const events: ClusterEvent[] = [];
  cluster.subscribe((event) => events.push(event), { replayMode: 'snapshot' });
  events.length = 0;
  const node = { system, cluster, sent, events };
  nodes.push(node);
  return node;
}

const peerRun = (systemName: string, index: number, port: number, incarnation: string): NodeAddress =>
  new NodeAddress(systemName, PEER_HOSTS[index]!, port, incarnation);

let lastSequence = Date.now();
const nextSequence = (): number => {
  lastSequence += 1;
  return lastSequence;
};

function gossip(cluster: Cluster, sender: NodeAddress, members: MemberData[]): void {
  internals(cluster).handleWire(sender, {
    kind: 'gossip', from: sender.toJSON(), sequence: nextSequence(), members,
  });
}

/** `run` announces itself `up` — a peer's ordinary gossip about itself. */
function announce(cluster: Cluster, run: NodeAddress): void {
  gossip(cluster, run, [{ address: run.toJSON(), status: 'up', version: Date.now(), roles: [] }]);
}

let lastHeartbeat = 0;
function heartbeat(cluster: Cluster, run: NodeAddress): void {
  lastHeartbeat += 1;
  internals(cluster).handleWire(run, { kind: 'heartbeat', from: run.toJSON(), seq: lastHeartbeat, ts: Date.now() });
}

function refuse(cluster: Cluster, peer: NodeAddress, subject: NodeAddress): void {
  internals(cluster).handleWire(peer, { kind: 'membership-refused', from: peer.toJSON(), subject: subject.toJSON() });
}

const statusOf = (cluster: Cluster, peer: NodeAddress): MemberStatus | undefined =>
  internals(cluster).members.get(peer.toString())?.status;

const repliesOfKind = (node: NodeHandle, kind: WireMessage['kind']): WireMessage[] =>
  node.sent.filter((message) => message.kind === kind);

describe('the survivor answers the run it removed with a refusal (#940)', () => {
  test('a heartbeat from the removed run gets membership-refused, naming that run, and no acknowledgment', async () => {
    const node = await startNode('refusal-survivor', 9_481);
    const run = peerRun('refusal-survivor', 0, 9_482, 'run-1');
    announce(node.cluster, run);
    expect(node.cluster.down(run)).toBe(true);
    node.sent.length = 0;

    heartbeat(node.cluster, run);

    expect(repliesOfKind(node, 'heartbeat-ack')).toEqual([]);
    const refusals = repliesOfKind(node, 'membership-refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      kind: 'membership-refused',
      subject: { host: run.host, port: run.port, incarnation: 'run-1' },
    });
  });

  test('a restart at the address is a different run, and is acknowledged as before', async () => {
    const node = await startNode('refusal-restart', 9_483);
    const run = peerRun('refusal-restart', 0, 9_484, 'run-1');
    announce(node.cluster, run);
    node.cluster.down(run);
    node.sent.length = 0;

    heartbeat(node.cluster, peerRun('refusal-restart', 0, 9_484, 'run-2'));

    expect(repliesOfKind(node, 'membership-refused')).toEqual([]);
    expect(repliesOfKind(node, 'heartbeat-ack')).toHaveLength(1);
  });

  test('a peer that sends no incarnation cannot be pinned, and is acknowledged as before', async () => {
    const node = await startNode('refusal-no-incarnation', 9_485);
    const run = new NodeAddress('refusal-no-incarnation', PEER_HOSTS[0], 9_486);
    announce(node.cluster, run);
    node.cluster.down(run);
    node.sent.length = 0;

    heartbeat(node.cluster, run);

    expect(repliesOfKind(node, 'membership-refused')).toEqual([]);
    expect(repliesOfKind(node, 'heartbeat-ack')).toHaveLength(1);
  });

  test('a member that was not removed is acknowledged as before', async () => {
    const node = await startNode('refusal-member', 9_487);
    const run = peerRun('refusal-member', 0, 9_488, 'run-1');
    announce(node.cluster, run);
    node.sent.length = 0;

    heartbeat(node.cluster, run);

    expect(repliesOfKind(node, 'membership-refused')).toEqual([]);
    expect(repliesOfKind(node, 'heartbeat-ack')).toHaveLength(1);
  });
});

describe('the removed node takes a refusal as a fact about the peer, never about itself (#940)', () => {
  test('the refusing peer is parked at unreachable and stays there through its later heartbeats', async () => {
    const node = await startNode('refused-parks', 9_491);
    const peer = peerRun('refused-parks', 0, 9_492, 'run-1');
    announce(node.cluster, peer);
    expect(statusOf(node.cluster, peer)).toBe('up');

    refuse(node.cluster, peer, node.cluster.selfAddress);
    expect(statusOf(node.cluster, peer)).toBe('unreachable');

    // A heartbeat queued before the peer removed this node — the frames a
    // paused process reads first on resume — used to flip it straight back.
    for (let frame = 0; frame < 3; frame++) heartbeat(node.cluster, peer);
    expect(statusOf(node.cluster, peer)).toBe('unreachable');
    // And its own record is untouched: the refusal is not a status claim.
    expect(node.cluster.selfMember()?.status).toBe('up');
  });

  test('a refusal naming another run at this address is ignored', async () => {
    const node = await startNode('refused-other-run', 9_493);
    const peer = peerRun('refused-other-run', 0, 9_494, 'run-1');
    announce(node.cluster, peer);
    const self = node.cluster.selfAddress;

    refuse(node.cluster, peer, new NodeAddress(self.systemName, self.host, self.port, 'an-earlier-run'));
    refuse(node.cluster, peer, new NodeAddress(self.systemName, self.host, self.port));

    expect(statusOf(node.cluster, peer)).toBe('up');
  });

  test('a refusal from a connection that is not a member is ignored', async () => {
    const node = await startNode('refused-stranger', 9_495);
    const stranger = peerRun('refused-stranger', 0, 9_496, 'run-1');

    refuse(node.cluster, stranger, node.cluster.selfAddress);

    expect(statusOf(node.cluster, stranger)).toBeUndefined();
    expect(node.cluster.selfMember()?.status).toBe('up');
  });

  test('the real peer gossiping this run as a member withdraws a forged refusal', async () => {
    const node = await startNode('refused-withdrawn', 9_497);
    const peer = peerRun('refused-withdrawn', 0, 9_498, 'run-1');
    announce(node.cluster, peer);
    refuse(node.cluster, peer, node.cluster.selfAddress);
    expect(statusOf(node.cluster, peer)).toBe('unreachable');

    // A peer that really removed this node never gossips to it.
    gossip(node.cluster, peer, [
      { address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] },
      node.cluster.selfMember()!.toData(),
    ]);
    heartbeat(node.cluster, peer);

    expect(statusOf(node.cluster, peer)).toBe('up');
  });
});

describe('every peer refusing is a settled view: the provider is asked at once (#940)', () => {
  test('KeepMajority downs a node every peer refuses, which ends in removed and SelfRemoved', async () => {
    const node = await startNode('refused-by-all', 9_501, new KeepMajority());
    const peers = [peerRun('refused-by-all', 0, 9_502, 'run-1'), peerRun('refused-by-all', 1, 9_503, 'run-1')];
    for (const peer of peers) announce(node.cluster, peer);

    for (const peer of peers) refuse(node.cluster, peer, node.cluster.selfAddress);
    // One detection round, not twenty seconds of them: the shipped window is
    // what a merely silent peer is held to.
    internals(node.cluster).failureDetectionTick();

    await awaitCondition(() => node.events.some((event) => event instanceof SelfRemoved), {
      timeoutMs: 2_000, label: 'SelfRemoved was announced',
    });
    expect(node.cluster.selfMember()?.status).toBe('removed');
    const ownRemovals = node.events.filter((event) =>
      event instanceof MemberRemoved && event.member.address.equals(node.cluster.selfAddress));
    expect(ownRemovals).toHaveLength(1);
    expect(node.events.filter((event) => event instanceof SelfRemoved)).toHaveLength(1);
  });

  test('one refusing peer of two is a partition like any other, held to the stability window', async () => {
    const node = await startNode('refused-by-one', 9_505, new KeepMajority());
    const peers = [peerRun('refused-by-one', 0, 9_506, 'run-1'), peerRun('refused-by-one', 1, 9_507, 'run-1')];
    for (const peer of peers) announce(node.cluster, peer);

    refuse(node.cluster, peers[0]!, node.cluster.selfAddress);
    for (let round = 0; round < 5; round++) internals(node.cluster).failureDetectionTick();

    expect(node.events.some((event) => event instanceof SelfRemoved)).toBe(false);
    expect(node.cluster.selfMember()?.status).toBe('up');
  });
});
