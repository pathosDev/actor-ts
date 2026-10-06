import { afterEach, describe, expect, test } from 'bun:test';
import { InMemoryLease, inMemoryLeaseStore } from '../../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../../src/coordination/LeaseOptions.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';

/**
 * #1424 — a lease reads the time from its scheduler.
 *
 * Everything interesting a lease does is a duration: the TTL, the renewal
 * cadence, the gap between acquire retries.  Every one of them was measured on
 * the wall clock, so a test could only cross one by waiting for it — which is
 * why lease tests here use TTLs of tens of milliseconds and then assert on
 * behaviour that a production TTL of thirty seconds would show quite
 * differently.
 *
 * This is also the machinery `LeaseMajority` was blamed for over thirteen red
 * nights before the cause turned out to be a product defect in split-brain
 * resolution (#839).  The hypothesis was wrong, but it was never *checkable*,
 * and that is the part this fixes.
 */

/** A store shared by every lease in the process, so each test starts clean. */
afterEach(() => { inMemoryLeaseStore._clear(); });

const leaseFor = (owner: string, scheduler: ManualScheduler, ttlMs = 30_000): InMemoryLease =>
  new InMemoryLease(
    LeaseOptions.create()
      .withName('virtual-lease')
      .withOwner(owner)
      .withTtlMs(ttlMs)
      .withScheduler(scheduler),
  );

describe('a lease measures its TTL on its scheduler', () => {
  test('a thirty-second lease expires in no real time', async () => {
    const scheduler = new ManualScheduler();
    // A renewal cadence past the TTL, which is how a lease actually expires
    // under its holder: the loop is armed but does not come round in time. With
    // the default cadence of a third of the TTL it would renew twice on the way
    // and the record would never lapse — the first version of this test asserted
    // exactly that and was right to fail.
    const holder = new InMemoryLease(
      LeaseOptions.create()
        .withName('virtual-lease')
        .withOwner('node-a')
        .withTtlMs(30_000)
        .withRenewalIntervalMs(3_600_000)
        .withScheduler(scheduler),
    );
    const realStart = Date.now();

    expect(await holder.acquire()).toBe(true);
    expect(inMemoryLeaseStore.peek('virtual-lease', scheduler.now())?.owner).toBe('node-a');

    scheduler.advance(29_999);
    expect(inMemoryLeaseStore.peek('virtual-lease', scheduler.now())?.owner).toBe('node-a');

    scheduler.advance(2);
    expect(inMemoryLeaseStore.peek('virtual-lease', scheduler.now())).toBeUndefined();

    expect(Date.now() - realStart).toBeLessThan(1_000);
  });

  test('a second owner cannot take a lease that has not expired yet', async () => {
    const scheduler = new ManualScheduler();
    expect(await leaseFor('node-a', scheduler).acquire()).toBe(true);

    scheduler.advance(29_999);
    expect(await leaseFor('node-b', scheduler).acquire()).toBe(false);
  });

  test('the renewal loop keeps a lease alive across many TTLs', async () => {
    // Ten TTLs of virtual time — five real minutes on the wall clock, and the
    // reason a renewal test was previously written with a 60 ms TTL.
    const scheduler = new ManualScheduler();
    const holder = leaseFor('node-a', scheduler);
    expect(await holder.acquire()).toBe(true);

    scheduler.advance(300_000);

    expect(holder.checkAlive()).toBe(true);
    expect(inMemoryLeaseStore.peek('virtual-lease', scheduler.now())?.owner).toBe('node-a');
  });

  test('losing the lease under a renewal fires onLost in virtual time', async () => {
    const scheduler = new ManualScheduler();
    const holder = leaseFor('node-a', scheduler);
    expect(await holder.acquire()).toBe(true);

    const reasons: string[] = [];
    holder.onLost((reason) => { reasons.push(reason); });

    // Somebody else takes the record out from under the holder, which is what a
    // renewal discovers on its next pass.
    inMemoryLeaseStore._clear();
    scheduler.advance(30_000);

    expect(reasons).toEqual(['lease lost during renewal']);
    expect(holder.checkAlive()).toBe(false);
  });

  test('release disarms the renewal loop rather than leaking it', async () => {
    const scheduler = new ManualScheduler();
    const before = scheduler.pendingCount;
    const holder = leaseFor('node-a', scheduler);

    expect(await holder.acquire()).toBe(true);
    expect(scheduler.pendingCount).toBeGreaterThan(before);

    await holder.release();
    expect(scheduler.pendingCount).toBe(before);
  });

  test('acquire retries wait on the scheduler, not on the wall clock', async () => {
    const scheduler = new ManualScheduler();
    expect(await leaseFor('holder', scheduler).acquire()).toBe(true);

    const contender = new InMemoryLease(
      LeaseOptions.create()
        .withName('virtual-lease')
        .withOwner('contender')
        .withTtlMs(30_000)
        .withAcquireRetries(3)
        .withAcquireRetryDelayMs(10_000)
        .withScheduler(scheduler),
    );

    let settled = false;
    const pending = contender.acquire().then((won) => { settled = true; return won; });

    // Two retry gaps of ten virtual seconds each, which on the wall clock would
    // be twenty real ones.
    for (let gap = 0; gap < 3; gap++) {
      await new Promise<void>((resolve) => { queueMicrotask(resolve); });
      scheduler.advance(10_000);
    }

    expect(await pending).toBe(false);
    expect(settled).toBe(true);
  });

  test('without a scheduler the lease is still on the wall clock', async () => {
    // Nothing outside a test changes.
    const holder = new InMemoryLease(
      LeaseOptions.create().withName('wall-lease').withOwner('node-a').withTtlMs(30_000),
    );
    try {
      expect(await holder.acquire()).toBe(true);
      expect(inMemoryLeaseStore.peek('wall-lease')?.owner).toBe('node-a');
    } finally {
      await holder.release();
    }
  });
});

