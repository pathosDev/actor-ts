import { describe, expect, test } from 'bun:test';
import { KeepMajority } from '../../src/cluster/downing/index.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';

/**
 * The split-brain stability window runs on the same clock as the failure
 * detector in front of it (#1424).
 *
 * `Cluster.evaluateDowning` used to read `Date.now()` for the window while the
 * detector read `system.clock`.  Under a shared `ManualScheduler` the detector
 * therefore marked a crashed node unreachable in virtual time, and the window
 * in front of the strategy never elapsed: twenty virtual seconds removed
 * nothing, where the same spec on real time removed the node after about
 * 4.5 s.  A spec on a virtual clock could not exercise a downing strategy at
 * all.
 *
 * Both edges of the window are asserted on virtual time — still unreachable
 * shortly before `stable-after` has passed, removed shortly after — so the
 * removal is the resolver's and is neither early nor merely eventual.
 */

const ROLES = ['a', 'b', 'c'] as const;
const SURVIVORS = ['a', 'b'] as const;

const HEARTBEAT_INTERVAL_MS = 300;
const GOSSIP_INTERVAL_MS = 100;
const STABLE_AFTER_MS = 3_000;

const FAILURE_DETECTOR = {
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  unreachableAfterMs: 1_500,
  // Far beyond every budget below, so the removal is the resolver's decision
  // and never the detector's elapsed-time fallback.
  downAfterMs: 60_000,
} as const;

/**
 * The window is evaluated on the detection tick, so it closes up to one
 * heartbeat after `stable-after`; `advanceUntil` observes the unreachable mark
 * up to one gossip step late.  The decision then has to be applied, which is
 * the same tick.  Two heartbeats cover both with margin and stay far short of
 * a second window.
 */
const WINDOW_RESOLUTION_MS = 2 * HEARTBEAT_INTERVAL_MS;

/** Whether `role` still holds `crashed` as a live member. */
function holds(spec: MultiNodeSpec, role: string, crashed: string, status?: string): boolean {
  const address = spec.addressFor(crashed);
  return spec.clusterFor(role).getMembers().some((member) =>
    member.address.equals(address)
    && member.status !== 'removed'
    && (status === undefined || member.status === status));
}

/**
 * Advance `ms` of virtual time one gossip interval at a time.
 *
 * Not `spec.advance(ms)` in one call: that fires every timer due in the span
 * before any node settles, so the detection ticks run while the heartbeats
 * they should have seen are still undelivered — 2.4 s in one call made `a`
 * mark the healthy `b` unreachable, which restarted the window and moved the
 * removal by a whole `stable-after`.
 */
async function advanceInGossipSteps(spec: MultiNodeSpec, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += GOSSIP_INTERVAL_MS) {
    await spec.advance(Math.min(GOSSIP_INTERVAL_MS, ms - elapsed));
  }
}

describe('the downing stability window is measured on the virtual clock', () => {
  test('KeepMajority removes a crashed node within stable-after of virtual time', async () => {
    const scheduler = new ManualScheduler();
    const options = MultiNodeSpecOptions.create()
      .withRoles([...ROLES])
      .withFailureDetector({ ...FAILURE_DETECTOR })
      .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
      .withStableAfterMs(STABLE_AFTER_MS)
      .withScheduler(scheduler)
      .withDowning(() => new KeepMajority());
    const spec = new MultiNodeSpec(options);
    try {
      await spec.start();
      await spec.advanceUntil(
        () => ROLES.every((role) => spec.clusterFor(role).upMembers().length === ROLES.length),
        { budgetMs: 30_000, description: 'every node sees all three members up' },
      );

      await spec.crash('c');
      await spec.advanceUntil(
        () => SURVIVORS.every((role) => holds(spec, role, 'c', 'unreachable')),
        { budgetMs: 10_000, description: 'both survivors mark c unreachable' },
      );

      // Inside the window: the view has not been still for `stable-after` yet,
      // so the strategy has not been asked.
      await advanceInGossipSteps(spec, STABLE_AFTER_MS - WINDOW_RESOLUTION_MS);
      for (const role of SURVIVORS) {
        expect(holds(spec, role, 'c', 'unreachable'), `${role} removed c before the window closed`).toBe(true);
      }

      // Past it: the strategy decides on the settled view and c goes.  Before
      // the window read `system.clock`, this never happened on a virtual clock.
      await spec.advanceUntil(
        () => SURVIVORS.every((role) => !holds(spec, role, 'c')),
        {
          budgetMs: 2 * WINDOW_RESOLUTION_MS,
          description: 'both survivors removed c once the stability window closed',
        },
      );
      for (const role of SURVIVORS) {
        expect(spec.clusterFor(role).upMembers().length).toBe(SURVIVORS.length);
      }
    } finally {
      await spec.stop();
    }
  }, 60_000);
});
