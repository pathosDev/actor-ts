/**
 * End-to-end split-brain test for LeaseMajority (#51, #1824).
 *
 * Setup: 4 nodes a, b, c, d, each running LeaseMajority over a lease on one
 * shared `InMemoryLease` store — the process-local store stands in for the
 * external arbiter K8s is in production.  Every node owns its own lease
 * instance, as production does.
 *
 * Trigger an EQUAL-SIZE partition: (a, b) ⇔ (c, d).  Membership-only
 * strategies leave equal splits pending; LeaseMajority's arbiter on each side
 * — its lowest member — acquires, and one of the two wins.
 *
 * Assertion: the holder's **whole side** stays up, seeing exactly its two
 * members, and every node of the other side downs itself.  Until #1824 only
 * "not both sides survive" was asserted, which an outcome with the holder
 * alone left standing also passed: every node acquired for itself, so the
 * holder's side-mate lost its own acquire and downed its side — itself and
 * the holder.
 *
 * Both cases run on a virtual clock, so the outcome is the resolver's and not
 * a race between a runner's timers.  The first builds the lease from
 * configuration — `DowningFromConfig.leaseMajority`, owned by the node's
 * address and incarnation, the shape #1824 was reported against; the second
 * passes one in code with one owner per role, the shape the docs show.
 *
 * History: this file was quarantined (`ACTOR_TS_SKIP_FLAKY_MNS=1`, #538) on a
 * wrong diagnosis.  The failing runs never acquired the lease at all: the two
 * remote peers crossed `unreachableAfterMs` on different detection ticks, so
 * each side saw two majorities instead of one equal split.  #839's stability
 * window is what this file's `stableAfterMs` asks for; #1807 is the stagger it
 * does not cover.
 */
import { describe, expect, test } from 'bun:test';
import { readDowningFromConfig } from '../../src/cluster/downing/DowningFromConfig.js';
import { LeaseMajority, LeaseMajorityOptions } from '../../src/cluster/downing/index.js';
import type { DowningProvider } from '../../src/cluster/downing/index.js';
import { Config } from '../../src/config/Config.js';
import { _substituteLeaseBackendForTest } from '../../src/coordination/LeaseFromConfig.js';
import { InMemoryLease, inMemoryLeaseStore } from '../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../src/coordination/LeaseOptions.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';

const ROLES = ['a', 'b', 'c', 'd'] as const;
const LEFT = ['a', 'b'] as const;
const RIGHT = ['c', 'd'] as const;

const HEARTBEAT_INTERVAL_MS = 100;
const GOSSIP_INTERVAL_MS = 100;
/**
 * Every cut is made in the same instant, so both remote peers are detected on
 * one tick; the window only has to outlast that tick and the gossip after it.
 */
const STABLE_AFTER_MS = 1_000;
/** Far beyond every budget, so nothing here outlives a held lease. */
const LEASE_TTL_MS = 600_000;

const FAILURE_DETECTOR = {
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  unreachableAfterMs: 500,
  // Far beyond every budget below, so every removal is the resolver's decision
  // and never the detector's elapsed-time fallback.
  downAfterMs: 600_000,
} as const;

/** Self is still `up`, and the node sees exactly its own side as up. */
function survivesWithItsSide(spec: MultiNodeSpec, role: string): boolean {
  const cluster = spec.clusterFor(role);
  const self = cluster.getMembers().find((m) => m.address.equals(cluster.selfAddress));
  return self?.status === 'up' && cluster.upMembers().length === 2;
}

/** Self has downed itself: `leaving` on the way out, or already `removed`. */
function downedItself(spec: MultiNodeSpec, role: string): boolean {
  const cluster = spec.clusterFor(role);
  const self = cluster.getMembers().find((m) => m.address.equals(cluster.selfAddress));
  return self === undefined || self.status === 'leaving' || self.status === 'removed';
}

/** Which side the lease record's owner sits on. */
function holderSide(spec: MultiNodeSpec, leaseName: string, scheduler: ManualScheduler): readonly string[] {
  const owner = inMemoryLeaseStore.peek(leaseName, scheduler.now())?.owner;
  const holder = ROLES.find((role) =>
    owner === role || owner?.startsWith(spec.addressFor(role).toString()) === true);
  expect(holder, `the lease record names a node of the cluster (owner ${owner})`).toBeDefined();
  return (LEFT as readonly string[]).includes(holder!) ? LEFT : RIGHT;
}

