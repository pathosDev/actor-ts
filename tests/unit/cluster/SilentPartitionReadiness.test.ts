import { describe, expect, test } from 'bun:test';
import {
  CLUSTER_TRANSPORT_CHECK_NAME,
  clusterTransportResult,
  transportReachesCluster,
} from '../../../src/cluster/ClusterHealthChecks.js';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame } from '../../../src/cluster/Protocol.js';
import type { MemberStatus } from '../../../src/cluster/Protocol.js';
import { TcpTransport } from '../../../src/cluster/Transport.js';
import { NoopLogger } from '../../../src/Logger.js';

/**
 * The `cluster-transport` readiness check versus the *canonical* partition
 * (#655).
 *
 * The check exists to answer "is this node cut off from the cluster it thinks
 * it belongs to", and it reads its evidence from `cluster.transport.peers()`.
 * That is a weaker signal than it looks:
 *
 *   - `TcpTransport.peers()` walks `byPeer` and lists every connection whose
 *     handshake completed;
 *   - `byPeer` is emptied by `onClose` (a FIN or an RST) and by `shutdown()`,
 *     and by nothing else — no code path in `src/` calls `disconnect()`;
 *   - an established, fully-idle connection arms no deadline at all.  The
 *     stall timer only exists while a *half-received* frame is outstanding.
 *
 * So the partition the framework's own integration harness installs —
 * `iptables -j DROP` in both directions, which is also what a lost switch, a
 * black-holed route or a silently wedged peer looks like — takes the traffic
 * away without producing a FIN or an RST.  The sockets stay in `byPeer`, and
 * `peers()` goes on reporting a peer nothing has been heard from.  The first
 * test below establishes that by execution rather than by reading, because it
 * is the premise everything after it rests on.
 *
 * Which is why the predicate cannot be "is a socket open".  It has to be "is
 * any peer I expect *both* connected and not yet written off", so that the
 * failure detector — the one component that does notice silence — is what
 * turns the check red.
 */

const self = new NodeAddress('silent', '127.0.0.1', 2_551);
const peerA = new NodeAddress('silent', '10.0.0.1', 2_551);
const peerB = new NodeAddress('silent', '10.0.0.2', 2_551);

function member(address: NodeAddress, status: MemberStatus): Member {
  return new Member(address, status, 1, new Set<string>());
}

type MockSocket = {
  ended: boolean;
  writes: Uint8Array[];
  write(data: Uint8Array): void;
  end(): void;
};

function mockSocket(): MockSocket {
  return {
    ended: false,
    writes: [],
    write(data: Uint8Array): void { this.writes.push(data); },
    end(): void { this.ended = true; },
  };
}

/** The private socket callbacks these tests drive, as the guard tests do. */
interface TransportInternals {
  attachInbound(socket: unknown): void;
  onData(socket: unknown, chunk: Uint8Array): void;
  onClose(socket: unknown): void;
}

function internals(transport: TcpTransport): TransportInternals {
  return transport as unknown as TransportInternals;
}

/** Accept a socket and drive its `hello` through, so the handshake completes. */
function handshake(transport: TcpTransport, peer: NodeAddress): MockSocket {
  const socket = mockSocket();
  internals(transport).attachInbound(socket);
  internals(transport).onData(socket, encodeFrame({ kind: 'hello', self: peer.toJSON() }));
  return socket;
}

describe('TcpTransport.peers() cannot see a silent partition', () => {
  test('a peer that stops sending — with no FIN and no RST — is still listed', async () => {
    const transport = new TcpTransport(self, new NoopLogger());
    const socket = handshake(transport, peerA);
    expect(transport.peers().map((p) => p.toString())).toEqual([peerA.toString()]);

    // The partition: every packet in both directions is dropped.  Nothing
    // arrives, nothing is closed, no callback fires.  Time passing changes
    // nothing either — an established connection carrying no half-received
    // frame has no deadline armed against it.
    expect(socket.ended).toBe(false);
    expect(transport.peers().map((p) => p.toString())).toEqual([peerA.toString()]);

    await transport.shutdown();
  });

  test('a partition that *does* close the socket is seen immediately', () => {
    // The contrast, and the only shape the old predicate could detect: a peer
    // that resets or a process that dies produces an `onClose`, and `byPeer`
    // drops it.
    const transport = new TcpTransport(self, new NoopLogger());
    const socket = handshake(transport, peerA);
    expect(transport.peers()).toHaveLength(1);

    internals(transport).onClose(socket);
    expect(transport.peers()).toEqual([]);
  });
});

describe('transportReachesCluster over a silent partition', () => {
  // The regression this file is really about: every peer has been written off
  // by the failure detector, the node cannot exchange a single message with
  // the cluster, and the sockets are all still there.  "A socket is open" is
  // not reachability.
  test('a connected peer the failure detector marked unreachable does not count', () => {
    expect(transportReachesCluster([member(self, 'up'), member(peerA, 'unreachable')], self, [peerA]))
      .toBe(false);
  });

  test('one peer that is both connected and reachable is enough', () => {
    const members = [member(self, 'up'), member(peerA, 'unreachable'), member(peerB, 'up')];
    // A partial partition must not empty the load balancer — this node is
    // still gossiping, converging and routing through `peerB`.
    expect(transportReachesCluster(members, self, [peerA, peerB])).toBe(true);
  });

  test('a connection to something that is not an expected member proves nothing', () => {
    // `peers()` also lists a `ClusterClient`'s inbound socket.  Counting it
    // would let an attached client keep a fully isolated node in rotation.
    const members = [member(self, 'up'), member(peerA, 'unreachable')];
    expect(transportReachesCluster(members, self, [peerB])).toBe(false);
  });

  /**
   * What the check still does **not** detect, stated as tests so the limits
   * are the documented ones rather than whatever falls out:
   *
   *  - the window before the failure detector fires.  The check inherits its
   *    latency, which is the same latency the rest of the cluster reacts on;
   *  - a one-way partition in which this node still *receives*.  Its peers go
   *    on looking `up`, so it goes on looking ready while nothing it sends
   *    arrives.  Detecting that needs an acknowledged round trip, which is a
   *    failure-detector change, not a readiness-check one.
   */
  test('a silent peer still believed up keeps the node ready — the detector\'s latency', () => {
    expect(transportReachesCluster([member(self, 'up'), member(peerA, 'up')], self, [peerA]))
      .toBe(true);
  });
});

describe('the transport check says which failure it is', () => {
  // Not the same operational story: "no socket at all" is a peer that went
  // away, "sockets open, nobody reachable" is a black hole.  An operator
  // reading `/ready` should not have to guess which one they have.
  test('a peer that went away reports no connection', () => {
    const result = clusterTransportResult([member(self, 'up'), member(peerA, 'up')], self, []);
    expect(result.name).toBe(CLUSTER_TRANSPORT_CHECK_NAME);
    expect(result.status).toBe(false);
    expect(result.detail).toContain('no transport connection');
    expect(result.detail).toContain('1 peer(s)');
  });

  test('a black hole reports connections that lead nowhere', () => {
    const result = clusterTransportResult(
      [member(self, 'up'), member(peerA, 'unreachable')], self, [peerA],
    );
    expect(result.status).toBe(false);
    expect(result.detail).toContain('1 connection(s) are still open');
    expect(result.detail).toContain('unreachable');
  });

  test('a healthy view carries no detail to explain', () => {
    const result = clusterTransportResult(
      [member(self, 'up'), member(peerA, 'up')], self, [peerA],
    );
    expect(result).toEqual({ name: CLUSTER_TRANSPORT_CHECK_NAME, status: true });
  });
});
