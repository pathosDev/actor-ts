import { describe, expect, test } from 'bun:test';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';

/**
 * #930 — a symmetric partition heals once the network does.
 *
 * Gossip and heartbeats used to go to reachable members only, so the moment
 * each side marked the other `unreachable` neither sent the other anything
 * again, and nothing could ever observe that the link was back: both halves
 * ran as separate clusters until a process restarted.
 *
 * Design decision D-5 (#1821): heartbeats keep going to unreachable members,
 * and gossip reaches them on every n-th round.  When the link heals the
 * heartbeats get through, the failure detector marks the peer reachable again
 * and the halves merge.  The proof runs two fault episodes back to back — the
 * second on the cluster the first one healed — so a recovery that leaves
 * stale state behind (a parked-peer set, a reachability verdict, a replay
 * mark) shows up as a second episode that does not heal.
 *
 * Nothing downs anyone: auto-down is off and no strategy is configured, so a
 * peer silent past `down-after` is parked at `unreachable` — the state a
 * partition actually leaves members in once a deployment has opted out of the
 * forking default, and the one from which healing has to work.  The partition
 * outlasts `down-after`, so parking is part of what is recovered from.
 *
 * Virtual time, advanced one gossip interval per step (see
 * `advanceInGossipSteps` in `DowningVirtualClock.test.ts` for why one large
 * `advance` is wrong).
 */

const ROLES = ['a', 'b', 'c'] as const;

const GOSSIP_INTERVAL_MS = 100;
const FAILURE_DETECTOR = {
  heartbeatIntervalMs: 200,
  unreachableAfterMs: 1_000,
  downAfterMs: 2_000,
} as const;
/** Long enough to cross `down-after`, so every cut-off peer is parked. */
const PARTITION_MS = 4_000;
/** What healing may take: a few heartbeats and gossip rounds, with margin. */
const HEAL_BUDGET_MS = 5_000;

type Role = typeof ROLES[number];

function statusOf(spec: MultiNodeSpec, observer: Role, subject: Role): string {
  const address = spec.addressFor(subject);
  return spec.clusterFor(observer).getMembers().find((member) => member.address.equals(address))?.status ?? 'absent';
}

function everyoneSeesEveryoneUp(spec: MultiNodeSpec): boolean {
  return ROLES.every((observer) => ROLES.every((subject) => statusOf(spec, observer, subject) === 'up'));
}

async function advanceInGossipSteps(spec: MultiNodeSpec, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += GOSSIP_INTERVAL_MS) {
    await spec.advance(Math.min(GOSSIP_INTERVAL_MS, ms - elapsed));
  }
}

/** Cut `alone` off from both other roles, wait past `down-after`, and check both sides gave up on each other. */
async function isolate(spec: MultiNodeSpec, alone: Role): Promise<Role[]> {
  const others = ROLES.filter((role) => role !== alone);
  for (const other of others) spec.partition(alone, other);
  await advanceInGossipSteps(spec, PARTITION_MS);
  for (const other of others) {
    expect(statusOf(spec, other, alone), `${other} still sees ${alone} up through the partition`).toBe('unreachable');
    expect(statusOf(spec, alone, other), `${alone} still sees ${other} up through the partition`).toBe('unreachable');
  }
  return others;
}

describe('a symmetric partition heals without a restart (#930)', () => {
  test('two partition episodes in a row, each healed by the network alone', async () => {
    const scheduler = new ManualScheduler();
    const options = MultiNodeSpecOptions.create()
      .withRoles([...ROLES])
      .withFailureDetector({ ...FAILURE_DETECTOR })
      .withFailureDetectorAutoDown(false)
      .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
      .withScheduler(scheduler);
    const spec = new MultiNodeSpec(options);
    try {
      await spec.start();
      await spec.advanceUntil(() => everyoneSeesEveryoneUp(spec), {
        budgetMs: 30_000, description: 'every node sees all three members up',
      });

      // Episode 1: c alone against a and b.
      const firstOthers = await isolate(spec, 'c');
      for (const other of firstOthers) spec.heal('c', other);
      await spec.advanceUntil(() => everyoneSeesEveryoneUp(spec), {
        budgetMs: HEAL_BUDGET_MS, description: 'the first partition healed: every node sees all three up',
      });

      // Episode 2, on the recovered cluster: a alone this time, so the leader
      // is the one cut off.
      const secondOthers = await isolate(spec, 'a');
      for (const other of secondOthers) spec.heal('a', other);
      await spec.advanceUntil(() => everyoneSeesEveryoneUp(spec), {
        budgetMs: HEAL_BUDGET_MS, description: 'the second partition healed: every node sees all three up',
      });

      // One cluster again, not three views that happen to agree on statuses.
      const leaders = ROLES.map((role) => spec.clusterFor(role).leader().fold(() => 'none', (member) => member.address.toString()));
      expect(new Set(leaders).size).toBe(1);
    } finally {
      await spec.stop();
    }
  }, 120_000);
});
