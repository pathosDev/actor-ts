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
import { MemberRemoved } from '../../src/cluster/ClusterEvents.js';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../src/cluster/Transport.js';
import { ClusterRouter, ClusterRouterOptions } from '../../src/cluster/router/index.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Broadcast } from '../../src/Router.js';
import { awaitCondition, sleep } from '../util/AwaitCondition.js';

// Generous, not 5 s, so the multi-node waits have headroom under CI load
// (issue #76 — the previous 5-s ceiling fired flakily on GitHub-hosted runners
// when other test files were sharing scheduler time, even though the
// predicates eventually held in well under a second locally).  It is a failure
// budget: nothing here pays it on a passing run.  Kept just under each test's
// own 15 s timeout so the diagnostic naming the condition wins that race.
const WAIT_TIMEOUT_MS = 12_000;

/**
 * Wait until `read()` returns the same value for `settleTicks` polls
 * in a row.  Replaces the flake-prone `awaitCondition(() => count === N)`
 * pattern when "no more messages will arrive" is the real predicate
 * and we just want to read the final tally.  Returns the settled
 * value so the caller can `expect()` it directly.
 *
 * Why this matters here (#76): the previous "exactly 21 received"
 * wait had no flush-fence behind it.  Under CI load a couple of the
 * cross-node tells could be in-flight when the loop fired the
 * cleanup; a longer timeout helped but didn't address the underlying
 * signal — "stop when traffic settles" is what the test really wants.
 *
 * This one keeps its own loop rather than going through `awaitCondition`:
 * quiescence is the absence of an event, so it is measured in elapsed time
 * by construction and there is no state to poll for.
 */
