import { describe, expect, test } from 'bun:test';
import { MemberReachable } from '../../src/cluster/ClusterEvents.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';
import { converged } from './internal/ClusterBookkeeping.js';

/**
 * #1828 — under asymmetric reachability a member does not flap between `up`
 * and `unreachable`.
 *
 * One-way partition: nothing `b` sends reaches `a`, while `a → b` and every
 * link to and from `c` work.  `a`'s detector marks `b` unreachable and gossips
 * it.  `c` still hears `b`, and its `onHeartbeat` used to flip `b` back to `up`
 * on the next heartbeat — at a higher version, so `a` adopted it, re-marked
 * `b` on its next detection tick, and the status went back and forth at
 * heartbeat cadence, with a `MemberReachable` / `MemberUnreachable` pair (and
 * the leader-change info line #994 added) every time.
 *
 * Now a heartbeat clears an `unreachable` mark at once only on the node whose
 * own detector made it; a node holding the mark on another's word clears it
 * once its own detector has heard the member for `stable-after`, so a dead
 * observer cannot pin a healthy member at `unreachable` for good.
 *
 * Auto-down is off, so nothing is removed and the status is all there is to
 * watch.  Virtual time, advanced one gossip interval per step (see
 * `DowningVirtualClock.test.ts` for why one large `advance` is wrong).
 */

const ROLES = ['a', 'b', 'c'] as const;
const GOSSIP_INTERVAL_MS = 100;
const FAILURE_DETECTOR = { heartbeatIntervalMs: 200, unreachableAfterMs: 1_000, downAfterMs: 2_000 } as const;

function statusOf(spec: MultiNodeSpec, observer: string, subject: string): string {
  const address = spec.addressFor(subject);
  return spec.clusterFor(observer).getMembers().find((member) => member.address.equals(address))?.status ?? 'absent';
}

async function advanceInGossipSteps(spec: MultiNodeSpec, ms: number, onStep: () => void = () => {}): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += GOSSIP_INTERVAL_MS) {
    await spec.advance(Math.min(GOSSIP_INTERVAL_MS, ms - elapsed));
    onStep();
  }
}

function specWith(stableAfterMs: number): MultiNodeSpec {
  const options = MultiNodeSpecOptions.create()
    .withRoles(ROLES)
    .withFailureDetector({ ...FAILURE_DETECTOR })
    .withFailureDetectorAutoDown(false)
    .withStableAfterMs(stableAfterMs)
    .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
    .withScheduler(new ManualScheduler());
  return new MultiNodeSpec(options);
}

/** The addresses `role` holds unreachable on a peer's word — private state, read on purpose. */
function peerWordMarksOf(spec: MultiNodeSpec, role: string): string[] {
  const internals = spec.clusterFor(role) as unknown as { readonly unreachableOnPeerWordSince: Map<string, number> };
  return [...internals.unreachableOnPeerWordSince.keys()];
}

/** Every `MemberReachable` for `subject`, per observer. */
function countReachableEvents(spec: MultiNodeSpec, observers: ReadonlyArray<string>, subject: string): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(observers.map((role) => [role, 0]));
  for (const role of observers) {
    spec.clusterFor(role).subscribe((event) => {
      if (event instanceof MemberReachable && event.member.address.equals(spec.addressFor(subject))) counts[role]! += 1;
    });
  }
  return counts;
}

