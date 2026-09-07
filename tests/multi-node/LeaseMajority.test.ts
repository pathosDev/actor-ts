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
import { LeaseMajority, LeaseMajorityOptions } from '../../src/cluster/downing/index.js';
import {
  InMemoryLease,
  inMemoryLeaseStore,
} from '../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../src/coordination/LeaseOptions.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import { sleep } from '../util/AwaitCondition.js';

// Runs in CI.  This file was quarantined (`ACTOR_TS_SKIP_FLAKY_MNS=1`, #538) on
// a diagnosis that turned out to be wrong: the lease holder's renewal timer was
// said to be starved past its TTL by the same hosted-runner problem that was
// blamed for the worker-thread suites, so both sides re-acquired.
//
// The lease is never acquired by anybody in a failing run.  What happened is
// that the two remote peers crossed `unreachableAfterMs` on different
// failure-detector ticks, and downing was evaluated on each of them — so each
// side saw a majority twice in a row instead of an equal split once, and
// `LeaseMajority`'s arbitration was never reached.  #839's stability window
// makes the resolver wait for a view that has stopped moving, which is what
// this file's `splitBrainResolver` setting below asks for.
//
// Measured on one machine within one minute: 8 of 15 runs failed with the
// window disabled, 0 of 30 with it.  `tests/unit/cluster/downing/
// StaggeredDetection.test.ts` pins the arithmetic with no timing at all.

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
      // A window short enough for a test and long enough for its own
      // detections.  The production default is 20 s (#839) — the view has to
      // stop moving before a strategy is asked anything, or a partition
      // detected one peer at a time is resolved as a run of majorities.  Here
      // the two detections land within a heartbeat of each other, so 1 s is
      // several orders of margin and still inside the budgets below.
      splitBrainResolver: { stableAfterMs: 1_000 },
      // Each role acquires the SAME named lease but with its own
      // `owner` — exactly the production shape for K8s leases.
      // The InMemoryLease store is process-global so all four
      // owners contend for the same record.
      downing: (role) => {
        // 60s TTL (not 10s): the CI logs showed both partition sides
        // surviving — each had acquired the lease — because under heavy
        // CPU starvation the winner's renewal timer (every 80ms) was
        // delayed past a 10s TTL, the lease lapsed, and the other side
        // grabbed it.  A 60s TTL can't lapse within the test's 25s
        // arbitration window even under extreme timer jitter, so exactly
        // one side holds the lease.  (The starvation root cause — leaked
        // worker threads — is fixed in ParallelMultiNodeSpec; this is
        // defence-in-depth so the split-brain assertion can't flake.)
        const leaseOptions = LeaseOptions.create()
          .withName('lease-majority-test')
          .withOwner(role)
          .withTtlMs(60_000)
          .withRenewalIntervalMs(80);
        const leaseMajorityOptions = LeaseMajorityOptions.create()
          .withLease(new InMemoryLease(leaseOptions))
          .withAcquireTimeoutMs(2_000);
        return new LeaseMajority(leaseMajorityOptions);
      },
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
      //
      // 25s deadline (not 10s): the arbitration chain — FD marks the
      // peer unreachable, the losing owners' `acquire()` times out
      // (`acquireTimeoutMs: 2_000`), they `cluster.leave()`, and the
      // `leaving → removed` transition gossips out — is fast on a dev
      // box (<2s) but stretches badly on a loaded 2-vCPU CI runner
      // running this inside the full suite, where it blew past a 10s
      // budget (the original flake).  The loop still breaks the instant
      // one side dies, so the happy path stays quick.
      const deadline = Date.now() + 25_000;
      let leftAlive: string[] = [];
      let rightAlive: string[] = [];
      while (Date.now() < deadline) {
        leftAlive = ['a', 'b'].filter(isClusterAlive);
        rightAlive = ['c', 'd'].filter(isClusterAlive);
        // One side fully self-downed → arbitration has converged.
        if (leftAlive.length === 0 || rightAlive.length === 0) break;
        // Deliberately not an `awaitCondition`: falling through is *meaningful*
        // here.  A run in which neither side dies leaves both `leftAlive` and
        // `rightAlive` non-empty, and the anti-split-brain assertion below then
        // fails with the finding — "both sides survived" — instead of with a
        // generic "condition never became true".
        await sleep(50);
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
  }, 60_000);
});