async function waitStable<T>(
  read: () => T,
  options: { settleTicks?: number; tickMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const settleTicks = options.settleTicks ?? 3;
  const tickMs = options.tickMs ?? 50;
  const timeoutMs = options.timeoutMs ?? 15_000;
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

type Node = {
  readonly role: string;
  readonly sys: ActorSystem;
  readonly cluster: Cluster;
  readonly received: string[];
};

type WorkMessage = { kind: 'work'; id: string };

const WARM_UP_ID = 'routee-warm-up';

/**
 * Wait until the router has built its routee set, then reset the tallies the
 * warm-up traffic left behind.
 *
 * `ClusterRouter` rebuilds its routees in `preStart` and **drops** anything
 * that arrives before that — it deliberately does not queue — so a batch sent
 * too early is lost outright and the wait for it dies 15 s later naming
 * nothing.  The 50 ms this replaces was one scheduler tick on an idle box.
 *
 * Delivery is the only observable the router offers (`currentRoutees` is
 * protected), so warm up with a throwaway id until one lands.  One delivery is
 * enough to prove the whole set: the rebuild is a single synchronous pass over
 * `upMembers()`, and every test already waited for that to be 3, so the set is
 * never partially built.  The `waitStable` fence matters — without it a
 * warm-up still in flight lands after the reset and shows up in the batch the
 * test is counting.
 */
async function awaitRoutees(
  router: ActorRef<WorkMessage>, nodes: ReadonlyArray<Node>,
): Promise<void> {
  await awaitCondition(
    () => {
      router.tell({ kind: 'work', id: WARM_UP_ID });
      return nodes.some((node) => node.received.includes(WARM_UP_ID));
    },
    { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 25, label: 'the router built its routee set' },
  );
  await waitStable(() => nodes.reduce((total, node) => total + node.received.length, 0));
  for (const node of nodes) node.received.length = 0;
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
  sys.spawn(Worker, 'worker');

  return { role: roles[0] ?? 'no-role', sys, cluster, received };
}

async function stop(n: Node): Promise<void> {
  try { await n.cluster.leave(); } catch { /* ignore */ }
  await n.sys.terminate();
}

describe('ClusterRouter — multi-node', () => {
  test('round-robin distributes 30 messages roughly evenly across 3 role-matching nodes', async () => {
    const sysName = 'cr-rr';
    const nodeA = await startNode(sysName, 70_001, [], ['compute']);
    const nodeB = await startNode(sysName, 70_002, [`${sysName}@h:70001`], ['compute']);
    const nodeC = await startNode(sysName, 70_003, [`${sysName}@h:70001`], ['compute']);
    try {
      await awaitCondition(
        () => nodeA.cluster.upMembers().length === 3,
        { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 25, label: 'all three nodes are up in A\'s view' },
      );

      // Router lives on node A; routees include all three nodes.
      const routerOptions = ClusterRouterOptions.create<{ kind: 'work'; id: string }>()
        .withCluster(nodeA.cluster)
        .withRole('compute')
        .withRouterType('round-robin')
        .withRouteePath('/user/worker');
      const router = nodeA.sys.spawn(
        ClusterRouter.factory<{ kind: 'work'; id: string }>(routerOptions),
        'rr-router',
      );
      await awaitRoutees(router, [nodeA, nodeB, nodeC]);

      const N = 30;
      for (let i = 0; i < N; i++) {
        router.tell({ kind: 'work', id: `m-${i}` });
      }

      await awaitCondition(
        () => nodeA.received.length + nodeB.received.length + nodeC.received.length === N,
        { timeoutMs: 5_000, intervalMs: 25, label: `all ${N} messages were routed` },
      );

      // Each node should receive 10 ± a small slack — round-robin is
      // strict but the routee-rebuild order of the `upMembers` set
      // could put any node at index 0.  We assert "no node is starved".
      expect(nodeA.received.length).toBeGreaterThanOrEqual(8);
      expect(nodeA.received.length).toBeLessThanOrEqual(12);
      expect(nodeB.received.length).toBeGreaterThanOrEqual(8);
      expect(nodeB.received.length).toBeLessThanOrEqual(12);
      expect(nodeC.received.length).toBeGreaterThanOrEqual(8);
      expect(nodeC.received.length).toBeLessThanOrEqual(12);
    } finally {
      await stop(nodeA);
      await stop(nodeB);
      await stop(nodeC);
    }
  }, 15_000);

  test('consistent-hashing: same key always lands on same node', async () => {
    const sysName = 'cr-ch';
    const nodeA = await startNode(sysName, 70_011, [], []);
    const nodeB = await startNode(sysName, 70_012, [`${sysName}@h:70011`], []);
    const nodeC = await startNode(sysName, 70_013, [`${sysName}@h:70011`], []);
    try {
      await awaitCondition(
        () => nodeA.cluster.upMembers().length === 3,
        { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 25, label: 'all three nodes are up in A\'s view' },
      );

      const routerOptions = ClusterRouterOptions.create<{ kind: 'work'; id: string }>()
        .withCluster(nodeA.cluster)
        .withRouterType('consistent-hashing')
        .withRouteePath('/user/worker')
        .withExtractKey((m) => m.id);
      const router = nodeA.sys.spawn(
        ClusterRouter.factory<{ kind: 'work'; id: string }>(routerOptions),
        'ch-router',
      );
      await awaitRoutees(router, [nodeA, nodeB, nodeC]);

      // Send the SAME key 5 times.  All 5 must land on exactly one node.
      for (let i = 0; i < 5; i++) {
        router.tell({ kind: 'work', id: 'always-same' });
      }
      // Send a DIFFERENT key 5 times — also pinned, but to whichever node.
      for (let i = 0; i < 5; i++) {
        router.tell({ kind: 'work', id: 'other-key' });
      }

      await awaitCondition(
        () => nodeA.received.length + nodeB.received.length + nodeC.received.length === 10,
        { timeoutMs: 5_000, intervalMs: 25, label: 'all ten keyed messages were routed' },
      );

      // All occurrences of each id should pile up on the same node.
      const groupsForKey = (key: string): number[] =>
        [nodeA, nodeB, nodeC].map((n) => n.received.filter((id) => id === key).length);
      const same = groupsForKey('always-same');
      const other = groupsForKey('other-key');
      expect(same.filter((n) => n > 0).length).toBe(1);  // exactly one bucket
      expect(same.find((n) => n > 0)).toBe(5);
      expect(other.filter((n) => n > 0).length).toBe(1);
      expect(other.find((n) => n > 0)).toBe(5);
    } finally {
      await stop(nodeA);
      await stop(nodeB);
      await stop(nodeC);
    }
  }, 15_000);

  test('role filter excludes nodes without the role', async () => {
    const sysName = 'cr-role';
    const nodeA = await startNode(sysName, 70_021, [],                          ['compute']);
    const nodeB = await startNode(sysName, 70_022, [`${sysName}@h:70021`], ['compute']);
    const nodeC = await startNode(sysName, 70_023, [`${sysName}@h:70021`], ['frontend']); // wrong role
    try {
      await awaitCondition(
        () => nodeA.cluster.upMembers().length === 3,
        { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 25, label: 'all three nodes are up in A\'s view' },
      );

      const routerOptions = ClusterRouterOptions.create<{ kind: 'work'; id: string }>()
        .withCluster(nodeA.cluster)
        .withRole('compute')
        .withRouterType('round-robin')
        .withRouteePath('/user/worker');
      const router = nodeA.sys.spawn(
        ClusterRouter.factory<{ kind: 'work'; id: string }>(routerOptions),
        'role-router',
      );
      // Only A and B carry the role, so only they can answer the warm-up —
      // and C receiving one would already be the bug this test is about.
      await awaitRoutees(router, [nodeA, nodeB, nodeC]);

      const N = 20;
      for (let i = 0; i < N; i++) {
        router.tell({ kind: 'work', id: `m-${i}` });
      }
      await awaitCondition(
        () => nodeA.received.length + nodeB.received.length === N,
        { timeoutMs: 5_000, intervalMs: 25, label: `all ${N} messages reached the role-matching nodes` },
      );

      // Node C carries 'frontend', so it should never be addressed.
      expect(nodeC.received).toEqual([]);
      // The other two split the load.
      expect(nodeA.received.length + nodeB.received.length).toBe(N);
    } finally {
      await stop(nodeA);
      await stop(nodeB);
      await stop(nodeC);
    }
  }, 15_000);

  test('member-removed: node leaves → routees rebuild → subsequent traffic skips the dead node', async () => {
    const sysName = 'cr-leave';
    const nodeA = await startNode(sysName, 70_031, [],                          ['compute']);
    const nodeB = await startNode(sysName, 70_032, [`${sysName}@h:70031`], ['compute']);
    const nodeC = await startNode(sysName, 70_033, [`${sysName}@h:70031`], ['compute']);
    try {
      await awaitCondition(
        () => nodeA.cluster.upMembers().length === 3,
        { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 25, label: 'all three nodes are up in A\'s view' },
      );

      const routerOptions = ClusterRouterOptions.create<{ kind: 'work'; id: string }>()
        .withCluster(nodeA.cluster)
        .withRole('compute')
        .withRouterType('round-robin')
        .withRouteePath('/user/worker');
      const router = nodeA.sys.spawn(
        ClusterRouter.factory<{ kind: 'work'; id: string }>(routerOptions),
        'leave-router',
      );
      await awaitRoutees(router, [nodeA, nodeB, nodeC]);

      // First batch — all three nodes participate.  Wait for traffic
      // to *settle* (3 reads unchanged) rather than for an exact-9
      // equality; under CI load the cross-node tells can take a
      // couple of scheduler ticks to land and the equality predicate
      // would race the `===` window.  Settling is what the assertion
      // actually wants — the explicit `toBe(9)` lives outside the
      // wait.  See #76 for the failure mode this fixes.
      for (let i = 0; i < 9; i++) router.tell({ kind: 'work', id: `pre-${i}` });
      const after1st = await waitStable(
        () => nodeA.received.length + nodeB.received.length + nodeC.received.length,
      );
      expect(after1st).toBe(9);

      // Node C leaves.  The router rebuilds its routees from a
      // `cluster.subscribe` callback, and `Cluster.emit` walks its listeners
      // synchronously in registration order — the router registered in
      // `preStart`, which `awaitRoutees` has already proved ran, so it is
      // ahead of the listener below.  A `MemberRemoved` seen here therefore
      // means the router has already rebuilt: exactly what the "one extra
      // tick" of 50 ms was guessing at, and the guess is what would let the
      // second batch reach C and fail the assertion further down.
      let routerRebuiltAfterRemoval = false;
      const unsubscribe = nodeA.cluster.subscribe((event) => {
        if (event instanceof MemberRemoved) routerRebuiltAfterRemoval = true;
      });
      try {
        await nodeC.cluster.leave();
        await awaitCondition(
          () => routerRebuiltAfterRemoval && nodeA.cluster.upMembers().length === 2,
          {
            timeoutMs: WAIT_TIMEOUT_MS,
            intervalMs: 25,
            label: 'the router rebuilt its routees after C was removed',
          },
        );
      } finally {
        unsubscribe();
      }

      const cBefore = nodeC.received.length;

      // Second batch — should not reach C anymore.  Same settle-vs-
      // equality logic as the first batch.
      for (let i = 0; i < 12; i++) router.tell({ kind: 'work', id: `post-${i}` });
      const after2nd = await waitStable(
        () => nodeA.received.length + nodeB.received.length + nodeC.received.length,
      );
      expect(after2nd).toBe(9 + 12);

      expect(nodeC.received.length).toBe(cBefore);  // nothing new arrived at C
      // The remaining two nodes split the 12 — round-robin, so 6/6.
      const aPost = nodeA.received.filter((id) => id.startsWith('post-')).length;
      const bPost = nodeB.received.filter((id) => id.startsWith('post-')).length;
      expect(aPost + bPost).toBe(12);
      expect(aPost).toBeGreaterThanOrEqual(5);
      expect(bPost).toBeGreaterThanOrEqual(5);
    } finally {
      await stop(nodeA);
      await stop(nodeB);
      await stop(nodeC);
    }
  }, 15_000);

  test('Broadcast<T> reaches every routee', async () => {
    const sysName = 'cr-bc';
    const nodeA = await startNode(sysName, 70_041, [], []);
    const nodeB = await startNode(sysName, 70_042, [`${sysName}@h:70041`], []);
    const nodeC = await startNode(sysName, 70_043, [`${sysName}@h:70041`], []);
    try {
      await awaitCondition(
        () => nodeA.cluster.upMembers().length === 3,
        { timeoutMs: WAIT_TIMEOUT_MS, intervalMs: 25, label: 'all three nodes are up in A\'s view' },
      );

      const routerOptions = ClusterRouterOptions.create<{ kind: 'work'; id: string }>()
        .withCluster(nodeA.cluster)
        .withRouterType('round-robin')
        .withRouteePath('/user/worker');
      const router = nodeA.sys.spawn(
        ClusterRouter.factory<{ kind: 'work'; id: string }>(routerOptions),
        'bc-router',
      );
      await awaitRoutees(router, [nodeA, nodeB, nodeC]);

      router.tell(new Broadcast({ kind: 'work', id: 'announce' }));
      await awaitCondition(
        () => nodeA.received.includes('announce')
          && nodeB.received.includes('announce')
          && nodeC.received.includes('announce'),
        { timeoutMs: 5_000, intervalMs: 25, label: 'the broadcast reached all three routees' },
      );
      expect(nodeA.received.filter((id) => id === 'announce')).toHaveLength(1);
      expect(nodeB.received.filter((id) => id === 'announce')).toHaveLength(1);
      expect(nodeC.received.filter((id) => id === 'announce')).toHaveLength(1);
    } finally {
      await stop(nodeA);
      await stop(nodeB);
      await stop(nodeC);
    }
  }, 15_000);
});
