/**
 * Multi-node tests for `ClusterRouter` (#50).  Three nodes form a
 * cluster; a router on one node routes messages to a worker actor
 * on `/user/worker` on every node carrying the right role.
 *
 *   - Round-robin distributes 30 messages roughly 10/node ± 1.
 *   - Consistent-hashing pins the same key to the same node, even
 *     across many calls and re-routes.
 *   - Role filter excludes nodes that don't carry the role.
 *   - When a node leaves, the router rebuilds its routee set and
 *     subsequent traffic only lands on the remaining nodes.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { Cluster } from '../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../src/cluster/Transport.js';
import { ClusterRouter, ClusterRouterOptions } from '../../src/cluster/router/index.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';
import { Broadcast } from '../../src/Router.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

// Default timeout bumped from 5 s to 15 s so the multi-node `waitFor`
// has headroom under CI load (issue #76 — the previous 5-s ceiling
// fired flakily on GitHub-hosted runners when other test files were
// sharing scheduler time, even though the predicates eventually held
// in well under a second locally).
async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(25);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Wait until `read()` returns the same value for `settleTicks` polls
 * in a row.  Replaces the flake-prone `waitFor(() => count === N)`
 * pattern when "no more messages will arrive" is the real predicate
 * and we just want to read the final tally.  Returns the settled
 * value so the caller can `expect()` it directly.
 *
 * Why this matters here (#76): the previous "exactly 21 received"
 * wait had no flush-fence behind it.  Under CI load a couple of the
 * cross-node tells could be in-flight when the loop fired the
 * cleanup; bumping `waitFor`'s timeout helped but didn't address the
 * underlying signal — "stop when traffic settles" is what the test
 * really wants.
 */