/**
 * #937 — a holder whose renewal did not come round in time must stop believing
 * it holds the lease.
 *
 * A renewal cadence past the TTL is how a stall looks from the lease's side: the
 * loop is armed, and a blocked event loop — a GC pause, a starved container —
 * keeps it from running until the record has lapsed.  `checkAlive()` used to
 * answer from a flag that only a renewal could clear, and the renewal that
 * finally ran extended the lapsed record instead of giving it up.
 */
describe('a holder whose renewal did not come round in time (#937)', () => {
  const stalledLeaseFor = (
    owner: string,
    scheduler: ManualScheduler,
    renewalIntervalMs = 3_600_000,
  ): InMemoryLease => {
    const leaseOptions = LeaseOptions.create()
      .withName('virtual-lease')
      .withOwner(owner)
      .withTtlMs(30_000)
      .withRenewalIntervalMs(renewalIntervalMs)
      .withScheduler(scheduler);
    return new InMemoryLease(leaseOptions);
  };

  test('checkAlive turns false at the deadline, with no renewal having run', async () => {
    const scheduler = new ManualScheduler();
    const holder = stalledLeaseFor('node-a', scheduler);
    expect(await holder.acquire()).toBe(true);

    scheduler.advance(29_999);
    expect(holder.checkAlive()).toBe(true);

    // The deadline itself is where the store lets another owner in, so it is
    // where this holder has to let go.
    scheduler.advance(1);
    expect(holder.checkAlive()).toBe(false);
  });

  test('two holders never both report alive for the same lease', async () => {
    const scheduler = new ManualScheduler();
    const stalled = stalledLeaseFor('node-a', scheduler);
    const successor = leaseFor('node-b', scheduler);
    expect(await stalled.acquire()).toBe(true);

    scheduler.advance(30_000);
    expect(await successor.acquire()).toBe(true);

    expect(stalled.checkAlive()).toBe(false);
    expect(successor.checkAlive()).toBe(true);
  });

  test('a renewal that comes round after the deadline gives the lease up instead of extending it', async () => {
    const scheduler = new ManualScheduler();
    // The first renewal is due ten seconds after the record lapsed.
    const holder = stalledLeaseFor('node-a', scheduler, 40_000);
    expect(await holder.acquire()).toBe(true);
    const reasons: string[] = [];
    holder.onLost((reason) => { reasons.push(reason); });

    scheduler.advance(40_000);

    expect(reasons).toEqual(['lease expired before it could be renewed (10000 ms past its deadline)']);
    expect(holder.checkAlive()).toBe(false);
    // Nothing was written back: the record stays lapsed, free for whoever asks
    // next, rather than handed back to a holder that could not keep it.
    expect(inMemoryLeaseStore.peek('virtual-lease', scheduler.now())).toBeUndefined();
  });

  test('the store refuses to renew a record that has already lapsed', () => {
    const acquiredAt = 1_000;
    expect(inMemoryLeaseStore.tryAcquire('virtual-lease', 'node-a', acquiredAt + 30_000, acquiredAt))
      .toBeGreaterThan(0);

    // One millisecond before the deadline the record is still the holder's to extend…
    const renewedAt = acquiredAt + 29_999;
    expect(inMemoryLeaseStore.renew('virtual-lease', 'node-a', renewedAt + 30_000, renewedAt)).toBe(true);
    // …and at the new deadline it no longer is.
    const lateAt = renewedAt + 30_000;
    expect(inMemoryLeaseStore.renew('virtual-lease', 'node-a', lateAt + 30_000, lateAt)).toBe(false);
  });

  test('release ends checkAlive at once, with the deadline still ahead', async () => {
    const scheduler = new ManualScheduler();
    const holder = leaseFor('node-a', scheduler);
    expect(await holder.acquire()).toBe(true);

    await holder.release();

    // The record is gone and any other owner may take it now, so the expiry
    // this holder wrote no longer speaks for it.
    expect(holder.checkAlive()).toBe(false);
  });

  test('re-acquiring a lease it already holds arms no second renewal loop', async () => {
    // `LeaseMajority` does exactly this: it never releases a lease it won, and
    // the next equal split acquires on the same instance again.
    const scheduler = new ManualScheduler();
    const before = scheduler.pendingCount;
    const holder = leaseFor('node-a', scheduler);

    expect(await holder.acquire()).toBe(true);
    const armed = scheduler.pendingCount;
    expect(await holder.acquire()).toBe(true);
    expect(scheduler.pendingCount).toBe(armed);

    await holder.release();
    expect(scheduler.pendingCount).toBe(before);
  });

  test('a TTL below the cadence floor is still renewed inside every TTL', async () => {
    // The derived cadence is a third of the TTL with a 100 ms floor, so a 90 ms
    // TTL used to be renewed every 100 ms — after the record had lapsed, which
    // only worked while a late renewal extended a lapsed record.
    const scheduler = new ManualScheduler();
    const leaseOptions = LeaseOptions.create()
      .withName('virtual-lease')
      .withOwner('node-a')
      .withTtlMs(90)
      .withScheduler(scheduler);
    const holder = new InMemoryLease(leaseOptions);
    expect(await holder.acquire()).toBe(true);

    scheduler.advance(900);

    expect(holder.checkAlive()).toBe(true);
    expect(inMemoryLeaseStore.peek('virtual-lease', scheduler.now())?.owner).toBe('node-a');
  });
});
