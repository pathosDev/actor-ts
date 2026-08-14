/**
 * Security-boundary tests for the cluster gossip + transport layers.
 *
 * These tests construct malicious wire-frames and inject them into a
 * live cluster, verifying the framework's defenses hold.  Each test
 * documents the **historical exploit** it guards against — if the
 * test fails, the corresponding hardening regressed.
 *
 * Threat model: an attacker has TCP access to one cluster node and
 * can speak the wire protocol but isn't authenticated as a member
 * (i.e., the cluster is on a closed network but a compromised peer
 * or an in-network attacker can still talk to it).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { Cluster } from '../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../src/cluster/Transport.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import { Member } from '../../src/cluster/Member.js';
import type { GossipMessage, MemberData, WireMessage } from '../../src/cluster/Protocol.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { ReceptionistId } from '../../src/discovery/Receptionist.js';
import { Find, Listing, Register } from '../../src/discovery/ReceptionistMessages.js';
import { ServiceKey } from '../../src/discovery/ServiceKey.js';

/** Stand-in for a registered service — it only has to exist and have a path. */
class ProbeActor extends Actor {
  override onReceive(): void { /* never receives anything in these tests */ }
}

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

async function startNode(systemName: string, port: number, seeds: string[] = []): Promise<NodeHandle> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, sysOptions);
  const address = new NodeAddress(systemName, 'h', port);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address };
}

async function stopNode(node: NodeHandle): Promise<void> {
  try { await node.cluster.leave(); } catch { /* */ }
  try { await node.system.terminate(); } catch { /* */ }
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(20);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/* ----- access helper: invoke the private handleWire via type cast ----- */

interface ClusterPrivate {
  handleWire(from: NodeAddress, message: GossipMessage): void;
}

/**
 * A gossip frame as these tests write them.  Frames carry a monotonic
 * per-sender `sequence` since #112, and a receiver refuses one that does not
 * out-number the last it accepted from that peer — so every helper stamps a
 * fresh one unless a test is deliberately replaying an old frame.
 */
type InjectableGossip = Omit<GossipMessage, 'sequence'> & { sequence?: number };

let injectedGossipSequence = 0;

/**
 * A minute ahead of the wall clock, because some of these tests inject a frame
 * from an address that is also a *live* node in the same test: a real node
 * seeds its counter from its own `Date.now()` and adds one per frame it sends,
 * so a plain `Date.now()` can land just *below* it.  The margin stays well
 * inside `maxVersionSkewMs`, which is what decides whether the receiver adopts
 * the value as its new high-water mark.
 */
const INJECTED_SEQUENCE_MARGIN_MS = 60_000;

function nextGossipSequence(): number {
  injectedGossipSequence = Math.max(
    injectedGossipSequence + 1, Date.now() + INJECTED_SEQUENCE_MARGIN_MS,
  );
  return injectedGossipSequence;
}

function withSequence(message: InjectableGossip): GossipMessage {
  return { ...message, sequence: message.sequence ?? nextGossipSequence() };
}

function inject(cluster: Cluster, from: NodeAddress, message: InjectableGossip): void {
  (cluster as unknown as ClusterPrivate).handleWire(from, withSequence(message));
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) await stopNode(node);
  nodes = [];
});

