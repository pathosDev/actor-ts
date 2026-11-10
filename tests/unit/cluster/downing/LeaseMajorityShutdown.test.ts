/**
 * #1454 — `LeaseMajority.shutdown()` gives back the lease the strategy holds
 * and stops it arbitrating.
 *
 * A won arbitration keeps the lease and the backend renews it; `decide` never
 * releases it, by design (#937).  So a node that left kept the record for as
 * long as its process ran, and a later even split among the members it left
 * behind found the lease held by a node that was gone.  These cases pin the
 * three things `shutdown()` has to do about that: release a won lease, refuse
 * to arbitrate again, and undo a win that an acquire still on the wire reports
 * after it — the last through the abandon path #600 built for exactly that
 * shape.
 *
 * The lease is a hand-rolled one whose `acquire()` waits for the test, so the
 * window between "the acquire left" and "the acquire reported back" is held
 * open rather than guessed at.
 */
import { describe, expect, test } from 'bun:test';
import { LeaseMajority, LeaseMajorityOptions } from '../../../../src/cluster/downing/index.js';
import type { ClusterPartitionView } from '../../../../src/cluster/downing/index.js';
import { Member } from '../../../../src/cluster/Member.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import type { Lease } from '../../../../src/coordination/Lease.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/** A lease whose `acquire()` stays pending until {@link settle} answers it. */
class GatedLease implements Lease {
  acquireCalls = 0;
  releaseCalls = 0;
  held = false;
  private pending: ((won: boolean) => void) | null = null;

  acquire(): Promise<boolean> {
    this.acquireCalls += 1;
    return new Promise<boolean>((resolve) => {
      this.pending = (won) => {
        // The backend takes the lease when the round trip lands, not before:
        // the property the abandon path depends on (#600).
        if (won) this.held = true;
        resolve(won);
      };
    });
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
    this.held = false;
  }

  checkAlive(): boolean { return this.held; }
  onLost(): () => void { return () => { /* never lost in this fixture */ }; }

  /** Whether an `acquire()` is waiting for its answer. */
  get acquiring(): boolean { return this.pending !== null; }

  /** Answer the pending `acquire()`. */
  settle(won: boolean): void {
    const answer = this.pending;
    this.pending = null;
    answer?.(won);
  }
}

const address = (port: number): NodeAddress => new NodeAddress('sys', 'h', port);
const upMember = (port: number): Member => new Member(address(port), 'up', 0, []);

/** Two members, `sys@h:2` silent, seen from `sys@h:1`: the even split only the lease decides. */
const evenSplit: ClusterPartitionView = {
  allMembers: [upMember(1), upMember(2)],
  unreachable: new Set(['sys@h:2']),
  self: address(1),
};

function strategyOver(lease: GatedLease): LeaseMajority {
  const leaseMajorityOptions = LeaseMajorityOptions.create().withLease(lease);
  return new LeaseMajority(leaseMajorityOptions);
}

/** Drive one arbitration to a win and wait until the strategy reports it. */
async function wonArbitration(lease: GatedLease, strategy: LeaseMajority): Promise<void> {
  expect(strategy.decide(evenSplit)).toEqual(new Set());
  expect(lease.acquiring).toBe(true);
  lease.settle(true);
  await awaitCondition(() => strategy.decide(evenSplit).size > 0, { label: 'the strategy reported the win' });
  expect(strategy.decide(evenSplit)).toEqual(new Set(['sys@h:2']));
}

describe('LeaseMajority.shutdown (#1454)', () => {
  test('it releases a lease the strategy won', async () => {
    const lease = new GatedLease();
    const strategy = strategyOver(lease);
    await wonArbitration(lease, strategy);
    expect(lease.held).toBe(true);

    await strategy.shutdown();

    expect(lease.releaseCalls).toBe(1);
    expect(lease.held).toBe(false);
  });

  test('a strategy that was shut down decides nothing and starts no acquire', async () => {
    const lease = new GatedLease();
    const strategy = strategyOver(lease);
    await wonArbitration(lease, strategy);

    await strategy.shutdown();

    // The same even split, and a fresh one with the other member silent: the
    // first would answer from the cached win, the second would acquire again.
    expect(strategy.decide(evenSplit)).toEqual(new Set());
    const otherSplit: ClusterPartitionView = { ...evenSplit, unreachable: new Set(['sys@h:1']), self: address(2) };
    expect(strategy.decide(otherSplit)).toEqual(new Set());
    expect(lease.acquireCalls).toBe(1);
    expect(lease.held).toBe(false);
  });

  test('a win an acquire still on the wire reports after shutdown is given back where it lands', async () => {
    const lease = new GatedLease();
    const strategy = strategyOver(lease);
    expect(strategy.decide(evenSplit)).toEqual(new Set());
    expect(lease.acquiring).toBe(true);

    // Nothing is held yet, so this release is the contractual no-op.
    await strategy.shutdown();
    expect(lease.held).toBe(false);

    // The acquire lands afterwards, and wins: the backend now holds the lease
    // and would renew it for good unless the strategy undoes it.
    lease.settle(true);
    await awaitCondition(() => lease.releaseCalls === 2, { label: 'the late win was released' });
    expect(lease.held).toBe(false);
    expect(strategy.decide(evenSplit)).toEqual(new Set());
  });

  test('a second shutdown releases nothing more', async () => {
    const lease = new GatedLease();
    const strategy = strategyOver(lease);
    await wonArbitration(lease, strategy);

    await strategy.shutdown();
    await strategy.shutdown();

    expect(lease.releaseCalls).toBe(1);
  });
});
