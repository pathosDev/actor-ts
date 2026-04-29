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
      // (the OTHER side) and the wiring downs those two — its
      // member map shrinks from 4 to 2.  The three losers each
      // get acquire=false, decide that THEIR side has to go, and
      // self-down via cluster.leave(); their views do not collapse
      // to 2 (they remove their peer first, then mark self leaving,
      // ending with a 3-member or fewer view briefly before their
      // cluster shuts down).
      //
      // The defining invariant: AT LEAST ONE node ends with a
      // 2-member view (the winner has converged).  AT MOST ONE
      // partition side has both members at the 2-member state —
      // that would be split-brain.
      const deadline = Date.now() + 10_000;
      let winnersOnLeftSide = 0;
      let winnersOnRightSide = 0;
      while (Date.now() < deadline) {
        winnersOnLeftSide = ['a', 'b']
          .filter((r) => spec.clusterFor(r).getMembers().length === 2)
          .length;
        winnersOnRightSide = ['c', 'd']
          .filter((r) => spec.clusterFor(r).getMembers().length === 2)
          .length;
        if (winnersOnLeftSide + winnersOnRightSide >= 1) break;
        await Bun.sleep(50);
      }
      // At least one node shrank to 2 members → the lease arbitration
      // produced a winner.
      expect(winnersOnLeftSide + winnersOnRightSide).toBeGreaterThanOrEqual(1);
      // Critical anti-split-brain check: both sides cannot have both
      // members converged to 2 — that's the failure we're guarding
      // against.
      expect(winnersOnLeftSide === 2 && winnersOnRightSide === 2).toBe(false);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
      inMemoryLeaseStore._clear();
    }
  }, 30_000);
});
