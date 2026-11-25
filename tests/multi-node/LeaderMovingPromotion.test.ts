import { describe, expect, test } from 'bun:test';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';
import { converged } from './internal/ClusterBookkeeping.js';

/**
 * #1880: a promotion that moves the leader reaches every member in the round
 * it happens, not whenever gossip's one random target per round gets there.
 *
 * Restart the lowest address and the leader that promotes its new run hands
 * leadership to it.  Every member has to learn of that promptly, because the
 * hand-overs that follow a leader change bound their wait by a few gossip
 * rounds: the shard coordinator's registration barrier (#1272) waits
 * `3 × gossip + one register retry` for the regions' claims, then places
 * shards without them.  The promoting leader used to push its view to the
 * promoted member alone (#1747), and everyone else heard by the lottery.  A
 * member that lost it nine rounds running kept registering with the old
 * leader, whose coordinator drops a `Register` it is no longer leader for, and
 * the new leader placed that member's shards elsewhere while it still ran
 * them.  `RepeatedFaultEpisodes.test.ts` caught it once on CI, and it
 * reproduced with gossip's `Math.random` pinned to a seed.
 *
 * The assertion is on the round itself, not on a later convergence, and that
 * makes it deterministic.  Timers fire synchronously in `advance` and frames
 * are delivered only in the settle after it, so in the round the promotion
 * happens the promoting node's random push reaches one peer and nobody else
 * gossips the new view yet.  Of the two members that neither promoted nor were
 * promoted, at least one cannot have heard, unless the promotion itself tells
 * them.
 */

const ROLES = ['a', 'b', 'c', 'd'] as const;
const GOSSIP_INTERVAL_MS = 100;
const BUDGET_MS = 6_000;

describe('a promotion that moves the leader (#1880)', () => {
  test('every member sees the restarted lowest address lead in the round it is promoted', async () => {
    const options = MultiNodeSpecOptions.create()
      .withRoles([...ROLES])
      .withFailureDetector({ heartbeatIntervalMs: 200, unreachableAfterMs: 1_000, downAfterMs: 2_000 })
      .withFailureDetectorAutoDown(false)
      .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
      .withScheduler(new ManualScheduler());
    const spec = new MultiNodeSpec(options);
    try {
      await spec.start();
      await spec.advanceUntil(() => converged(spec, ROLES), { budgetMs: BUDGET_MS, description: 'the cluster formed' });

      await spec.restart('a');
      const newRun = spec.clusterFor('a').selfAddress.incarnation;
      const address = spec.addressFor('a');
      const seesNewRunUp = (observer: string): boolean => spec.clusterFor(observer).getMembers()
        .some((member) => member.address.equals(address) && member.address.incarnation === newRun && member.status === 'up');
      const others = ROLES.filter((role) => role !== 'a');

      // Settle what the restart's join already set moving, then go one gossip
      // round at a time until some member has promoted the new run.
      await spec.advance(0);
      for (let elapsed = 0; !others.some(seesNewRunUp); elapsed += GOSSIP_INTERVAL_MS) {
        if (elapsed >= BUDGET_MS) throw new Error(`nobody promoted the new run of a within ${BUDGET_MS} ms of virtual time`);
        await spec.advance(GOSSIP_INTERVAL_MS);
      }

      const view = (observer: string): string => `${observer} sees a ${seesNewRunUp(observer) ? 'up' : 'not up yet'}, `
        + `leader ${spec.clusterFor(observer).leader().fold(() => 'none', (member) => member.address.systemName)}`;
      for (const observer of others) {
        expect(view(observer)).toBe(`${observer} sees a up, leader a`);
      }
    } finally {
      await spec.stop();
    }
  }, 60_000);
});
