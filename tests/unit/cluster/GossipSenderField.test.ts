/**
 * #939 — a gossip frame's payload `from` filed a member with no authority check.
 *
 * `onGossip` ended with a door that added the payload's `from` as `joining`
 * whenever this node held no record of it — outside `mergeMember`, so with no
 * `maySpeakFor`, and keyed on a field the sender writes rather than on the
 * connection it arrived on.  One frame naming a low-sorting address made it a
 * member; the leader promoted it, `leader()` moved to a node that does not
 * exist, and `isLeader()` went false on the real leader — which stops the shard
 * coordinator and misplaces the singleton.  And a member is an address the
 * heartbeat and gossip ticks dial, so the same frame made this node connect
 * wherever it said (#936).
 *
 * The door is gone.  A sender is introduced by its own record, merged as a
 * self-announcement held to the connection's identity, like any other.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport, type Transport } from '../../../src/cluster/Transport.js';
import { sleep } from '../../util/AwaitCondition.js';

/** The private surface these tests reach through — the wire entry, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

type NodeSettings = {
  readonly transport?: Transport;
  /** Gossip and heartbeat every 50 ms, so a member would be dialled within the test. */
  readonly live?: boolean;
};

let nodes: NodeHandle[] = [];
let closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  for (const close of closers) await close();
  nodes = [];
  closers = [];
});

/** A single-node cluster that elected itself, so it is its own leader. */
async function startNode(systemName: string, host: string, port: number, settings: NodeSettings = {}): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, host, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port);
  if (settings.live === true) {
    clusterOptions
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 120_000, downAfterMs: 240_000 })
      .withGossipIntervalMs(50);
  } else {
    clusterOptions
      .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 120_000, downAfterMs: 240_000 })
      .withGossipIntervalMs(60_000);
  }
  if (settings.transport !== undefined) clusterOptions.withTransport(settings.transport);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, address };
  nodes.push(node);
  return node;
}

/**
 * Strictly increasing, because the replay guard keys on the connection: a
 * second frame on it with the same sequence would be refused as a recording
 * before the sender field was ever read (#112).
 */
let nextSequence = Date.now();

/** A gossip frame whose payload claims to come from `claimedSender`. */
function gossipNaming(claimedSender: NodeAddress, members: ReadonlyArray<MemberData> = []): WireMessage {
  nextSequence += 1;
  return { kind: 'gossip', from: claimedSender.toJSON(), sequence: nextSequence, members: [...members] };
}

/** A plain TCP listener that only counts the connections it is offered. */
async function countingListener(): Promise<{ readonly port: number; readonly connections: () => number }> {
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('listener has no port');
  return { port: address.port, connections: () => connections };
}

function inMemoryNode(systemName: string, port: number): Promise<NodeHandle> {
  return startNode(systemName, 'h', port, { transport: new InMemoryTransport(new NodeAddress(systemName, 'h', port)) });
}

describe("a gossip frame's sender field files no member (#939)", () => {
  test('a frame naming a low-sorting phantom leaves the leader where it was', async () => {
    const node = await inMemoryNode('sender-field-leader', 47_501);
    expect(node.cluster.isLeader()).toBe(true);
    const leaderBefore = node.cluster.leader();
    const membersBefore = node.cluster.getMembers().length;
    // Sorts below every real address, so as a member it would be the leader.
    const phantom = new NodeAddress('sender-field-leader', '0.0.0.0', 1);
    const connection = new NodeAddress('sender-field-leader', 'h', 47_502);

    internals(node.cluster).handleWire(connection, gossipNaming(phantom));

    expect(node.cluster.getMembers().some((m) => m.address.equals(phantom))).toBe(false);
    expect(node.cluster.getMembers()).toHaveLength(membersBefore);
    expect(node.cluster.isLeader()).toBe(true);
    expect(node.cluster.leader()).toEqual(leaderBefore);
  });

  test('a member with standing cannot file a phantom through the sender field either', async () => {
    // Standing lets an active member gossip third-party *records*; the
    // sender field is not a record, and it never was a way to speak for anyone.
    const node = await inMemoryNode('sender-field-standing', 47_511);
    const member = new NodeAddress('sender-field-standing', 'h', 47_512);
    const record: MemberData = { address: member.toJSON(), status: 'up', version: Date.now(), roles: [] };
    internals(node.cluster).handleWire(member, gossipNaming(member, [record]));
    expect(node.cluster.getMembers().some((m) => m.address.equals(member))).toBe(true);
    const phantom = new NodeAddress('sender-field-standing', '0.0.0.0', 1);

    internals(node.cluster).handleWire(member, gossipNaming(phantom));

    expect(node.cluster.getMembers().some((m) => m.address.equals(phantom))).toBe(false);
    expect(node.cluster.isLeader()).toBe(true);
  });

  test('a joiner is still introduced by its own record', async () => {
    const node = await inMemoryNode('sender-field-joiner', 47_521);
    const joiner = new NodeAddress('sender-field-joiner', 'h', 47_522);
    const record: MemberData = { address: joiner.toJSON(), status: 'joining', version: Date.now(), roles: ['worker'] };

    internals(node.cluster).handleWire(joiner, gossipNaming(joiner, [record]));

    const stored = node.cluster.getMembers().find((m) => m.address.equals(joiner));
    expect(stored).toBeDefined();
    expect(Array.from(stored!.roles)).toEqual(['worker']);
  });

  test('over TCP, the ticks never connect to an address a frame only named', async () => {
    const listener = await countingListener();
    const node = await startNode('sender-field-dial', '127.0.0.1', 47_531, { live: true });
    const phantom = new NodeAddress('sender-field-dial', '127.0.0.1', listener.port);
    const connection = new NodeAddress('sender-field-dial', '10.0.93.9', 2552);

    internals(node.cluster).handleWire(connection, gossipNaming(phantom));

    // The elapsed time IS the assertion: eight heartbeat and gossip intervals,
    // each of which would dial a member on loopback well inside its 50 ms.
    await sleep(400);
    expect(listener.connections()).toBe(0);
    expect(node.cluster.getMembers().some((m) => m.address.equals(phantom))).toBe(false);
  });
});