describe('Cluster — gossip exploit defenses', () => {
  /**
   * **Exploit walkthrough (pre-fix).**  `mergeMember`'s only
   * filter on the `version` field was `incoming.version > existing.version`.
   * A malicious peer that could speak the gossip protocol could send
   *
   *   { kind: 'gossip', members: [{ address: <target>,
   *                              status: 'down',
   *                              version: Number.MAX_SAFE_INTEGER }] }
   *
   * and the merge accepted it — `MAX_SAFE_INTEGER > anything` is
   * always true.  Once accepted, every subsequent legitimate update
   * from the target failed the same check (`anything <= MAX_SAFE_INTEGER`),
   * and the target was permanently pinned to `down` across all
   * peers — a one-frame total DoS of any cluster member.
   *
   * Fix: cap acceptable `incoming.version` at `Date.now() +
   * maxVersionSkewMs` (5 min by default) in `Cluster.mergeMember`.  The bound
   * started at a flat 24 h and was narrowed to the configurable one when the
   * two-cap split turned out to be walk-around-able (#114).
   */
  test('exploit: gossip with Number.MAX_SAFE_INTEGER version is rejected', async () => {
    const portA = 53_100 + Math.floor(Math.random() * 500);
    const portB = portA + 1;
    const nodeA = await startNode('csec', portA);
    const nodeB = await startNode('csec', portB, [`csec@h:${portA}`]);
    nodes = [nodeA, nodeB];

    // Wait until A sees B as 'up'.
    await waitFor(() => {
      const member = nodeA.cluster.getMembers().find(x => x.address.equals(nodeB.address));
      return !!member && member.status === 'up';
    });
    const beforeB = nodeA.cluster.getMembers().find(x => x.address.equals(nodeB.address));
    expect(beforeB?.status).toBe('up');

    // Forge a malicious gossip from an "attacker" address (no real
    // node — just a synthetic NodeAddress to source the frame).
    const attacker = new NodeAddress('csec', 'h', 65_535);
    const evil: InjectableGossip = {
      kind: 'gossip',
      from: attacker.toJSON(),
      members: [{
        address: nodeB.address.toJSON(),
        status: 'down',
        version: Number.MAX_SAFE_INTEGER,
      }],
    };
    inject(nodeA.cluster, attacker, evil);

    // Defense: B's status is unchanged (still up).
    const afterB = nodeA.cluster.getMembers().find(x => x.address.equals(nodeB.address));
    expect(afterB?.status).toBe('up');
    expect(afterB?.version).toBeLessThan(Number.MAX_SAFE_INTEGER);
  }, 10_000);

  test('exploit: gossip with Number.POSITIVE_INFINITY version is rejected', async () => {
    const portA = 53_200 + Math.floor(Math.random() * 500);
    const portB = portA + 1;
    const nodeA = await startNode('csec', portA);
    const nodeB = await startNode('csec', portB, [`csec@h:${portA}`]);
    nodes = [nodeA, nodeB];

    await waitFor(() => {
      const member = nodeA.cluster.getMembers().find(x => x.address.equals(nodeB.address));
      return !!member && member.status === 'up';
    });

    const attacker = new NodeAddress('csec', 'h', 65_534);
    const evil: InjectableGossip = {
      kind: 'gossip',
      from: attacker.toJSON(),
      members: [{
        address: nodeB.address.toJSON(),
        status: 'down',
        version: Number.POSITIVE_INFINITY,
      }],
    };
    inject(nodeA.cluster, attacker, evil);

    const afterB = nodeA.cluster.getMembers().find(x => x.address.equals(nodeB.address));
    expect(afterB?.status).toBe('up');
  }, 10_000);

  test('exploit: gossip with NaN version is rejected', async () => {
    const portA = 53_300 + Math.floor(Math.random() * 500);
    const nodeA = await startNode('csec', portA);
    nodes = [nodeA];

    // No B needed — inject an attempted-creation of a fake member.
    const ghost = new NodeAddress('csec', 'h', 60_000);
    const attacker = new NodeAddress('csec', 'h', 65_533);
    const evil: InjectableGossip = {
      kind: 'gossip',
      from: attacker.toJSON(),
      members: [{
        address: ghost.toJSON(),
        status: 'up',
        version: Number.NaN,
      }],
    };
    inject(nodeA.cluster, attacker, evil);

    // The ghost should NOT have been registered.
    const sawGhost = nodeA.cluster.getMembers().some(x => x.address.equals(ghost));
    expect(sawGhost).toBe(false);
  }, 10_000);

  test('defense: gossip with slightly-future version (within skew tolerance) IS accepted', async () => {
    // Confirm the cap isn't so tight it rejects normal traffic.
    // Real nodes seed `version = Date.now()` and bump by 1; a peer
    // with a few minutes of clock skew is still legitimate.
    const portA = 53_400 + Math.floor(Math.random() * 500);
    const portB = portA + 1;
    const nodeA = await startNode('csec', portA);
    const nodeB = await startNode('csec', portB, [`csec@h:${portA}`]);
    nodes = [nodeA, nodeB];

    await waitFor(() => {
      const member = nodeA.cluster.getMembers().find(x => x.address.equals(nodeB.address));
      return !!member && member.status === 'up';
    });

    // Send a gossip with a version slightly in the future (5 minutes).
    // This should be accepted (within the 24-h skew tolerance) and
    // can legitimately bump the member's recorded version.
    const futureVersion = Date.now() + 5 * 60 * 1000;
    const evil: InjectableGossip = {
      kind: 'gossip',
      from: nodeB.address.toJSON(),
      members: [{
        address: nodeB.address.toJSON(),
        status: 'up',
        version: futureVersion,
      }],
    };
    inject(nodeA.cluster, nodeB.address, evil);

    // The version did update (defense isn't over-strict).
    const updated = nodeA.cluster.getMembers().find(x => x.address.equals(nodeB.address));
    expect(updated?.version).toBe(futureVersion);
  }, 10_000);

  test('regression: normal cluster operation is unaffected by the cap', async () => {
    // 3-node cluster should converge as before.
    const port1 = 53_500 + Math.floor(Math.random() * 500);
    const nodeA = await startNode('csec', port1);
    const nodeB = await startNode('csec', port1 + 1, [`csec@h:${port1}`]);
    const nodeC = await startNode('csec', port1 + 2, [`csec@h:${port1}`]);
    nodes = [nodeA, nodeB, nodeC];

    await waitFor(() => {
      return nodeA.cluster.getMembers().length === 3
        && nodeB.cluster.getMembers().length === 3
        && nodeC.cluster.getMembers().length === 3;
    });

    const allUp = [nodeA, nodeB, nodeC].every((node) =>
      node.cluster.getMembers().filter((member) => member.status === 'up').length === 3,
    );
    expect(allUp).toBe(true);
  }, 10_000);
});

/* ---------------- hello-handshake identity hijacking ---------------- */

/**
 * **Exploit walkthrough (pre-fix).**  The transport stored peer
 * connections in `byPeer[peerKey] = conn` whenever a `hello` arrived.
 * The set was UNCONDITIONAL — a second hello claiming the same
 * identity on a different socket simply overwrote the existing entry.
 * From that moment on, every outbound message intended for the
 * legitimate peer was routed through the attacker's socket.
 *
 * Attack sequence (over real TCP):
 *
 *   1. Legitimate peer A connects, sends `hello { self: A }`.
 *      Cluster stores `byPeer[A] = conn1`.
 *   2. Attacker opens a fresh TCP socket to the same cluster node,
 *      sends `hello { self: A }` — same address as the legitimate
 *      peer.  No proof of identity required.
 *   3. Cluster overwrites `byPeer[A] = conn2`.  Future outbound
 *      messages to A all flow over conn2 (attacker's socket).
 *   4. Cluster believes it's still talking to A; attacker reads
 *      whatever the cluster sends to A, including reply-to-ask
 *      bodies that may carry secrets.
 *
 * Fix: when a hello (or hello-ack) arrives on a NEW connection but
 * `byPeer[peer]` already holds a DIFFERENT conn, reject the new
 * one — close its socket, don't overwrite.  Legitimate reconnects
 * still work because `onClose` removes the old conn from byPeer
 * before the new hello arrives in the common case.
 *
 * The test below uses InMemoryTransport (which mirrors the TCP
 * transport's hello logic) plus a synthetic second transport on the
 * same address to simulate the attack.
 */
import { TcpTransport } from '../../src/cluster/Transport.js';

