import { describe, expect, test } from 'bun:test';
import { KeepMajority } from '../../../../src/cluster/downing/KeepMajority.js';
import { LeaseMajority, LeaseMajorityOptions } from '../../../../src/cluster/downing/index.js';
import type {
  ClusterPartitionView,
  DowningDecision,
  DowningProvider,
} from '../../../../src/cluster/downing/DowningProvider.js';
import { InMemoryLease, inMemoryLeaseStore } from '../../../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../../../src/coordination/LeaseOptions.js';
import { Member } from '../../../../src/cluster/Member.js';
import type { MemberStatus } from '../../../../src/cluster/Protocol.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';

/**
 * Why the split-brain resolver needs a stability window (#839), stated as
 * arithmetic rather than as a race.
 *
 * `tests/multi-node/DowningStabilityWindow.test.ts` shows the window working
 * against a real partition.  It cannot show the *defect* reliably, and that is
 * not a gap in it: the defect is a race between two failure-detector ticks, so
 * a test asserting that it occurs is a test asserting that a race went one way.
 * Measured, that shape flaked one run in six — which is the thing this whole
 * effort exists to remove, and not something to ship as a regression witness.
 *
 * So the premise is pinned here instead, where there is no timing at all.
 * `Cluster.evaluateDowning` hands a strategy one `ClusterPartitionView` per
 * failure-detector tick and applies whatever comes back, tombstoning each
 * downed member with `withRemoved(...)`.  Replaying exactly that loop over
 * hand-built views shows what a strategy answers when it is asked about a
 * partition that is only *half* detected — and the answer is the correct answer
 * to the wrong question.
 *
 * Nothing here is a criticism of the strategies.  `KeepMajority` asked "am I a
 * majority of the members I can see?" answers truthfully; the defect is that
 * the cluster asked before the view had finished changing.  The window is
 * therefore in `Cluster`, and these cases are what it has to prevent being
 * reached.
 *
 * Refs #839, #1343, #1309.
 */

const ROLES = ['a', 'b', 'c', 'd'] as const;
type Role = (typeof ROLES)[number];

const ADDRESSES: ReadonlyMap<Role, NodeAddress> = new Map(
  ROLES.map((role) => [role, new NodeAddress('sys', '127.0.0.1', 40_500 + role.charCodeAt(0))]),
);

const keyOf = (role: Role): string => ADDRESSES.get(role)!.toString();

/** Every role's status, as one node's membership table sees it. */
type Table = Readonly<Record<Role, MemberStatus>>;

const ALL_UP: Table = { a: 'up', b: 'up', c: 'up', d: 'up' };

/** The view `Cluster.evaluateDowning` builds from a membership table. */
function viewOf(self: Role, table: Table): ClusterPartitionView {
  return {
    allMembers: ROLES.map((role) => new Member(ADDRESSES.get(role)!, table[role], 1)),
    unreachable: new Set(ROLES.filter((role) => table[role] === 'unreachable').map(keyOf)),
    self: ADDRESSES.get(self)!,
  };
}

/** Which roles a decision names. */
const rolesIn = (decision: DowningDecision): Role[] =>
  ROLES.filter((role) => decision.has(keyOf(role)));

/**
 * What `evaluateDowning` does with a decision: force-down every named address
 * and tombstone it.  The tombstone is the half that matters — `withRemoved`
 * sets status `removed`, and every bundled strategy filters candidates to
 * `up | leaving | unreachable`, so a member downed on one tick is out of the
 * denominator on the next.
 */
function applyDecision(table: Table, decision: DowningDecision): Table {
  const next = { ...table };
  for (const role of rolesIn(decision)) next[role] = 'removed';
  return next;
}

/**
 * Replay one node's failure-detector ticks.  `observations` is what the
 * detector reported on each tick; anything this node has already tombstoned
 * stays tombstoned, exactly as its own member map would.
 */
function replayTicks(
  self: Role,
  strategy: DowningProvider,
  observations: ReadonlyArray<Table>,
): { survivors: Role[]; decisions: Role[][] } {
  let table: Table = ALL_UP;
  const decisions: Role[][] = [];
  for (const observed of observations) {
    table = Object.fromEntries(
      ROLES.map((role) => [role, table[role] === 'removed' ? 'removed' : observed[role]]),
    ) as unknown as Table;
    const decision = strategy.decide(viewOf(self, table));
    decisions.push(rolesIn(decision));
    table = applyDecision(table, decision);
  }
  return { survivors: ROLES.filter((role) => table[role] === 'up'), decisions };
}

/** The two ticks a *staggered* detection produces on the (a,b) side. */
const STAGGERED_ON_LEFT: ReadonlyArray<Table> = [
  ALL_UP,
  { a: 'up', b: 'up', c: 'unreachable', d: 'up' },
  { a: 'up', b: 'up', c: 'unreachable', d: 'unreachable' },
];

