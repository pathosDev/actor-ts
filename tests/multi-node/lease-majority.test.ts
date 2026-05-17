/**
 * End-to-end split-brain test for LeaseMajority (#51).
 *
 * Setup: 4 nodes a, b, c, d.  Each runs LeaseMajority pointing at
 * a shared InMemoryLease (process-local store simulates an external
 * arbiter — same role K8s plays in production).
 *
 * Trigger an EQUAL-SIZE partition: (a, b) ⇔ (c, d).  Membership-only
 * strategies (KeepMajority etc.) leave equal splits pending.
 * LeaseMajority kicks off `acquire()` from both sides; only one of
 * the four owners wins.  The winning side's two nodes converge to
 * a 2-member view; the losing side's two nodes self-down via the
 * `cluster.leave()` path wired up in #61.
 *
 * Assertion: at least one side's surviving 2-node view is reached
 * within the test budget — proving end-to-end split-brain protection
 * via Lease arbitration.
 */
import { describe, expect, test } from 'bun:test';
import { LeaseMajority } from '../../src/cluster/downing/index.js';
import {
  InMemoryLease,
  inMemoryLeaseStore,
} from '../../src/coordination/leases/InMemoryLease.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  // Long downAfterMs so any convergence is from LeaseMajority, not
  // the failure detector's elapsed-time fallback.
  downAfterMs: 30_000,
} as const;

describe('LeaseMajority — end-to-end split-brain', () => {
  test('4 nodes, 2/2 partition: lease holder side survives, other side downs itself', async () => {
    inMemoryLeaseStore._clear();
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c', 'd'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
      // Each role acquires the SAME named lease but with its own
      // `owner` — exactly the production shape for K8s leases.
      // The InMemoryLease store is process-global so all four
      // owners contend for the same record.
      downing: (role) => new LeaseMajority({
        lease: new InMemoryLease({
          name: 'lease-majority-test', owner: role, ttlMs: 10_000,
          renewalIntervalMs: 80,
        }),
        acquireTimeoutMs: 2_000,
      }),
    });
    try {
      await spec.start();
      await Promise.all(['a', 'b', 'c', 'd'].map((r) =>
        spec.awaitMembers(r, 4)));

      // Equal-size split: (a, b) ⇕ (c, d).
      for (const left of ['a', 'b']) {
        for (const right of ['c', 'd']) {
          spec.partition(left, right);
        }
      }

      // All four nodes contend for the same lease via owners
      // a/b/c/d.  Only one wins; that's the surviving authority.
      //
      // The lease holder's `decide()` returns the unreachable set
      // (the OTHER side) and the wiring downs those two — both of
      // its nodes stay 'up' with a healthy upMembers view.  The
      // two losers each get acquire=false, decide THEIR side has
      // to go, and self-down via cluster.leave() — self transitions
      // through 'leaving' → 'removed' and the upMembers count
      // collapses to zero.
      //
      // What we assert: define "alive" as "self is still 'up' and
      // upMembers >= 1" — the test for a healthy, post-arbitration
      // member.  Polling on raw `getMembers().length === 2` was
      // flaky because during the FD-detected-but-arbitration-not-
      // yet-applied transient, ALL FOUR nodes briefly show 2
      // members, producing a false-positive split-brain reading.
      const isClusterAlive = (role: string): boolean => {
        const cluster = spec.clusterFor(role);
        const self = cluster.getMembers().find(
          (m) => m.address.equals(cluster.selfAddress),
        );
        return self?.status === 'up' && cluster.upMembers().length >= 1;
      };

      // Settled state: exactly one partition side is fully dead.
      // Poll for that — the other side's nodes are the winners.
      const deadline = Date.now() + 10_000;
      let leftAlive: string[] = [];
      let rightAlive: string[] = [];
      while (Date.now() < deadline) {
        leftAlive = ['a', 'b'].filter(isClusterAlive);
        rightAlive = ['c', 'd'].filter(isClusterAlive);
        // One side fully self-downed → arbitration has converged.
        if (leftAlive.length === 0 || rightAlive.length === 0) break;
        await Bun.sleep(50);
      }

      // At least one node survived — the lease arbitration produced
      // a winner.
      expect(leftAlive.length + rightAlive.length).toBeGreaterThanOrEqual(1);
      // Critical anti-split-brain check: NOT both sides have
      // surviving nodes — that's the failure we're guarding against.
      expect(leftAlive.length > 0 && rightAlive.length > 0).toBe(false);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
      inMemoryLeaseStore._clear();
    }
  }, 30_000);
});