describe('asymmetric reachability does not flap a member (#1828)', () => {
  test('a one-way partition keeps b unreachable everywhere, and healing the link brings it back at once', async () => {
    const spec = specWith(20_000);
    try {
      await spec.start();
      await spec.advanceUntil(() => converged(spec, ROLES), { budgetMs: 30_000, description: 'the three nodes converge' });
      const reachable = countReachableEvents(spec, ['a', 'c'], 'b');

      spec.faultsFor('b').degradeTo(spec.addressFor('a'), { dropProbability: 1 });
      await spec.advanceUntil(() => statusOf(spec, 'a', 'b') === 'unreachable' && statusOf(spec, 'c', 'b') === 'unreachable', {
        budgetMs: 5_000, description: 'a marks b unreachable and c learns it',
      });

      // Fifteen seconds — well inside one stable-after — of a link that stays
      // one-way: the mark holds on both nodes at every step.
      const flips: string[] = [];
      await advanceInGossipSteps(spec, 15_000, () => {
        for (const observer of ['a', 'c']) {
          const status = statusOf(spec, observer, 'b');
          if (status !== 'unreachable') flips.push(`${observer} saw b ${status}`);
        }
      });
      expect(flips).toEqual([]);
      expect(reachable).toEqual({ a: 0, c: 0 });

      // The observer clears its own mark on the first heartbeat that gets
      // through, without waiting out stable-after.
      spec.faultsFor('b').restoreTo(spec.addressFor('a'));
      await spec.advanceUntil(() => converged(spec, ROLES), { budgetMs: 3_000, description: 'b is up everywhere once the link heals' });
      // And the bookkeeping behind the rule goes with the mark.
      for (const role of ROLES) expect(peerWordMarksOf(spec, role), role).toEqual([]);
    } finally {
      await spec.stop();
    }
  }, 60_000);

  test('a node that first sees b through gossip, already marked, does not flap it either', async () => {
    const spec = specWith(20_000);
    try {
      await spec.start();
      await spec.advanceUntil(() => converged(spec, ROLES), { budgetMs: 30_000, description: 'the three nodes converge' });
      spec.faultsFor('b').degradeTo(spec.addressFor('a'), { dropProbability: 1 });
      await spec.advanceUntil(() => statusOf(spec, 'c', 'b') === 'unreachable', {
        budgetMs: 5_000, description: 'c learns a\'s mark on b',
      });

      // A new run of c learns b for the first time from a gossip record that
      // already says `unreachable`.
      await spec.restart('c');
      await spec.advanceUntil(() => statusOf(spec, 'c', 'b') === 'unreachable', {
        budgetMs: 5_000, description: 'the new run of c learns b, marked',
      });
      const flips: string[] = [];
      await advanceInGossipSteps(spec, 10_000, () => {
        const status = statusOf(spec, 'c', 'b');
        if (status !== 'unreachable') flips.push(`c saw b ${status}`);
      });
      expect(flips).toEqual([]);
    } finally {
      await spec.stop();
    }
  }, 60_000);

  test('a node whose own detector also lost the member clears the mark as soon as it hears it again', async () => {
    const spec = specWith(20_000);
    try {
      await spec.start();
      await spec.advanceUntil(() => converged(spec, ROLES), { budgetMs: 30_000, description: 'the three nodes converge' });
      spec.faultsFor('b').degradeTo(spec.addressFor('a'), { dropProbability: 1 });
      await spec.advanceUntil(() => statusOf(spec, 'c', 'b') === 'unreachable', {
        budgetMs: 5_000, description: 'c learns a\'s mark on b',
      });
      // The observer is gone, and then c stops hearing b itself: the mark is
      // c's own now, and the next heartbeat that gets through answers it.
      await spec.crash('a');
      spec.faultsFor('b').degradeTo(spec.addressFor('c'), { dropProbability: 1 });
      await advanceInGossipSteps(spec, 2_000);
      spec.faultsFor('b').restoreTo(spec.addressFor('c'));
      await spec.advanceUntil(() => statusOf(spec, 'c', 'b') === 'up', {
        budgetMs: 2_000, description: 'c clears its own mark on b without waiting out stable-after',
      });
    } finally {
      await spec.stop();
    }
  }, 60_000);

  test('a mark whose observer is gone is cleared after stable-after by a node that hears the member', async () => {
    const spec = specWith(3_000);
    try {
      await spec.start();
      await spec.advanceUntil(() => converged(spec, ROLES), { budgetMs: 30_000, description: 'the three nodes converge' });

      spec.faultsFor('b').degradeTo(spec.addressFor('a'), { dropProbability: 1 });
      await spec.advanceUntil(() => statusOf(spec, 'c', 'b') === 'unreachable', {
        budgetMs: 5_000, description: 'c learns a\'s mark on b',
      });
      // The only node that observed b silent goes away with its mark standing.
      await spec.crash('a');
      await spec.advanceUntil(() => statusOf(spec, 'c', 'b') === 'up', {
        budgetMs: 6_000, description: 'c clears the orphaned mark once it has heard b for stable-after',
      });
      expect(statusOf(spec, 'b', 'b')).toBe('up');
    } finally {
      await spec.stop();
    }
  }, 60_000);
});