/** The same partition seen all at once, which is the case strategies are written for. */
const SIMULTANEOUS_ON_LEFT: ReadonlyArray<Table> = [
  ALL_UP,
  { a: 'up', b: 'up', c: 'unreachable', d: 'unreachable' },
  { a: 'up', b: 'up', c: 'unreachable', d: 'unreachable' },
];

function leaseMajorityFor(role: Role): LeaseMajority {
  const leaseOptions = LeaseOptions.create()
    .withName('staggered-detection')
    .withOwner(role)
    .withTtlMs(60_000)
    .withRenewalIntervalMs(80);
  return new LeaseMajority(
    LeaseMajorityOptions.create()
      .withLease(new InMemoryLease(leaseOptions))
      .withAcquireTimeoutMs(2_000),
  );
}

describe('a partition detected all at once reaches the equal-split path', () => {
  test('KeepMajority downs its own side, so the cluster stops whole', () => {
    const { survivors, decisions } = replayTicks('a', new KeepMajority(), SIMULTANEOUS_ON_LEFT);

    // Two of four is not a majority, so the reachable side downs itself.  Both
    // halves compute the same thing, which is why an even split stops the
    // cluster rather than forking it — the documented trade.
    expect(decisions[1]).toEqual(['a', 'b']);
    expect(survivors).toEqual([]);
  });

  test('LeaseMajority asks the lease rather than deciding', () => {
    inMemoryLeaseStore._clear();
    try {
      const { decisions } = replayTicks('a', leaseMajorityFor('a'), SIMULTANEOUS_ON_LEFT);

      // An equal split returns no decision while the acquire is in flight —
      // waiting is the whole point, and it is what the staggered case skips.
      expect(decisions[1]).toEqual([]);
    } finally {
      inMemoryLeaseStore._clear();
    }
  });
});

describe('a partition detected one peer at a time never reaches it', () => {
  /**
   * The finding, and the reason the window exists.  Neither decision below is
   * wrong for the view it was given; both views were taken too early.
   */
  test('KeepMajority walks a 2/2 split down as two majorities', () => {
    const { survivors, decisions } = replayTicks('a', new KeepMajority(), STAGGERED_ON_LEFT);

    // Tick 1: four candidates, three reachable — a strict majority, so the one
    // unreachable peer goes.
    expect(decisions[1]).toEqual(['c']);
    // Tick 2: `c` is tombstoned and therefore out of the candidate set, so
    // three candidates and two reachable is a majority again.  The denominator
    // shrank because of the previous decision.
    expect(decisions[2]).toEqual(['d']);
    // And this side survives a partition it was never entitled to win.
    expect(survivors).toEqual(['a', 'b']);
  });

  test('LeaseMajority takes the same two majorities, and never touches the lease', () => {
    inMemoryLeaseStore._clear();
    try {
      const { survivors, decisions } = replayTicks('a', leaseMajorityFor('a'), STAGGERED_ON_LEFT);

      expect(decisions[1]).toEqual(['c']);
      expect(decisions[2]).toEqual(['d']);
      expect(survivors).toEqual(['a', 'b']);
      // The strategy's whole purpose is the arbitration it did not perform:
      // `KeepMajority`'s math answered first, both times, so no acquire was
      // ever started.  This is why the failing runs of
      // `tests/multi-node/LeaseMajority.test.ts` showed no lease holder on the
      // losing side and why every hypothesis about TTLs and renewal timers was
      // looking at machinery that had not run.
      expect(inMemoryLeaseStore.peek('staggered-detection')).toBeUndefined();
    } finally {
      inMemoryLeaseStore._clear();
    }
  });

  test('the mirror image happens on the other side, which is the split brain', () => {
    // `(c,d)` sees `a` a tick before `b`.  Same arithmetic, same outcome: a
    // side that considers itself the majority twice over.
    const staggeredOnRight: ReadonlyArray<Table> = [
      ALL_UP,
      { a: 'unreachable', b: 'up', c: 'up', d: 'up' },
      { a: 'unreachable', b: 'unreachable', c: 'up', d: 'up' },
    ];
    const left = replayTicks('a', new KeepMajority(), STAGGERED_ON_LEFT);
    const right = replayTicks('c', new KeepMajority(), staggeredOnRight);

    expect(left.survivors).toEqual(['a', 'b']);
    expect(right.survivors).toEqual(['c', 'd']);
    // Two live halves of one cluster, from a resolver whose entire job is to
    // prevent exactly this.
    expect(left.survivors.length > 0 && right.survivors.length > 0).toBe(true);
  });
});