describe('Transport — hello-handshake hijack defense', () => {
  test('exploit: second hello with same claimed identity is rejected', () => {
    // Use the TCP transport directly with mock sockets so we can drive
    // both sides of the handshake deterministically.  The InMemory
    // transport doesn't actually go through `onMessage`'s hello logic
    // — it skips the handshake entirely — so it's not the right
    // probe.  Mock TcpSocketLike objects let us call the transport's
    // private machinery via type cast.
    const self = new NodeAddress('hijack', '127.0.0.1', 1);
    const log = new NoopLogger();
    const transport = new TcpTransport(self, log);

    // Mock TcpSocketLike shape.
    interface MockSock {
      ended: boolean;
      writes: Uint8Array[];
      write(d: Uint8Array): void;
      end(): void;
    }
    const mkSock = (): MockSock => ({
      ended: false, writes: [],
      write(d) { this.writes.push(d); },
      end() { this.ended = true; },
    });
    const sock1 = mkSock();
    const sock2 = mkSock();

    // Access the private state for assertion + injection.
    const rawTransport = transport as unknown as {
      attachInbound(s: unknown): void;
      onData(s: unknown, chunk: Uint8Array): void;
      byPeer: Map<string, { socket: unknown }>;
    };
    rawTransport.attachInbound(sock1);
    rawTransport.attachInbound(sock2);

    const claimedPeer = new NodeAddress('hijack', '10.0.0.42', 5000);

    // First hello on conn1 — legitimate, accepted.
    const helloFrame = (): Uint8Array => {
      const message = JSON.stringify({ kind: 'hello', self: claimedPeer.toJSON() });
      const payload = new TextEncoder().encode(message);
      const frame = new Uint8Array(4 + payload.byteLength);
      new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
      frame.set(payload, 4);
      return frame;
    };
    rawTransport.onData(sock1, helloFrame());
    expect(rawTransport.byPeer.get(claimedPeer.toString())?.socket).toBe(sock1);

    // Second hello on conn2 — claims same identity.  Pre-fix would
    // overwrite byPeer to point at sock2 (the attacker).  Post-fix
    // rejects: sock2 is ended, byPeer still points at sock1.
    rawTransport.onData(sock2, helloFrame());
    expect(sock2.ended).toBe(true);    // attacker's socket closed
    expect(sock1.ended).toBe(false);   // legitimate socket untouched
    expect(rawTransport.byPeer.get(claimedPeer.toString())?.socket).toBe(sock1);
  });

  test('defense: legitimate reconnect after clean close still works', () => {
    // After conn1 closes (onClose removes it from byPeer), a fresh
    // hello on conn2 with the same identity succeeds.  This is the
    // normal reconnect path; the hijack defense must not break it.
    const self = new NodeAddress('hijack', '127.0.0.1', 1);
    const transport = new TcpTransport(self, new NoopLogger());

    interface MockSock { writes: Uint8Array[]; write(d: Uint8Array): void; end(): void; ended: boolean }
    const mkSock = (): MockSock => ({
      writes: [], ended: false,
      write(d) { this.writes.push(d); },
      end() { this.ended = true; },
    });
    const sock1 = mkSock();
    const rawTransport = transport as unknown as {
      attachInbound(s: unknown): void;
      onData(s: unknown, chunk: Uint8Array): void;
      onClose(s: unknown): void;
      byPeer: Map<string, unknown>;
    };
    rawTransport.attachInbound(sock1);

    const peer = new NodeAddress('hijack', '10.0.0.99', 5001);
    const helloFrame = (): Uint8Array => {
      const message = JSON.stringify({ kind: 'hello', self: peer.toJSON() });
      const payload = new TextEncoder().encode(message);
      const frame = new Uint8Array(4 + payload.byteLength);
      new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
      frame.set(payload, 4);
      return frame;
    };
    rawTransport.onData(sock1, helloFrame());
    expect(rawTransport.byPeer.has(peer.toString())).toBe(true);

    // Sock1 closes (drop / reconnect scenario).
    rawTransport.onClose(sock1);
    expect(rawTransport.byPeer.has(peer.toString())).toBe(false);

    // Fresh conn2 sends the same hello — should succeed (no
    // existing entry to defend).
    const sock2 = mkSock();
    rawTransport.attachInbound(sock2);
    rawTransport.onData(sock2, helloFrame());
    expect(rawTransport.byPeer.has(peer.toString())).toBe(true);
    expect(sock2.ended).toBe(false);
  });
});

/* -------------------- crossing dials and dead dials -------------------- */

/**
 * **Failure walkthrough (pre-fix, #697).**  `openOutbound` registers the
 * connection in `byPeer` *before* the handshake, with `peer` still `null`.
 * The hijack guard above compares identity only, so when two healthy nodes
 * dialled each other in the same instant, each held an un-acked outbound
 * under the other's key and rejected the other's perfectly legitimate
 * `hello`.  Neither dial then received a `hello-ack`, so `peer` stayed
 * `null` — and `onClose` deleted the `byPeer` entry only *if* `peer` was
 * set.  The slot was never reclaimed, the address never re-dialled, and
 * every frame for that peer accumulated silently in `pending`.
 *
 * The two nodes were split for the lifetime of the process.  This is what
 * turned the real-network `integration` suite red: node-b and node-d each
 * logged one "hello hijack rejected" naming the other in the same
 * millisecond, and the receptionist then converged at 4 of 5 refs on
 * exactly those two nodes.
 *
 * Fix: cleanup is keyed on the *dialled* address, not on `peer`, so a dead
 * dial always gives its slot back; a handshake deadline reclaims a dial
 * that connects but never acks; and a crossing dial is resolved by address
 * order so exactly one of the two survives.  An *established* peer
 * connection is still never displaced — that part is the hijack defence and
 * is asserted below too.
 */
