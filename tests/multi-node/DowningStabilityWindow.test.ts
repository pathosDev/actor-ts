import { describe, expect, test } from 'bun:test';
import { LeaseMajority, LeaseMajorityOptions } from '../../src/cluster/downing/index.js';
import {
  InMemoryLease,
  inMemoryLeaseStore,
} from '../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../src/coordination/LeaseOptions.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import { sleep } from '../util/AwaitCondition.js';

/**
 * The split-brain resolver decides on a view that has stopped moving (#839),
 * and this is the failure that made that necessary (#1343, #1309).
 *
 * A partition is not one event the cluster observes; it is a sequence of them.
 * `Cluster.failureDetectionTick` marks peers unreachable **one at a time**, as
 * each crosses `unreachableAfterMs`, and then evaluates downing at the end of
 * that same tick.  So a 2/2 partition whose two remote peers are detected on
 * different ticks used to be resolved as two successive *majority* decisions
 * rather than one equal-split decision:
 *
 * ```text
 * tick 1:  a=up b=up c=unreachable d=up          3 reachable of 4 -> down c
 * tick 2:  a=up b=up c=removed  d=unreachable    2 reachable of 3 -> down d
 * ```
 *
 * The tombstone closes the trap: the force-down writes `withRemoved(...)`, and
 * every bundled strategy filters candidates to `up | leaving | unreachable`, so
 * the denominator shrinks with the numerator.  Both halves run the identical
 * computation over their mirror image, both survive, and the lease is never
 * acquired by anybody — the equal-split path `LeaseMajority` exists for is not
 * reached at all.
 *
 * **The stagger is produced deliberately here, and that is the whole design of
 * this file.**  In the wild it comes from the two peers' last heartbeats being
 * up to one heartbeat interval apart, which is why `LeaseMajority.test.ts`
 * failed roughly one night in three and never on demand.  Cutting the two links
 * a full second apart, against a 50 ms heartbeat and a 200 ms threshold, puts
 * about twenty failure-detector ticks in the interval where exactly one peer is
 * unreachable — so the sequence above is what happens, rather than what might.
 *
 * **The stagger is one-sided, which is what makes the failure legible.**
 * `(a,b)` loses `c` a second before it loses `d`, so it walks the two-majority
 * path above.  `(c,d)` loses `a` and `b` together, so it sees the equal split
 * the strategy is written for, arbitrates properly, and one of them takes the
 * lease.  The split brain is therefore not "the lease failed": the lease is
 * awarded, correctly, to a node on the right — and the left survives anyway,
 * because it never asked.  A resolver whose verdict one side can skip is not a
 * resolver.
 *
 * **Only the fix is asserted here, and the omission is deliberate.**  A case
 * asserting that the *defect* occurs would be asserting that a race between two
 * failure-detector ticks went one particular way; written and measured, that
 * flaked one run in six, which is the thing this whole effort exists to remove.
 * The premise is pinned without any timing in
 * `tests/unit/cluster/downing/StaggeredDetection.test.ts`, which replays this
 * same tick sequence over hand-built views.  Between them: that file says what
 * goes wrong, this one says the window stops it.
 */

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  // Far beyond anything here, so every convergence below is the resolver's
  // doing and never the detector's elapsed-time fallback.
  downAfterMs: 30_000,
} as const;

/** How long after the first cut the second one follows. */
const STAGGER_MS = 1_000;

/**
 * A window comfortably wider than {@link STAGGER_MS}, which is the condition
 * under which it helps at all: the point is to collapse a sequence of
 * observations into one, so it has to outlast the sequence.
 */
const WINDOW_MS = 4_000;

/** Long enough for the window to elapse and the arbitration to gossip out. */
const SETTLE_BUDGET_MS = 12_000;

/** The one lease every node contends for, named once. */
const LEASE_NAME = 'downing-stability-window';

const ROLES = ['a', 'b', 'c', 'd'] as const;
const LEFT = ['a', 'b'] as const;
const RIGHT = ['c', 'd'] as const;

