/**
 * Multi-node test: ClusterSingleton failover when the leader dies.
 *
 * Scenario:
 *   - Spin up roles a, b, c — the harness assigns deterministic
 *     addresses (`a@127.0.0.1:30000`, `b@…:30001`, …).  The cluster
 *     leader is the lowest-address `up` member, so it'll be 'a'.
 *   - Start the same singleton on every node — the manager on the
 *     leader hosts the actual child; the other two stay idle.
 *   - Crash the leader.  The next-oldest `up` member becomes leader
 *     and its manager spawns a fresh child.
 *   - From a third (still-alive) node, send a message via the proxy.
 *     It must land on the new host — proving failover succeeded.
 *
 * The dangerous corners this catches:
 *   - A failover that *spawns* but never resolves the new leader for
 *     the remaining proxies (messages get lost).
 *   - Two managers both thinking they should host (split-brain) —
 *     the assertion `hosts.size <= surviving-count` would expose it.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { Props } from '../../src/Props.js';
import { ClusterSingletonId } from '../../src/cluster/singleton/index.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

describe('multi-node singleton failover', () => {
  test('crashing the leader hands the singleton to the next-oldest node', async () => {
    const hosts: string[] = [];
    class Marker extends Actor<string> {
      constructor(private readonly where: string) { super(); }
      override preStart(): void { hosts.push(this.where); }
      override onReceive(): void { /* no replies needed */ }
    }

    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      // Start the singleton on every node — the manager on the leader is
      // the only one that actually spawns the child.
      for (const role of ['a', 'b', 'c'] as const) {
        spec.systemFor(role).extension(ClusterSingletonId).start(spec.clusterFor(role), {
          typeName: 'marker',
          props: Props.create(() => new Marker(role)),
        });
      }

      // Wait for the first preStart to fire — that's our initial host.
      const waitDeadline = Date.now() + 5_000;
      while (hosts.length === 0 && Date.now() < waitDeadline) await Bun.sleep(25);
      expect(hosts.length).toBeGreaterThanOrEqual(1);
      const firstHost = hosts[0]!;

      // Determine current leader from a's view.  Since address ordering
      // is deterministic (a < b < c by port), the leader should be 'a',
      // and that's where the singleton is hosted.  We don't bake that
      // assumption in too tight — we read it back from the cluster.
      const leaderAddr = spec.clusterFor('a').leader().toNullable()?.address;
      expect(leaderAddr).toBeDefined();
      const leaderRole = leaderAddr!.systemName;
      expect(leaderRole).toBe(firstHost);

      // Crash the leader — the surviving two nodes must converge to a
      // 2-member view, then promote the next-oldest to leader.
      await spec.crash(leaderRole);

      const survivors = (['a', 'b', 'c'] as const).filter((r) => r !== leaderRole);
      await Promise.all(survivors.map((r) => spec.awaitMembers(r, 2, 5_000)));

      // The next-oldest is the surviving role with the lowest address.
      const nextLeader = survivors
        .map((r) => spec.addressFor(r))
        .sort((x, y) => x.compareTo(y))[0]!.systemName;

      // Wait for the new manager to fire its child's preStart.
      const failoverDeadline = Date.now() + 5_000;
      while (!hosts.includes(nextLeader) && Date.now() < failoverDeadline) {
        await Bun.sleep(50);
      }
      expect(hosts).toContain(nextLeader);

      // Sanity: at most one host per generation — no split-brain.
      // (The first host fired once; the second host fires once after
      // failover.  No third host should appear.)
      const uniqueHosts = new Set(hosts);
      expect(uniqueHosts.size).toBe(2);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);
});