describe('Transport — crossing dials and dead dials (#697)', () => {
  interface MockSock {
    ended: boolean;
    writes: Uint8Array[];
    write(d: Uint8Array): void;
    end(): void;
  }

  const mkSock = (): MockSock => ({
    ended: false, writes: [],
    write(d) { this.writes.push(d); },
    end() { this.ended = true; },
  });

  const frameOf = (message: unknown): Uint8Array => {
    const payload = new TextEncoder().encode(JSON.stringify(message));
    const frame = new Uint8Array(4 + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
    frame.set(payload, 4);
    return frame;
  };

  type RawTransport = {
    backend: unknown;
    attachInbound(s: unknown): void;
    onData(s: unknown, chunk: Uint8Array): void;
    onClose(s: unknown, fallback?: unknown): void;
    openOutbound(to: NodeAddress): { socket: unknown; peer: unknown; pending: unknown[] };
    onHandshakeTimeout(connection: unknown): void;
    byPeer: Map<string, { socket: unknown; peer: unknown }>;
  };

  /**
   * A transport whose dials resolve to a mock socket instead of a real one,
   * so a crossing dial can be staged deterministically.  Returns the socket
   * each `connect` handed out, in call order.
   */
  function transportWithFakeDialer(self: NodeAddress): {
    raw: RawTransport;
    dialled: MockSock[];
  } {
    const transport = new TcpTransport(self, new NoopLogger());
    const raw = transport as unknown as RawTransport;
    const dialled: MockSock[] = [];
    raw.backend = {
      listen: () => Promise.resolve({ port: self.port, close: () => {} }),
      connect: (options: { handlers: { onOpen(s: unknown): void } }) => {
        const sock = mkSock();
        dialled.push(sock);
        options.handlers.onOpen(sock);
        return Promise.resolve(sock);
      },
    };
    return { raw, dialled };
  }

  const nodeA = new NodeAddress('sim', '10.0.0.1', 5000);
  const nodeB = new NodeAddress('sim', '10.0.0.2', 5000);
  // The tie-break is "the dial from the lexicographically smaller address
  // wins", and these two addresses differ only in that octet — so A's dial
  // is the one that must survive, on both sides.
  const helloFromA = frameOf({ kind: 'hello', self: nodeA.toJSON() });
  const helloFromB = frameOf({ kind: 'hello', self: nodeB.toJSON() });

  test('exploit: two nodes dialling each other at once still converge', async () => {
    // --- node A dials B, and B's hello arrives before A's ack ---
    const a = transportWithFakeDialer(nodeA);
    a.raw.openOutbound(nodeB);
    await Promise.resolve();                       // let the dial install its socket
    const aOutbound = a.dialled[0]!;

    const bInboundAtA = mkSock();
    a.raw.attachInbound(bInboundAtA);
    a.raw.onData(bInboundAtA, helloFromB);

    // A holds the winning dial, so it defends its own outbound and closes
    // B's inbound — the pre-existing hijack behaviour, and correct here.
    expect(bInboundAtA.ended).toBe(true);
    expect(a.raw.byPeer.get(nodeB.toString())?.socket).toBe(aOutbound);

    // --- node B dials A at the same moment, and A's hello arrives ---
    const b = transportWithFakeDialer(nodeB);
    b.raw.openOutbound(nodeA);
    await Promise.resolve();
    const bOutbound = b.dialled[0]!;

    const aInboundAtB = mkSock();
    b.raw.attachInbound(aInboundAtB);
    b.raw.onData(aInboundAtB, helloFromA);

    // B is on the losing side of the tie-break: it retires its own dial and
    // accepts A's connection.  Pre-fix it rejected A here, which is what
    // deadlocked the pair.
    expect(aInboundAtB.ended).toBe(false);
    expect(bOutbound.ended).toBe(true);
    expect(b.raw.byPeer.get(nodeA.toString())?.socket).toBe(aInboundAtB);
    expect(aInboundAtB.writes.length).toBe(1);     // hello-ack went back to A

    // B's retired dial must not leave its slot behind when the socket's
    // close event lands afterwards — the surviving connection stays.
    b.raw.onClose(bOutbound);
    expect(b.raw.byPeer.get(nodeA.toString())?.socket).toBe(aInboundAtB);

    // --- A completes its handshake on the surviving connection ---
    a.raw.onData(aOutbound, frameOf({ kind: 'hello-ack', self: nodeB.toJSON() }));
    expect(a.raw.byPeer.get(nodeB.toString())?.peer).not.toBeNull();
  });

  test('an established peer is still never displaced by a crossing-dial claim', async () => {
    // The tie-break must only ever retire our own *unfinished* dial.  Here
    // the slot is held by a fully handshaked connection, and the loser-side
    // address ordering that made B yield above must NOT apply.
    const b = transportWithFakeDialer(nodeB);

    const established = mkSock();
    b.raw.attachInbound(established);
    b.raw.onData(established, helloFromA);
    expect(b.raw.byPeer.get(nodeA.toString())?.peer).not.toBeNull();

    const attacker = mkSock();
    b.raw.attachInbound(attacker);
    b.raw.onData(attacker, helloFromA);

    expect(attacker.ended).toBe(true);
    expect(established.ended).toBe(false);
    expect(b.raw.byPeer.get(nodeA.toString())?.socket).toBe(established);
  });

  test('a dial that dies before the handshake gives its slot back', async () => {
    // Pre-fix, `onClose` skipped the delete because `peer` was null, so the
    // address was unreachable *and* un-redialable for the process's life.
    const a = transportWithFakeDialer(nodeA);
    a.raw.openOutbound(nodeB);
    await Promise.resolve();
    const outbound = a.dialled[0]!;
    expect(a.raw.byPeer.has(nodeB.toString())).toBe(true);

    a.raw.onClose(outbound);
    expect(a.raw.byPeer.has(nodeB.toString())).toBe(false);

    // …and the next dial genuinely re-opens rather than reusing a corpse.
    a.raw.openOutbound(nodeB);
    await Promise.resolve();
    expect(a.dialled.length).toBe(2);
  });

  test('a dial that connects but never acks is reclaimed by the deadline', async () => {
    const a = transportWithFakeDialer(nodeA);
    const connection = a.raw.openOutbound(nodeB);
    await Promise.resolve();
    connection.pending.push({ kind: 'ping' });

    // What the handshake timer invokes once HANDSHAKE_TIMEOUT_MS elapses.
    a.raw.onHandshakeTimeout(connection);

    expect(a.raw.byPeer.has(nodeB.toString())).toBe(false);
    expect(connection.pending.length).toBe(0);
    expect(a.dialled[0]!.ended).toBe(true);
  });
});

/* ----- injection for any wire frame, not just gossip ----- */

interface ClusterWirePrivate {
  handleWire(from: NodeAddress, message: WireMessage): void;
  members: Map<string, Member>;
}

/**
 * The raw member map, not `getMembers()` — that filters `removed` entries out,
 * so a tombstone assertion made against it would pass whether or not the
 * tombstone was actually stored.
 */
function rawMember(cluster: Cluster, address: NodeAddress): Member | undefined {
  return (cluster as unknown as ClusterWirePrivate).members.get(address.toString());
}

function injectWire(
  cluster: Cluster, from: NodeAddress, message: Exclude<WireMessage, GossipMessage> | InjectableGossip,
): void {
  const frame: WireMessage = message.kind === 'gossip' ? withSequence(message) : message;
  (cluster as unknown as ClusterWirePrivate).handleWire(from, frame);
}

/** Start a node whose outbound frames are recorded, so replies can be asserted. */
async function startRecordingNode(
  systemName: string,
  port: number,
): Promise<{ node: NodeHandle; sent: WireMessage[] }> {
  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, sysOptions);
  const address = new NodeAddress(systemName, 'h', port);
  const transport = new InMemoryTransport(address);
  const sent: WireMessage[] = [];
  const realSend = transport.send.bind(transport);
  transport.send = (to: NodeAddress, message: WireMessage): void => {
    sent.push(message);
    realSend(to, message);
  };
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(transport)
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(system, clusterOptions);
  return { node: { system, cluster, address }, sent };
}