async function runEvenSplit(
  downing: (role: string) => DowningProvider | undefined,
  leaseName: () => string,
  scheduler: ManualScheduler,
): Promise<void> {
  const options = MultiNodeSpecOptions.create()
    .withRoles([...ROLES])
    .withFailureDetector({ ...FAILURE_DETECTOR })
    .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
    .withStableAfterMs(STABLE_AFTER_MS)
    .withScheduler(scheduler)
    .withDowning(downing);
  const spec = new MultiNodeSpec(options);
  try {
    await spec.start();
    await spec.advanceUntil(
      () => ROLES.every((role) => spec.clusterFor(role).upMembers().length === ROLES.length),
      { budgetMs: 30_000, description: 'every node sees all four members up' },
    );

    for (const left of LEFT) {
      for (const right of RIGHT) spec.partition(left, right);
    }

    // Settled: one side has downed itself completely.  The surviving side is
    // then checked as a whole below, not merely as "not dead".
    await spec.advanceUntil(
      () => LEFT.every((role) => downedItself(spec, role)) || RIGHT.every((role) => downedItself(spec, role)),
      { budgetMs: 30_000, description: 'one whole side downed itself' },
    );
    const survivors = holderSide(spec, leaseName(), scheduler);
    const losers = survivors === LEFT ? RIGHT : LEFT;
    // The tombstones reach the holder's side-mate one gossip round later.
    await spec.advanceUntil(
      () => survivors.every((role) => survivesWithItsSide(spec, role)),
      { budgetMs: 10_000, description: 'the holder\'s whole side is up, seeing exactly its two members' },
    );
    for (const role of survivors) {
      expect(survivesWithItsSide(spec, role), `${role} is on the lease holder's side`).toBe(true);
    }
    for (const role of losers) {
      expect(downedItself(spec, role), `${role} is on the side without the lease`).toBe(true);
    }
  } finally {
    await spec.stop();
    MultiNodeTransport._resetRegistryForTest();
  }
}

describe('LeaseMajority — end-to-end split-brain', () => {
  test('a lease built from configuration: 2/2 partition leaves the holder\'s whole side up and downs the other', async () => {
    inMemoryLeaseStore._clear();
    const scheduler = new ManualScheduler();
    const leaseName = 'split-brain-resolver-1824';
    const owners: string[] = [];
    const restore = _substituteLeaseBackendForTest((leaseOptions) => {
      owners.push(leaseOptions.owner);
      // The owner — address and incarnation — is configuration's.  The name is
      // pinned because MultiNodeSpec gives every node its own system name, and
      // the name configuration derives (`<system>-split-brain-resolver`) would
      // then be one record per node: no contention at all.  A deployment's
      // nodes share a system name, and so one record.  The clock is the spec's,
      // so the TTL and the renewal run on virtual time.
      return new InMemoryLease({
        ...leaseOptions,
        name: leaseName,
        scheduler,
        ttlMs: LEASE_TTL_MS,
        renewalIntervalMs: 10_000,
      });
    });
    const configured = Config.parseString(`
      actor-ts.coordination.lease { backend = kubernetes, ttl = 600s }
      actor-ts.cluster.split-brain-resolver.active-strategy = lease-majority
    `);
    try {
      await runEvenSplit(() => readDowningFromConfig(configured), () => leaseName, scheduler);
      // Every node built its own lease, owned by its address and incarnation.
      expect(new Set(owners).size).toBe(ROLES.length);
      expect(owners.every((owner) => owner.includes('#'))).toBe(true);
    } finally {
      restore();
      inMemoryLeaseStore._clear();
    }
  }, 60_000);

  test('a lease passed in code, one owner per role: 2/2 partition leaves the holder\'s whole side up and downs the other', async () => {
    inMemoryLeaseStore._clear();
    const scheduler = new ManualScheduler();
    const leaseName = 'lease-majority-test';
    try {
      await runEvenSplit((role) => {
        const leaseOptions = LeaseOptions.create()
          .withName(leaseName)
          .withOwner(role)
          .withTtlMs(LEASE_TTL_MS)
          .withRenewalIntervalMs(10_000)
          .withScheduler(scheduler);
        const leaseMajorityOptions = LeaseMajorityOptions.create()
          .withLease(new InMemoryLease(leaseOptions))
          .withAcquireTimeoutMs(2_000);
        return new LeaseMajority(leaseMajorityOptions);
      }, () => leaseName, scheduler);
    } finally {
      inMemoryLeaseStore._clear();
    }
  }, 60_000);
});
