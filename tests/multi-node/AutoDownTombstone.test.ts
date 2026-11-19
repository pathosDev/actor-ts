import { describe, expect, test } from 'bun:test';
import { MemberRemoved } from '../../src/cluster/ClusterEvents.js';
import type { Member } from '../../src/cluster/Member.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';
import { converged } from './internal/ClusterBookkeeping.js';

/**
 * #1834 — under the shipped configuration (auto-down on, no split-brain
 * strategy) a crashed node is removed once, for good.
 *
 * The failure detector's own removal used to delete the member where every
 * other removal tombstones it.  With two survivors that did not delete it in
 * the same step, the one that had not yet deleted it gossiped it back to the
 * one that had, as `unreachable`, and the cycle repeated on every `down-after`
 * — a `MemberRemoved` each time, and on the virtual clock the two survivors
 * never once agreed the node was gone.  The removal now leaves a tombstone,
 * which out-versions every record a survivor still holds for the crashed run.
 *
 * Virtual time, advanced one gossip interval per step (see
 * `DowningVirtualClock.test.ts` for why one large `advance` is wrong).
 */

const ROLES = ['a', 'b', 'c'] as const;
const SURVIVORS = ['a', 'c'] as const;
const GOSSIP_INTERVAL_MS = 100;
/** Fifteen times `down-after`: the issue's window, in which nothing converged. */
const OBSERVE_MS = 30_000;

function membershipRecordOf(spec: MultiNodeSpec, observer: string, subject: string): Member | undefined {
  const members = (spec.clusterFor(observer) as unknown as { readonly members: Map<string, Member> }).members;
  return members.get(spec.addressFor(subject).toString());
}

describe('auto-down with no strategy removes a crashed node for good (#1834)', () => {
  test('both survivors forget the crashed node, keep its tombstone, and announce its removal once', async () => {
    const options = MultiNodeSpecOptions.create()
      .withRoles(ROLES)
      .withFailureDetector({ heartbeatIntervalMs: 200, unreachableAfterMs: 1_000, downAfterMs: 2_000 })
      .withFailureDetectorAutoDown(true)
      .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
      .withScheduler(new ManualScheduler());
    const spec = new MultiNodeSpec(options);
    try {
      await spec.start();
      await spec.advanceUntil(() => converged(spec, ROLES), { budgetMs: 30_000, description: 'the three nodes converge' });

      const removals: Record<string, number> = { a: 0, c: 0 };
      for (const role of SURVIVORS) {
        spec.clusterFor(role).subscribe((event) => {
          if (event instanceof MemberRemoved && event.member.address.equals(spec.addressFor('b'))) removals[role]! += 1;
        });
      }

      await spec.crash('b');
      const holdsB = (role: string): boolean =>
        spec.clusterFor(role).getMembers().some((member) => member.address.equals(spec.addressFor('b')));
      let bothForgotAt: number | null = null;
      for (let elapsed = 0; elapsed < OBSERVE_MS; elapsed += GOSSIP_INTERVAL_MS) {
        await spec.advance(GOSSIP_INTERVAL_MS);
        const forgotten = SURVIVORS.every((role) => !holdsB(role));
        if (forgotten && bothForgotAt === null) bothForgotAt = elapsed;
        // Once gone it stays gone: no survivor's gossip brings it back.
        if (bothForgotAt !== null) expect(forgotten, `b came back at ${elapsed} ms`).toBe(true);
      }

      expect(bothForgotAt).not.toBeNull();
      for (const role of SURVIVORS) {
        expect(membershipRecordOf(spec, role, 'b')?.status, `${role} keeps b's tombstone`).toBe('removed');
        expect(removals[role], `${role} announced b's removal once`).toBe(1);
      }
    } finally {
      await spec.stop();
    }
  }, 60_000);
});