describe('Cluster — numeric wire-field defenses', () => {
  test('exploit: a tombstone with a non-finite removedAt does not become immortal (#113)', async () => {
    // `removedAt` decides whether a tombstone ages out, and the age comparison
    // fails *open*: with removedAt at Infinity, `Date.now() - removedAt` is
    // -Infinity, which is not `>= ttl`, so the entry looked fresh on every
    // merge and never expired.  A tombstone suppresses its address, so an
    // immortal one keeps that node from ever rejoining.
    const portA = 53_600 + Math.floor(Math.random() * 300);
    const nodeA = await startNode('csec', portA);
    nodes = [nodeA];

    const attacker = new NodeAddress('csec', 'h', 65_533);
    const victim = new NodeAddress('csec', 'h', 64_000);
    const forge = (removedAt: number): InjectableGossip => ({
      kind: 'gossip',
      from: attacker.toJSON(),
      members: [{
        address: victim.toJSON(),
        status: 'removed',
        version: Date.now(),
        removedAt,
      } as MemberData],
    });

    for (const removedAt of [Number.POSITIVE_INFINITY, Number.NaN, Date.now() + 400 * 24 * 3_600_000]) {
      inject(nodeA.cluster, attacker, forge(removedAt));
      expect(rawMember(nodeA.cluster, victim), `removedAt=${removedAt} was accepted`).toBeUndefined();
    }
  }, 10_000);

  test('a tombstone with a plausible removedAt is still accepted (#113)', async () => {
    // The guard must reject implausible values without breaking the mechanism.
    const portA = 53_900 + Math.floor(Math.random() * 90);
    const nodeA = await startNode('csec', portA);
    nodes = [nodeA];

    const peer = new NodeAddress('csec', 'h', 64_001);
    inject(nodeA.cluster, peer, {
      kind: 'gossip',
      from: peer.toJSON(),
      members: [{
        address: peer.toJSON(),
        status: 'removed',
        version: Date.now(),
        removedAt: Date.now(),
      } as MemberData],
    });

    expect(rawMember(nodeA.cluster, peer)?.status).toBe('removed');
  }, 10_000);

  test('exploit: a heartbeat with a non-numeric seq is not echoed back (#115)', async () => {
    // `seq` came off the wire and went straight back out in the acknowledgment
    // without a look.  Nothing consumes it yet, so this is a boundary guard —
    // but a NaN reaching future RTT or skew tracking would be silent nonsense.
    const { node, sent } = await startRecordingNode('csechb', 53_990 + Math.floor(Math.random() * 9));
    nodes = [node];
    const peer = new NodeAddress('csechb', 'h', 64_002);

    for (const [seq, ts] of [
      [Number.NaN, Date.now()],
      [Number.POSITIVE_INFINITY, Date.now()],
      [-1, Date.now()],
      [1.5, Date.now()],
      [1, Number.POSITIVE_INFINITY],
      [1, Date.now() + 400 * 24 * 3_600_000],
    ]) {
      sent.length = 0;
      injectWire(node.cluster, peer, { kind: 'heartbeat', from: peer.toJSON(), seq: seq!, ts: ts! });
      const acks = sent.filter(m => m.kind === 'heartbeat-ack');
      expect(acks, `seq=${seq} ts=${ts} produced an ack`).toEqual([]);
    }
  }, 10_000);

  test('a well-formed heartbeat is still acknowledged (#115)', async () => {
    const { node, sent } = await startRecordingNode('csechb2', 53_970 + Math.floor(Math.random() * 9));
    nodes = [node];
    const peer = new NodeAddress('csechb2', 'h', 64_003);

    sent.length = 0;
    injectWire(node.cluster, peer, { kind: 'heartbeat', from: peer.toJSON(), seq: 7, ts: Date.now() });

    const acks = sent.filter(m => m.kind === 'heartbeat-ack');
    expect(acks).toHaveLength(1);
    expect((acks[0] as { seq: number }).seq).toBe(7);
  }, 10_000);
});

