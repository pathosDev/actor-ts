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
import { Cluster } from '../../src/cluster/Cluster.js';
import { InMemoryTransport } from '../../src/cluster/Transport.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import type { GossipMsg, MemberData } from '../../src/cluster/Protocol.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';

interface NodeHandle {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
}

async function startNode(systemName: string, port: number, seeds: string[] = []): Promise<NodeHandle> {
  const system = ActorSystem.create(systemName, {
    logger: new NoopLogger(),
    logLevel: LogLevel.Off,
  });
  const address = new NodeAddress(systemName, 'h', port);
  const cluster = await Cluster.join(system, {
    host: 'h', port,
    seeds,
    transport: new InMemoryTransport(address),
    failureDetector: { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 },
    gossipIntervalMs: 80,
  });
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

function inject(cluster: Cluster, from: NodeAddress, msg: GossipMsg): void {
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
    const evil: GossipMsg = {
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
    const evil: GossipMsg = {
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
    const evil: GossipMsg = {
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
    const evil: GossipMsg = {
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