function specWith(stableAfterMs: number): MultiNodeSpec {
  const options = MultiNodeSpecOptions.create()
    .withRoles([...ROLES])
    .withFailureDetector({ ...TIGHT_FD })
    .withGossipIntervalMs(80)
    .withSplitBrainResolver({ stableAfterMs })
    .withDowning((role: string) => {
      // One named lease, one owner per node — the production shape, and the
      // reason the store below is process-global.
      const leaseOptions = LeaseOptions.create()
        .withName(LEASE_NAME)
        .withOwner(role)
        .withTtlMs(60_000)
        .withRenewalIntervalMs(80);
      const leaseMajorityOptions = LeaseMajorityOptions.create()
        .withLease(new InMemoryLease(leaseOptions))
        .withAcquireTimeoutMs(2_000);
      return new LeaseMajority(leaseMajorityOptions);
    });
  return new MultiNodeSpec(options);
}

/**
 * "Alive" is self still `up` with a non-empty up-view — a healthy member after
 * arbitration.  Polling raw member counts instead reads the transient in which
 * all four still see each other as a split.
 */
function aliveOn(spec: MultiNodeSpec, side: readonly string[]): string[] {
  return side.filter((role) => {
    const cluster = spec.clusterFor(role);
    const self = cluster.getMembers().find((m) => m.address.equals(cluster.selfAddress));
    return self?.status === 'up' && cluster.upMembers().length >= 1;
  });
}

/** Cut (a,b) from (c,d), one side of the partition a second after the other. */
async function partitionInTwoSteps(spec: MultiNodeSpec): Promise<void> {
  for (const left of LEFT) spec.partition(left, 'c');
  // The elapsed time IS the setup: it is what puts the two detections on
  // different failure-detector ticks, which is the condition under test.
  await sleep(STAGGER_MS);
  for (const left of LEFT) spec.partition(left, 'd');
}

type PartitionOutcome = {
  readonly left: string[];
  readonly right: string[];
  /** Who held the lease when the dust settled, or `null` if nobody ever did. */
  readonly leaseOwner: string | null;
};

async function runPartition(stableAfterMs: number): Promise<PartitionOutcome> {
  inMemoryLeaseStore._clear();
  const spec = specWith(stableAfterMs);
  try {
    await spec.start();
    await Promise.all(ROLES.map((role) => spec.awaitMembers(role, 4)));
    await partitionInTwoSteps(spec);
    // A settled state is what is being read, so this waits out the whole
    // budget rather than breaking early: breaking on "one side is empty"
    // would report the first moment the assertion could hold and hide a
    // cluster that reaches it and then leaves it.
    await sleep(SETTLE_BUDGET_MS);
    // Read inside the try: the `finally` clears the process-global store, so a
    // caller asserting on it afterwards would always see an empty one.
    return {
      left: aliveOn(spec, LEFT),
      right: aliveOn(spec, RIGHT),
      leaseOwner: inMemoryLeaseStore.peek(LEASE_NAME)?.owner ?? null,
    };
  } finally {
    await spec.stop();
    MultiNodeTransport._resetRegistryForTest();
    inMemoryLeaseStore._clear();
  }
}

describe('the split-brain resolver decides on a view that has stopped moving', () => {
  /**
   * The fix.  Same partition, same stagger, same strategy — a window wider than
   * the stagger, and the two observations become the one the strategies are
   * written against.
   */
  test('with a window wider than the stagger, exactly one side survives', async () => {
    const { left, right, leaseOwner } = await runPartition(WINDOW_MS);

    expect(
      left.length > 0 && right.length > 0,
      `both sides survived a 2/2 partition: left=[${left.join(',')}] right=[${right.join(',')}]`,
    ).toBe(false);
    expect(
      left.length + right.length,
      'no side survived at all, which is not split-brain protection either — '
      + 'the lease holder was supposed to keep its side',
    ).toBeGreaterThanOrEqual(1);
    // And this time the arbitration really ran: exactly one owner took the
    // lease, which is the step the staggered case skipped entirely.
    expect(leaseOwner).not.toBeNull();
    expect(ROLES).toContain(leaseOwner as (typeof ROLES)[number]);
  }, 60_000);
});