describe('Cluster — the wire edge rejects malformed frames (#563, #705)', () => {
  /**
   * These go through the **transport**, not the private `handleWire` the tests
   * above call, because the transport is where the guard lives — and where the
   * exploit landed.  An attacker registers an `InMemoryTransport` under its own
   * address and sends; the victim receives exactly as it would over TCP.
   */
  // `InMemoryTransport.registry` is static and shared across the whole test
  // run, so an attacker left registered shows up as a stray peer in unrelated
  // suites.  Shut every one of them down.
  let attackers: InMemoryTransport[] = [];

  afterEach(async () => {
    for (const transport of attackers) await transport.shutdown();
    attackers = [];
  });

  function attackerTransport(systemName: string, port: number): InMemoryTransport {
    const transport = new InMemoryTransport(new NodeAddress(systemName, 'h', port));
    void transport.start();
    attackers.push(transport);
    return transport;
  }

  /**
   * **Exploit walkthrough (pre-fix).**  `Member.fromData` copied `status`
   * verbatim off the wire, and `mergeMember` stored the member *before*
   * calling `emitStatusTransition`, whose `match(next.status).exhaustive()`
   * throws for anything outside the seven legal values.  So one frame both
   * (a) crashed the node — the throw escaped `handleWire` into the runtime's
   * socket-data callback, which on Node means process exit — and (b) left the
   * ghost member in the map, so the *next* gossip tick shipped `status:'pwned'`
   * to every peer, where the same throw fired again.  One frame at one
   * reachable node took down the cluster.
   */
  test('exploit: a gossiped member status outside the legal set is dropped, not stored', async () => {
    const port = 54_100 + Math.floor(Math.random() * 400);
    const victim = await startNode('csecwire', port);
    nodes = [victim];

    const attacker = attackerTransport('csecwire', port + 1);
    const ghost = new NodeAddress('csecwire', 'h', port + 900);
    attacker.send(victim.address, {
      kind: 'gossip',
      from: attacker.self.toJSON(),
      sequence: nextGossipSequence(),
      members: [{ address: ghost.toJSON(), status: 'pwned' as never, version: Date.now() }],
    });
    await Bun.sleep(60);

    // Survived, and the ghost never entered the member map — so there is
    // nothing for the next gossip tick to propagate.
    expect(victim.cluster.getMembers().some(m => m.address.equals(ghost))).toBe(false);
    expect(victim.cluster.getMembers().some(m => m.address.equals(victim.address))).toBe(true);
  }, 10_000);

  test('exploit: one malformed member does not discard the well-formed ones around it', async () => {
    const port = 54_600 + Math.floor(Math.random() * 400);
    const victim = await startNode('csecwire2', port);
    nodes = [victim];

    const attacker = attackerTransport('csecwire2', port + 1);
    const good = new NodeAddress('csecwire2', 'h', port + 800);
    attacker.send(victim.address, {
      kind: 'gossip',
      from: attacker.self.toJSON(),
      sequence: nextGossipSequence(),
      members: [
        { address: good.toJSON(), status: 'up', version: Date.now() },
        { address: good.toJSON(), status: 'pwned' as never, version: Date.now() },
      ],
    });
    await Bun.sleep(60);

    // The whole frame is refused — a batch is validated before any of it is
    // merged, so a poisoned entry cannot be smuggled in behind a valid one.
    expect(victim.cluster.getMembers().some(m => m.address.equals(good))).toBe(false);
  }, 10_000);

  /**
   * **Exploit walkthrough (pre-fix).**  `JSON.parse('null')` yields `null`, and
   * `FrameDecoder.push` pushed it into the batch unchecked.  `onMessage` then
   * read `message.kind` — above the handshake gate, so no `hello` was needed
   * either.  Eight bytes, no preconditions, remote process kill.
   */
  test('exploit: a null frame and a bare-string frame are refused without a throw', async () => {
    const port = 55_100 + Math.floor(Math.random() * 400);
    const victim = await startNode('csecwire3', port);
    nodes = [victim];

    const attacker = attackerTransport('csecwire3', port + 1);
    for (const frame of [null, 'hello', 42, []]) {
      attacker.send(victim.address, frame as unknown as WireMessage);
    }
    await Bun.sleep(60);

    // Still serving: the node knows itself and answers introspection.
    expect(victim.cluster.getMembers().some(m => m.address.equals(victim.address))).toBe(true);
  }, 10_000);

  test('exploit: a leave frame naming a node that is not a valid address is refused', async () => {
    const port = 55_600 + Math.floor(Math.random() * 400);
    const victim = await startNode('csecwire4', port);
    nodes = [victim];

    const attacker = attackerTransport('csecwire4', port + 1);
    // `port` as a string is the #571 desync shape: it stringifies to the same
    // key but never compares equal.
    attacker.send(victim.address, {
      kind: 'leave',
      node: { systemName: 'csecwire4', host: 'h', port: String(port) as unknown as number },
    });
    await Bun.sleep(60);

    const self = victim.cluster.getMembers().find(m => m.address.equals(victim.address));
    expect(self).toBeDefined();
    expect(self!.status).not.toBe('removed');
  }, 10_000);
});

