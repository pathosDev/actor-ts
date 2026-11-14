/**
 * #1824 — an even split arbitrated by `LeaseMajority` leaves one whole side up.
 *
 * Every node owns its own lease instance (its address is the owner, which is
 * what `DowningFromConfig.leaseMajority` builds and what the docs tell code to
 * do), so when every node on a side acquired for itself, at most one node in
 * the cluster won.  Each of its side-mates then lost its own acquire and
 * downed its side — itself and the node that won.
 *
 * Only a side's arbiter — its lowest-addressed reachable `up` member — consults
 * the lease now.  Its side-mates wait: the arbiter's win reaches them as the
 * other side's tombstones, its loss as the arbiter leaving, which makes the
 * next member in line the arbiter, and that one's acquire loses to the lease
 * the other side holds.
 *
 * Four real `InMemoryLease`s on one store and on virtual time: nothing here
 * waits on a wall clock.
 */
import { describe, expect, test } from 'bun:test';
import { LeaseMajority, LeaseMajorityOptions } from '../../../../src/cluster/downing/index.js';
import type { ClusterPartitionView } from '../../../../src/cluster/downing/index.js';
import { Member } from '../../../../src/cluster/Member.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { MemberStatus } from '../../../../src/cluster/Protocol.js';
import { InMemoryLease, inMemoryLeaseStore } from '../../../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../../../src/coordination/LeaseOptions.js';
import { ManualScheduler } from '../../../../src/testkit/ManualScheduler.js';
import { sleep } from '../../../util/AwaitCondition.js';

const LEASE_NAME = 'split-1824';
const address = (port: number): NodeAddress => new NodeAddress('sys', 'h', port);
const key = (port: number): string => address(port).toString();

/** What `Cluster` hands a provider: unreachable peers carry the `unreachable` status. */
function viewFrom(self: number, unreachablePorts: readonly number[], statuses: Record<number, MemberStatus> = {}): ClusterPartitionView {
  const members = [1, 2, 3, 4].map((port) => {
    const status = statuses[port] ?? (unreachablePorts.includes(port) ? 'unreachable' : 'up');
    return new Member(address(port), status, 0, []);
  });
  return { allMembers: members, unreachable: new Set(unreachablePorts.map(key)), self: address(self) };
}

/** `{1, 2} | {3, 4}`, seen from `self`. */
function evenSplitFrom(self: number, statuses: Record<number, MemberStatus> = {}): ClusterPartitionView {
  return viewFrom(self, self <= 2 ? [3, 4] : [1, 2], statuses);
}

// A zero-length turn boundary, not a wait for state: `decide()` starts an
// `acquire()` whose `.then` has to run before the next `decide()` can read it.
const flushMicrotasks = (): Promise<void> => sleep(0);

function strategyOwnedBy(port: number, scheduler: ManualScheduler): { strategy: LeaseMajority; lease: InMemoryLease } {
  const leaseOptions = LeaseOptions.create()
    .withName(LEASE_NAME)
    .withOwner(key(port))
    .withTtlMs(60_000)
    .withRenewalIntervalMs(10_000)
    .withScheduler(scheduler);
  const lease = new InMemoryLease(leaseOptions);
  const leaseMajorityOptions = LeaseMajorityOptions.create().withLease(lease);
  return { strategy: new LeaseMajority(leaseMajorityOptions), lease };
}

/** Ask every node twice — kick-off, then the cached answer — the way successive detection ticks do. */
async function decideTwice(strategy: LeaseMajority, view: ClusterPartitionView): Promise<ReadonlySet<string>> {
  strategy.decide(view);
  await flushMicrotasks();
  return strategy.decide(view);
}

describe('LeaseMajority on an even split keeps the holder\'s whole side (#1824)', () => {
  test('only each side\'s lowest member acquires; its side-mate neither acquires nor downs its side', async () => {
    inMemoryLeaseStore._clear();
    const scheduler = new ManualScheduler();
    const nodes = [1, 2, 3, 4].map((port) => strategyOwnedBy(port, scheduler));
    try {
      // The left arbiter goes first and takes the lease.
      const decisions = new Map<number, ReadonlySet<string>>();
      for (const port of [1, 2, 3, 4]) {
        decisions.set(port, await decideTwice(nodes[port - 1]!.strategy, evenSplitFrom(port)));
      }

      // The holder downs the other side.
      expect([...decisions.get(1)!].sort()).toEqual([key(3), key(4)]);
      // Its side-mate downs nobody — not itself, not the holder.
      expect(decisions.get(2)!.size).toBe(0);
      // The losing arbiter downs its own side.
      expect([...decisions.get(3)!].sort()).toEqual([key(3), key(4)]);
      // Its side-mate waits for that to reach it.
      expect(decisions.get(4)!.size).toBe(0);
      // Nobody but the two arbiters ever touched the lease.
      expect(inMemoryLeaseStore.peek(LEASE_NAME, scheduler.now())?.owner).toBe(key(1));
      expect(nodes[1]!.lease.checkAlive()).toBe(false);
      expect(nodes[3]!.lease.checkAlive()).toBe(false);
    } finally {
      for (const node of nodes) await node.strategy.shutdown();
      inMemoryLeaseStore._clear();
    }
  });

  test('a side-mate whose arbiter left takes over the arbitration, and loses to the lease the other side holds', async () => {
    inMemoryLeaseStore._clear();
    const scheduler = new ManualScheduler();
    const left = strategyOwnedBy(1, scheduler);
    const right = strategyOwnedBy(3, scheduler);
    const rightMate = strategyOwnedBy(4, scheduler);
    try {
      expect([...(await decideTwice(left.strategy, evenSplitFrom(1)))].sort()).toEqual([key(3), key(4)]);
      expect([...(await decideTwice(right.strategy, evenSplitFrom(3)))].sort()).toEqual([key(3), key(4)]);
      expect((await decideTwice(rightMate.strategy, evenSplitFrom(4))).size).toBe(0);

      // The right arbiter downed itself: `sys@h:4` sees it leaving.  The view
      // carries the same addresses on the same sides, so only the status says
      // that the arbiter is gone.
      const arbiterLeaving = evenSplitFrom(4, { 3: 'leaving' });
      expect([...(await decideTwice(rightMate.strategy, arbiterLeaving))].sort()).toEqual([key(3), key(4)]);
      expect(inMemoryLeaseStore.peek(LEASE_NAME, scheduler.now())?.owner).toBe(key(1));
    } finally {
      for (const node of [left, right, rightMate]) await node.strategy.shutdown();
      inMemoryLeaseStore._clear();
    }
  });

  test('the holder\'s side-mate survives once the holder\'s decision reaches it as tombstones', async () => {
    inMemoryLeaseStore._clear();
    const scheduler = new ManualScheduler();
    const leftMate = strategyOwnedBy(2, scheduler);
    try {
      expect((await decideTwice(leftMate.strategy, evenSplitFrom(2))).size).toBe(0);
      const afterHolderApplied = viewFrom(2, [], { 3: 'removed', 4: 'removed' });
      expect(leftMate.strategy.decide(afterHolderApplied).size).toBe(0);
    } finally {
      await leftMate.strategy.shutdown();
      inMemoryLeaseStore._clear();
    }
  });
});