async function waitStable<T>(
  read: () => T,
  opts: { settleTicks?: number; tickMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const settleTicks = opts.settleTicks ?? 3;
  const tickMs = opts.tickMs ?? 50;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  let prev = read();
  let stableFor = 0;
  while (Date.now() < deadline) {
    await sleep(tickMs);
    const cur = read();
    if (Object.is(cur, prev)) {
      stableFor++;
      if (stableFor >= settleTicks) return cur;
    } else {
      prev = cur;
      stableFor = 0;
    }
  }
  throw new Error(`waitStable: did not settle within ${timeoutMs} ms (last value: ${JSON.stringify(prev)})`);
}

interface Node {
  readonly role: string;
  readonly sys: ActorSystem;
  readonly cluster: Cluster;
  readonly received: string[];
}

async function startNode(
  systemName: string, port: number, seeds: string[], roles: string[],
): Promise<Node> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(systemName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withRoles(roles)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(sys, clusterOptions);
  const received: string[] = [];

  class Worker extends Actor<{ kind: 'work'; id: string }> {
    override onReceive(m: { kind: 'work'; id: string }): void {
      received.push(m.id);
    }
  }
  sys.spawn(Props.create(() => new Worker()), 'worker');

  return { role: roles[0] ?? 'no-role', sys, cluster, received };
}

async function stop(n: Node): Promise<void> {
  try { await n.cluster.leave(); } catch { /* ignore */ }
  await n.sys.terminate();
}

describe('ClusterRouter — multi-node', () => {
  test('round-robin distributes 30 messages roughly evenly across 3 role-matching nodes', async () => {
    const sysName = 'cr-rr';
    const a = await startNode(sysName, 70_001, [], ['compute']);
    const b = await startNode(sysName, 70_002, [`${sysName}@h:70001`], ['compute']);
    const c = await startNode(sysName, 70_003, [`${sysName}@h:70001`], ['compute']);
    try {
      await waitFor(() => a.cluster.upMembers().length === 3);

      // Router lives on node A; routees include all three nodes.
      const routerOptions = ClusterRouterOptions.create<{ kind: 'work'; id: string }>()
        .withCluster(a.cluster)
        .withRole('compute')
        .withRouterType('round-robin')
        .withRouteePath('/user/worker');
      const router = a.sys.spawn(
        ClusterRouter.props<{ kind: 'work'; id: string }>(routerOptions),
        'rr-router',
      );
      // Wait one tick for the router's preStart to subscribe + rebuild.
      await sleep(50);

      const N = 30;
      for (let i = 0; i < N; i++) {
        router.tell({ kind: 'work', id: `m-${i}` });
      }

      await waitFor(() =>
        a.received.length + b.received.length + c.received.length === N,
        5_000,
      );

      // Each node should receive 10 ± a small slack — round-robin is
      // strict but the routee-rebuild order of the `upMembers` set
      // could put any node at index 0.  We assert "no node is starved".
      expect(a.received.length).toBeGreaterThanOrEqual(8);
      expect(a.received.length).toBeLessThanOrEqual(12);
      expect(b.received.length).toBeGreaterThanOrEqual(8);
      expect(b.received.length).toBeLessThanOrEqual(12);
      expect(c.received.length).toBeGreaterThanOrEqual(8);
      expect(c.received.length).toBeLessThanOrEqual(12);
    } finally {
      await stop(a);
      await stop(b);
      await stop(c);
    }
  }, 15_000);

  test('consistent-hashing: same key always lands on same node', async () => {
    const sysName = 'cr-ch';
    const a = await startNode(sysName, 70_011, [], []);
    const b = await startNode(sysName, 70_012, [`${sysName}@h:70011`], []);
    const c = await startNode(sysName, 70_013, [`${sysName}@h:70011`], []);
    try {
      await waitFor(() => a.cluster.upMembers().length === 3);

      const routerOptions = ClusterRouterOptions.create<{ kind: 'work'; id: string }>()
        .withCluster(a.cluster)
        .withRouterType('consistent-hashing')
        .withRouteePath('/user/worker')
        .withExtractKey((m) => m.id);
      const router = a.sys.spawn(
        ClusterRouter.props<{ kind: 'work'; id: string }>(routerOptions),
        'ch-router',
      );
      await sleep(50);

      // Send the SAME key 5 times.  All 5 must land on exactly one node.
      for (let i = 0; i < 5; i++) {
        router.tell({ kind: 'work', id: 'always-same' });
      }
      // Send a DIFFERENT key 5 times — also pinned, but to whichever node.
      for (let i = 0; i < 5; i++) {
        router.tell({ kind: 'work', id: 'other-key' });
      }

      await waitFor(() =>
        a.received.length + b.received.length + c.received.length === 10,
        5_000,
      );

      // All occurrences of each id should pile up on the same node.
      const groupsForKey = (key: string): number[] =>
        [a, b, c].map((n) => n.received.filter((id) => id === key).length);
      const same = groupsForKey('always-same');
      const other = groupsForKey('other-key');
      expect(same.filter((n) => n > 0).length).toBe(1);  // exactly one bucket
      expect(same.find((n) => n > 0)).toBe(5);
      expect(other.filter((n) => n > 0).length).toBe(1);
      expect(other.find((n) => n > 0)).toBe(5);
    } finally {
      await stop(a);
      await stop(b);
      await stop(c);
    }
  }, 15_000);

  test('role filter excludes nodes without the role', async () => {
    const sysName = 'cr-role';
    const a = await startNode(sysName, 70_021, [],                          ['compute']);
    const b = await startNode(sysName, 70_022, [`${sysName}@h:70021`], ['compute']);
    const c = await startNode(sysName, 70_023, [`${sysName}@h:70021`], ['frontend']); // wrong role
    try {
      await waitFor(() => a.cluster.upMembers().length === 3);

      const routerOptions = ClusterRouterOptions.create<{ kind: 'work'; id: string }>()
        .withCluster(a.cluster)
        .withRole('compute')
        .withRouterType('round-robin')
        .withRouteePath('/user/worker');
      const router = a.sys.spawn(
        ClusterRouter.props<{ kind: 'work'; id: string }>(routerOptions),
        'role-router',
      );
      await sleep(50);

      const N = 20;
      for (let i = 0; i < N; i++) {
        router.tell({ kind: 'work', id: `m-${i}` });
      }
      await waitFor(() => a.received.length + b.received.length === N, 5_000);

      // Node C carries 'frontend', so it should never be addressed.
      expect(c.received).toEqual([]);
      // The other two split the load.
      expect(a.received.length + b.received.length).toBe(N);
    } finally {
      await stop(a);
      await stop(b);
      await stop(c);
    }
  }, 15_000);

  test('member-removed: node leaves → routees rebuild → subsequent traffic skips the dead node', async () => {
    const sysName = 'cr-leave';
    const a = await startNode(sysName, 70_031, [],                          ['compute']);
    const b = await startNode(sysName, 70_032, [`${sysName}@h:70031`], ['compute']);
    const c = await startNode(sysName, 70_033, [`${sysName}@h:70031`], ['compute']);
    try {
      await waitFor(() => a.cluster.upMembers().length === 3);

      const routerOptions = ClusterRouterOptions.create<{ kind: 'work'; id: string }>()
        .withCluster(a.cluster)
        .withRole('compute')
        .withRouterType('round-robin')
        .withRouteePath('/user/worker');
      const router = a.sys.spawn(
        ClusterRouter.props<{ kind: 'work'; id: string }>(routerOptions),
        'leave-router',
      );
      await sleep(50);

      // First batch — all three nodes participate.  Wait for traffic
      // to *settle* (3 reads unchanged) rather than for an exact-9
      // equality; under CI load the cross-node tells can take a
      // couple of scheduler ticks to land and the equality predicate
      // would race the `===` window.  Settling is what the assertion
      // actually wants — the explicit `toBe(9)` lives outside the
      // wait.  See #76 for the failure mode this fixes.
      for (let i = 0; i < 9; i++) router.tell({ kind: 'work', id: `pre-${i}` });
      const after1st = await waitStable(
        () => a.received.length + b.received.length + c.received.length,
      );
      expect(after1st).toBe(9);

      // Node C leaves.  Wait for the cluster + router to register the
      // removal — `upMembers()` drops to 2.
      await c.cluster.leave();
      await waitFor(() => a.cluster.upMembers().length === 2);
      // Give the router one extra tick to rebuild routees off the
      // MemberRemoved event we just observed at the cluster level.
      await sleep(50);

      const cBefore = c.received.length;

      // Second batch — should not reach C anymore.  Same settle-vs-
      // equality logic as the first batch.
      for (let i = 0; i < 12; i++) router.tell({ kind: 'work', id: `post-${i}` });
      const after2nd = await waitStable(
        () => a.received.length + b.received.length + c.received.length,
      );
      expect(after2nd).toBe(9 + 12);

      expect(c.received.length).toBe(cBefore);  // nothing new arrived at C
      // The remaining two nodes split the 12 — round-robin, so 6/6.
      const aPost = a.received.filter((id) => id.startsWith('post-')).length;
      const bPost = b.received.filter((id) => id.startsWith('post-')).length;
      expect(aPost + bPost).toBe(12);
      expect(aPost).toBeGreaterThanOrEqual(5);
      expect(bPost).toBeGreaterThanOrEqual(5);
    } finally {
      await stop(a);
      await stop(b);
      await stop(c);
    }
  }, 15_000);

  test('Broadcast<T> reaches every routee', async () => {
    const sysName = 'cr-bc';
    const a = await startNode(sysName, 70_041, [], []);
    const b = await startNode(sysName, 70_042, [`${sysName}@h:70041`], []);
    const c = await startNode(sysName, 70_043, [`${sysName}@h:70041`], []);
    try {
      await waitFor(() => a.cluster.upMembers().length === 3);

      const routerOptions = ClusterRouterOptions.create<{ kind: 'work'; id: string }>()
        .withCluster(a.cluster)
        .withRouterType('round-robin')
        .withRouteePath('/user/worker');
      const router = a.sys.spawn(
        ClusterRouter.props<{ kind: 'work'; id: string }>(routerOptions),
        'bc-router',
      );
      await sleep(50);

      router.tell(new Broadcast({ kind: 'work', id: 'announce' }));
      await waitFor(() =>
        a.received.includes('announce')
        && b.received.includes('announce')
        && c.received.includes('announce'),
        5_000,
      );
      expect(a.received.filter((id) => id === 'announce')).toHaveLength(1);
      expect(b.received.filter((id) => id === 'announce')).toHaveLength(1);
      expect(c.received.filter((id) => id === 'announce')).toHaveLength(1);
    } finally {
      await stop(a);
      await stop(b);
      await stop(c);
    }
  }, 15_000);
});