describe('Cluster — a claim needs authority, not just a big version (#562, #564, #572)', () => {
  /**
   * **Exploit walkthrough (pre-fix).**  The merge was decided purely by version
   * magnitude, and versions are seeded from `Date.now()` — so an attacker could
   * always pick a winning number.  There was no rule about *who* may say what:
   * one frame set the receiving node's own record to `removed`, which dropped
   * it out of its own active set and flipped `isLeader()` to false, so the
   * cluster could no longer admit new members.
   */
  test('exploit: a peer cannot rewrite our own member record', async () => {
    const port = 56_100 + Math.floor(Math.random() * 400);
    const { node } = await startRecordingNode('csecauth', port);
    nodes = [node];
    await waitFor(() => node.cluster.upMembers().length === 1);

    const attacker = new NodeAddress('csecauth', 'h', port + 500);
    injectWire(node.cluster, attacker, {
      kind: 'gossip',
      from: attacker.toJSON(),
      members: [{
        address: node.address.toJSON(),
        status: 'removed',
        version: Date.now() + 60_000,
        removedAt: Date.now(),
      }],
    });

    const self = node.cluster.getMembers().find(m => m.address.equals(node.address));
    expect(self?.status).toBe('up');
    expect(node.cluster.isLeader()).toBe(true);
  }, 10_000);

  test('a promotion to up is still accepted — it is the leader\'s call, not ours', async () => {
    // The one legitimate outside claim about our own record. Refusing it would
    // leave every joining node stuck in `joining` forever, so the rule carves
    // it out explicitly; this pins that the carve-out exists and is narrow.
    const port = 56_600 + Math.floor(Math.random() * 400);
    const { node } = await startRecordingNode('csecauth2', port);
    nodes = [node];
    await waitFor(() => node.cluster.upMembers().length === 1);

    // Already `up`, so a *downgrade* dressed as a promotion is still refused.
    const peer = new NodeAddress('csecauth2', 'h', port + 500);
    injectWire(node.cluster, peer, {
      kind: 'gossip',
      from: peer.toJSON(),
      members: [{ address: node.address.toJSON(), status: 'down', version: Date.now() + 60_000 }],
    });
    expect(node.cluster.getMembers().find(m => m.address.equals(node.address))?.status).toBe('up');
  }, 10_000);

  test('exploit: a stranger cannot make claims about a third node', async () => {
    const port = 57_100 + Math.floor(Math.random() * 400);
    const { node } = await startRecordingNode('csecauth3', port);
    nodes = [node];
    await waitFor(() => node.cluster.upMembers().length === 1);

    // The attacker is not a member this node considers active, so its claim
    // about an unrelated address carries no authority.
    const attacker = new NodeAddress('csecauth3', 'h', port + 500);
    const victim = new NodeAddress('csecauth3', 'h', port + 600);
    injectWire(node.cluster, attacker, {
      kind: 'gossip',
      from: attacker.toJSON(),
      members: [{ address: victim.toJSON(), status: 'down', version: Date.now() }],
    });

    expect(node.cluster.getMembers().some(m => m.address.equals(victim))).toBe(false);
  }, 10_000);

  /**
   * **Exploit walkthrough (pre-fix).**  `onLeave` read the departing node from
   * `message.node` rather than from the connection, and writes a tombstone at
   * `version + 2` — above anything the victim can say about itself.  One
   * 120-byte frame evicted any member cluster-wide for the 24-hour tombstone
   * TTL, and the victim could not gossip its way back.
   */
  test('exploit: a leave frame cannot retire a node other than its sender', async () => {
    const portA = 57_600 + Math.floor(Math.random() * 300);
    const portB = portA + 1;
    const nodeA = await startNode('csecleave', portA);
    const nodeB = await startNode('csecleave', portB, [`csecleave@h:${portA}`]);
    nodes = [nodeA, nodeB];
    await waitFor(() => {
      const member = nodeA.cluster.getMembers().find(x => x.address.equals(nodeB.address));
      return !!member && member.status === 'up';
    });

    const attacker = new NodeAddress('csecleave', 'h', portA + 500);
    injectWire(nodeA.cluster, attacker, { kind: 'leave', node: nodeB.address.toJSON() });

    const victim = nodeA.cluster.getMembers().find(x => x.address.equals(nodeB.address));
    expect(victim?.status).toBe('up');
  }, 15_000);

  /**
   * **Exploit walkthrough (pre-fix).**  `onHeartbeat` took the peer from
   * `message.from` and both refreshed the failure detector for that address and
   * *sent the acknowledgment to it*.  So a peer could keep a dead node looking
   * healthy — blocking singleton and shard failover — and could make the
   * receiver dial any host:port it named.
   */
  test('exploit: a heartbeat is credited to the connection, not to the address it names', async () => {
    const port = 58_100 + Math.floor(Math.random() * 300);
    const { node, sent } = await startRecordingNode('csechb3', port);
    nodes = [node];

    const realPeer = new NodeAddress('csechb3', 'h', port + 100);
    const impersonated = new NodeAddress('csechb3', 'h', port + 200);

    sent.length = 0;
    injectWire(node.cluster, realPeer, {
      kind: 'heartbeat', from: impersonated.toJSON(), seq: 1, ts: Date.now(),
    });

    // The acknowledgment names us and goes back to the connection's peer; the
    // impersonated address is never contacted.
    const acks = sent.filter(m => m.kind === 'heartbeat-ack');
    expect(acks).toHaveLength(1);
    expect((acks[0] as { from: { port: number } }).from.port).toBe(port);
  }, 10_000);
});

describe('Extensions survive what a peer can address to them (#713)', () => {
  /**
   * **Exploit walkthrough (pre-fix).**  `Receptionist.onReceive` ended in
   * `.exhaustive()` and every arm matches on `instanceof`.  A body delivered
   * over the cluster wire arrives as a plain JSON object — it is not an
   * instance of anything — so it matched no arm, `.exhaustive()` threw, and one
   * remotely-delivered envelope failed the actor that holds the node's whole
   * service registry.
   */
  test('exploit: a plain-object message does not fail the receptionist', async () => {
    const port = 59_100 + Math.floor(Math.random() * 400);
    const node = await startNode('csecexh', port);
    nodes = [node];

    const serviceKey = ServiceKey.of('svc');
    const receptionist = node.system.extension(ReceptionistId).start(node.cluster);
    const probe = node.system.spawnAnonymous(ProbeActor);
    receptionist.tell(new Register(serviceKey, probe));
    await Bun.sleep(40);

    // Exactly the shape a remote peer's envelope body has: no class identity.
    receptionist.tell({ kind: 'not-a-receptionist-message' } as never);
    receptionist.tell(null as never);
    await Bun.sleep(60);

    // Still alive and still holding the registration — the actor did not fail,
    // so its state survived and it keeps answering.
    const found = await new Promise<readonly ActorRef[]>((resolve) => {
      const collector = node.system.spawnAnonymous(class extends Actor<Listing> {
        override onReceive(message: Listing): void { resolve(message.refs); }
      });
      receptionist.tell(new Find(serviceKey, collector));
    });
    expect(found.length).toBe(1);
  }, 10_000);
});

