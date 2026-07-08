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
import type { GossipMessage, MemberData } from '../../src/cluster/Protocol.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';

interface NodeHandle {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
}

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

async function stopNode(n: NodeHandle): Promise<void> {
  try { await n.cluster.leave(); } catch { /* */ }
  try { await n.system.terminate(); } catch { /* */ }
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
  handleWire(from: NodeAddress, msg: { t: 'gossip'; from: ReturnType<NodeAddress['toJSON']>; members: MemberData[] }): void;
}

function inject(cluster: Cluster, from: NodeAddress, msg: GossipMessage): void {
  (cluster as unknown as ClusterPrivate).handleWire(from, msg);
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const n of nodes) await stopNode(n);
  nodes = [];
});

describe('Cluster — gossip exploit defenses', () => {
  /**
   * **Exploit walkthrough (pre-fix).**  `mergeMember`'s only
   * filter on the `version` field was `incoming.version > existing.version`.
   * A malicious peer that could speak the gossip protocol could send
   *
   *   { t: 'gossip', members: [{ address: <target>,
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
   * MAX_VERSION_SKEW_MS` (24 h) in `Cluster.mergeMember`.
   */
  test('exploit: gossip with Number.MAX_SAFE_INTEGER version is rejected', async () => {
    const portA = 53_100 + Math.floor(Math.random() * 500);
    const portB = portA + 1;
    const a = await startNode('csec', portA);
    const b = await startNode('csec', portB, [`csec@h:${portA}`]);
    nodes = [a, b];

    // Wait until A sees B as 'up'.
    await waitFor(() => {
      const m = a.cluster.getMembers().find(x => x.address.equals(b.address));
      return !!m && m.status === 'up';
    });
    const beforeB = a.cluster.getMembers().find(x => x.address.equals(b.address));
    expect(beforeB?.status).toBe('up');

    // Forge a malicious gossip from an "attacker" address (no real
    // node — just a synthetic NodeAddress to source the frame).
    const attacker = new NodeAddress('csec', 'h', 65_535);
    const evil: GossipMessage = {
      t: 'gossip',
      from: attacker.toJSON(),
      members: [{
        address: b.address.toJSON(),
        status: 'down',
        version: Number.MAX_SAFE_INTEGER,
      }],
    };
    inject(a.cluster, attacker, evil);

    // Defense: B's status is unchanged (still up).
    const afterB = a.cluster.getMembers().find(x => x.address.equals(b.address));
    expect(afterB?.status).toBe('up');
    expect(afterB?.version).toBeLessThan(Number.MAX_SAFE_INTEGER);
  }, 10_000);

  test('exploit: gossip with Number.POSITIVE_INFINITY version is rejected', async () => {
    const portA = 53_200 + Math.floor(Math.random() * 500);
    const portB = portA + 1;
    const a = await startNode('csec', portA);
    const b = await startNode('csec', portB, [`csec@h:${portA}`]);
    nodes = [a, b];

    await waitFor(() => {
      const m = a.cluster.getMembers().find(x => x.address.equals(b.address));
      return !!m && m.status === 'up';
    });

    const attacker = new NodeAddress('csec', 'h', 65_534);
    const evil: GossipMessage = {
      t: 'gossip',
      from: attacker.toJSON(),
      members: [{
        address: b.address.toJSON(),
        status: 'down',
        version: Number.POSITIVE_INFINITY,
      }],
    };
    inject(a.cluster, attacker, evil);

    const afterB = a.cluster.getMembers().find(x => x.address.equals(b.address));
    expect(afterB?.status).toBe('up');
  }, 10_000);

  test('exploit: gossip with NaN version is rejected', async () => {
    const portA = 53_300 + Math.floor(Math.random() * 500);
    const a = await startNode('csec', portA);
    nodes = [a];

    // No B needed — inject an attempted-creation of a fake member.
    const ghost = new NodeAddress('csec', 'h', 60_000);
    const attacker = new NodeAddress('csec', 'h', 65_533);
    const evil: GossipMessage = {
      t: 'gossip',
      from: attacker.toJSON(),
      members: [{
        address: ghost.toJSON(),
        status: 'up',
        version: Number.NaN,
      }],
    };
    inject(a.cluster, attacker, evil);

    // The ghost should NOT have been registered.
    const sawGhost = a.cluster.getMembers().some(x => x.address.equals(ghost));
    expect(sawGhost).toBe(false);
  }, 10_000);

  test('defense: gossip with slightly-future version (within skew tolerance) IS accepted', async () => {
    // Confirm the cap isn't so tight it rejects normal traffic.
    // Real nodes seed `version = Date.now()` and bump by 1; a peer
    // with a few minutes of clock skew is still legitimate.
    const portA = 53_400 + Math.floor(Math.random() * 500);
    const portB = portA + 1;
    const a = await startNode('csec', portA);
    const b = await startNode('csec', portB, [`csec@h:${portA}`]);
    nodes = [a, b];

    await waitFor(() => {
      const m = a.cluster.getMembers().find(x => x.address.equals(b.address));
      return !!m && m.status === 'up';
    });

    // Send a gossip with a version slightly in the future (5 minutes).
    // This should be accepted (within the 24-h skew tolerance) and
    // can legitimately bump the member's recorded version.
    const futureVersion = Date.now() + 5 * 60 * 1000;
    const evil: GossipMessage = {
      t: 'gossip',
      from: b.address.toJSON(),
      members: [{
        address: b.address.toJSON(),
        status: 'up',
        version: futureVersion,
      }],
    };
    inject(a.cluster, b.address, evil);

    // The version did update (defense isn't over-strict).
    const updated = a.cluster.getMembers().find(x => x.address.equals(b.address));
    expect(updated?.version).toBe(futureVersion);
  }, 10_000);

  test('regression: normal cluster operation is unaffected by the cap', async () => {
    // 3-node cluster should converge as before.
    const port1 = 53_500 + Math.floor(Math.random() * 500);
    const a = await startNode('csec', port1);
    const b = await startNode('csec', port1 + 1, [`csec@h:${port1}`]);
    const c = await startNode('csec', port1 + 2, [`csec@h:${port1}`]);
    nodes = [a, b, c];

    await waitFor(() => {
      return a.cluster.getMembers().length === 3
        && b.cluster.getMembers().length === 3
        && c.cluster.getMembers().length === 3;
    });

    const allUp = [a, b, c].every((n) =>
      n.cluster.getMembers().filter((m) => m.status === 'up').length === 3,
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
    const t = transport as unknown as {
      attachInbound(s: unknown): void;
      onData(s: unknown, chunk: Uint8Array): void;
      byPeer: Map<string, { socket: unknown }>;
    };
    t.attachInbound(sock1);
    t.attachInbound(sock2);

    const claimedPeer = new NodeAddress('hijack', '10.0.0.42', 5000);

    // First hello on conn1 — legitimate, accepted.
    const helloFrame = (): Uint8Array => {
      const msg = JSON.stringify({ t: 'hello', self: claimedPeer.toJSON() });
      const payload = new TextEncoder().encode(msg);
      const frame = new Uint8Array(4 + payload.byteLength);
      new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
      frame.set(payload, 4);
      return frame;
    };
    t.onData(sock1, helloFrame());
    expect(t.byPeer.get(claimedPeer.toString())?.socket).toBe(sock1);

    // Second hello on conn2 — claims same identity.  Pre-fix would
    // overwrite byPeer to point at sock2 (the attacker).  Post-fix
    // rejects: sock2 is ended, byPeer still points at sock1.
    t.onData(sock2, helloFrame());
    expect(sock2.ended).toBe(true);    // attacker's socket closed
    expect(sock1.ended).toBe(false);   // legitimate socket untouched
    expect(t.byPeer.get(claimedPeer.toString())?.socket).toBe(sock1);
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
    const t = transport as unknown as {
      attachInbound(s: unknown): void;
      onData(s: unknown, chunk: Uint8Array): void;
      onClose(s: unknown): void;
      byPeer: Map<string, unknown>;
    };
    t.attachInbound(sock1);

    const peer = new NodeAddress('hijack', '10.0.0.99', 5001);
    const helloFrame = (): Uint8Array => {
      const msg = JSON.stringify({ t: 'hello', self: peer.toJSON() });
      const payload = new TextEncoder().encode(msg);
      const frame = new Uint8Array(4 + payload.byteLength);
      new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
      frame.set(payload, 4);
      return frame;
    };
    t.onData(sock1, helloFrame());
    expect(t.byPeer.has(peer.toString())).toBe(true);

    // Sock1 closes (drop / reconnect scenario).
    t.onClose(sock1);
    expect(t.byPeer.has(peer.toString())).toBe(false);

    // Fresh conn2 sends the same hello — should succeed (no
    // existing entry to defend).
    const sock2 = mkSock();
    t.attachInbound(sock2);
    t.onData(sock2, helloFrame());
    expect(t.byPeer.has(peer.toString())).toBe(true);
    expect(sock2.ended).toBe(false);
  });
});