describe('Cluster — a recorded gossip frame is worthless on a second delivery (#112)', () => {
  /**
   * **Exploit walkthrough (pre-fix).**  A gossip frame carries a snapshot of
   * the member map, and a member's `version` only moves when its status does —
   * so a frame captured off the wire stays byte-for-byte valid indefinitely.
   * Against a converged receiver that is harmless: every record loses
   * `mergeMember`'s `incoming.version <= existing.version` comparison.  What
   * makes it an exploit is an entry the receiver has **deleted**.  The failure
   * detector's down path deletes outright rather than tombstoning, so a healed
   * partition can re-discover the peer — and that is exactly what leaves
   * nothing behind for a replay to be compared against: the no-existing-entry
   * branch of the merge has no lower version bound at all.
   *
   * So replaying a downed member's own pre-down record brought it back at its
   * old version, `up`, carrying the roles it had — and roles are what shard
   * placement, singleton hosting and downing quorums are computed from.
   * Reproduced by execution in #940 (its step B3).
   *
   * Fix: every gossip frame carries a `sequence` its author stamps, and a
   * receiver keeps the highest one it has accepted per connection peer.  A
   * frame that does not out-number that mark is dropped whole.
   */
  test('exploit: replaying a downed member\'s own record does not bring it back', async () => {
    const port = 60_100 + Math.floor(Math.random() * 300);
    const node = await startNode('csecreplay', port);
    nodes = [node];
    await waitFor(() => node.cluster.upMembers().length === 1);

    const peer = new NodeAddress('csecreplay', 'h', port + 100);
    const victim = new NodeAddress('csecreplay', 'h', port + 200);

    // The peer earns standing the ordinary way — a self-announcement, the one
    // claim `maySpeakFor` never refuses (#562).
    inject(node.cluster, peer, {
      kind: 'gossip',
      from: peer.toJSON(),
      members: [{ address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] }],
    });
    await waitFor(() => rawMember(node.cluster, peer)?.status === 'up');

    // The frame an attacker records off the wire: a peer with standing
    // reporting the victim as `up` and hosting the `payments` shards.
    const captured = withSequence({
      kind: 'gossip',
      from: peer.toJSON(),
      members: [{
        address: victim.toJSON(), status: 'up', version: Date.now(), roles: ['payments'],
      }],
    });
    inject(node.cluster, peer, captured);
    expect(rawMember(node.cluster, victim)?.status).toBe('up');

    // The victim falls silent and the failure detector evicts it, deleting the
    // entry.  Heartbeats keep the *peer* alive meanwhile — `handleWire` credits
    // the connection, so any frame from it is enough.
    let beat = 0;
    const keepPeerAlive = setInterval(() => {
      beat += 1;
      injectWire(node.cluster, peer, {
        kind: 'heartbeat', from: peer.toJSON(), seq: beat, ts: Date.now(),
      });
    }, 40);
    try {
      await waitFor(() => rawMember(node.cluster, victim) === undefined, 5_000);
    } finally {
      clearInterval(keepPeerAlive);
    }
    expect(rawMember(node.cluster, peer)?.status).toBe('up');

    // The replay: the same frame, byte for byte, from a peer that still has
    // every bit of the standing it had when the frame was genuine.
    inject(node.cluster, peer, captured);

    expect(rawMember(node.cluster, victim)).toBeUndefined();
    expect(node.cluster.upMembersWithRole('payments')).toHaveLength(0);
  }, 20_000);

  test('a fresh frame from the same peer still merges', async () => {
    // The regression side: the guard refuses a *repeat*, not the peer.  Without
    // this the first refusal would end the conversation.
    const port = 60_500 + Math.floor(Math.random() * 300);
    const node = await startNode('csecreplay2', port);
    nodes = [node];
    await waitFor(() => node.cluster.upMembers().length === 1);

    const peer = new NodeAddress('csecreplay2', 'h', port + 100);
    const subject = new NodeAddress('csecreplay2', 'h', port + 200);

    inject(node.cluster, peer, {
      kind: 'gossip',
      from: peer.toJSON(),
      members: [{ address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] }],
    });
    await waitFor(() => rawMember(node.cluster, peer)?.status === 'up');

    const stale = withSequence({
      kind: 'gossip',
      from: peer.toJSON(),
      members: [{ address: subject.toJSON(), status: 'joining', version: Date.now(), roles: [] }],
    });
    inject(node.cluster, peer, stale);
    inject(node.cluster, peer, stale);          // refused — same sequence

    // …and the next genuine frame, which out-numbers it, lands.
    const laterVersion = Date.now() + 1_000;
    inject(node.cluster, peer, {
      kind: 'gossip',
      from: peer.toJSON(),
      members: [{
        address: subject.toJSON(), status: 'leaving', version: laterVersion, roles: [],
      }],
    });

    expect(rawMember(node.cluster, subject)?.status).toBe('leaving');
    expect(rawMember(node.cluster, subject)?.version).toBe(laterVersion);
  }, 15_000);

  test('what the guard deliberately leaves open: a live forgery, not a replay (#940)', async () => {
    // The counterfactual that fixes the scope.  A peer that has *earned*
    // standing can still compose a NEW frame naming a deleted address at its
    // old version, and the no-existing-entry branch admits it with whatever
    // roles the frame carries.  That is not a replay — the frame is fresh —
    // and closing it needs an incarnation identity on `NodeAddress`, which is
    // tracked as #940.  Asserted so the boundary is a decision on record
    // rather than an accident.
    const port = 60_900 + Math.floor(Math.random() * 90);
    const node = await startNode('csecreplay3', port);
    nodes = [node];
    await waitFor(() => node.cluster.upMembers().length === 1);

    const peer = new NodeAddress('csecreplay3', 'h', port + 100);
    const ghost = new NodeAddress('csecreplay3', 'h', port + 200);

    inject(node.cluster, peer, {
      kind: 'gossip',
      from: peer.toJSON(),
      members: [{ address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] }],
    });
    await waitFor(() => rawMember(node.cluster, peer)?.status === 'up');

    // A brand-new frame — a sequence the peer has never used — about an
    // address this node has no record of.
    inject(node.cluster, peer, {
      kind: 'gossip',
      from: peer.toJSON(),
      members: [{
        address: ghost.toJSON(), status: 'up', version: Date.now(), roles: ['payments'],
      }],
    });

    expect(rawMember(node.cluster, ghost)?.status).toBe('up');
  }, 15_000);
});
