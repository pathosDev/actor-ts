import { describe, expect, test, beforeEach } from 'bun:test';
import { InMemoryLease, LeaseOptions, inMemoryLeaseStore } from '../../../src/coordination/index.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

beforeEach(() => {
  inMemoryLeaseStore._clear();
});

describe('InMemoryLease', () => {
  test('acquire succeeds when nothing holds the lease', async () => {
    const leaseOptions = LeaseOptions.create()
      .withName('a')
      .withOwner('me')
      .withTtlMs(200);
    const lease = new InMemoryLease(leaseOptions);
    expect(await lease.acquire()).toBe(true);
    expect(lease.checkAlive()).toBe(true);
    await lease.release();
  });

  test('second holder is denied while first still holds', async () => {
    const leaseOptions = LeaseOptions.create()
      .withName('b')
      .withOwner('A')
      .withTtlMs(500);
    const leaseA = new InMemoryLease(leaseOptions);
    const leaseOptions2 = LeaseOptions.create()
      .withName('b')
      .withOwner('B')
      .withTtlMs(500);
    const leaseB = new InMemoryLease(leaseOptions2);
    expect(await leaseA.acquire()).toBe(true);
    expect(await leaseB.acquire()).toBe(false);
    await leaseA.release();
  });

  test('release lets a new holder acquire', async () => {
    const leaseOptions = LeaseOptions.create()
      .withName('c')
      .withOwner('A')
      .withTtlMs(500);
    const leaseA = new InMemoryLease(leaseOptions);
    const leaseOptions2 = LeaseOptions.create()
      .withName('c')
      .withOwner('B')
      .withTtlMs(500);
    const leaseB = new InMemoryLease(leaseOptions2);
    await leaseA.acquire();
    await leaseA.release();
    expect(await leaseB.acquire()).toBe(true);
    await leaseB.release();
  });

  test('renewal keeps the lease alive past the initial TTL', async () => {
    const leaseOptions = LeaseOptions.create()
      .withName('d')
      .withOwner('A')
      .withTtlMs(120)
      .withRenewalIntervalMs(40);
    const lease = new InMemoryLease(
      leaseOptions,
    );
    await lease.acquire();
    await sleep(300); // several TTL spans — renewal must kick in
    expect(lease.checkAlive()).toBe(true);
    await lease.release();
  });

  test('acquire retries respect acquireRetries setting', async () => {
    const leaseOptions = LeaseOptions.create()
      .withName('e')
      .withOwner('A')
      .withTtlMs(200);
    const leaseA = new InMemoryLease(leaseOptions);
    await leaseA.acquire();

    const leaseOptions2 = LeaseOptions.create()
      .withName('e')
      .withOwner('B')
      .withTtlMs(200)
      .withAcquireRetries(3)
      .withAcquireRetryDelayMs(50);
    // Retry delay is bumped to 50 ms (was 10) so the elapsed-time
    // assertion has real headroom — `bun test --coverage` on the
    // GitHub-hosted runners regularly fires setTimeout 1–2 ms early,
    // which made the previous `>= 20` bound flake on the 20 ms-exact
    // budget.  100 ms minimum + ≥ 80 ms assertion gives ~20 ms of
    // tolerance without slowing the suite meaningfully.
    const leaseB = new InMemoryLease(
      leaseOptions2,
    );
    const start = Date.now();
    expect(await leaseB.acquire()).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(80); // 2 × 50 ms with timer-skew slack

    await leaseA.release();
    expect(await leaseB.acquire()).toBe(true);
    await leaseB.release();
  });

  test('expired lease (after TTL with no renewal) can be re-acquired', async () => {
    const leaseOptions = LeaseOptions.create()
      .withName('f')
      .withOwner('A')
      .withTtlMs(50)
      .withRenewalIntervalMs(100_000);
    // Disable the renewal loop by using TTL equal to a very short renewal.
    const leaseA = new InMemoryLease(
      leaseOptions, // never fires
    );
    await leaseA.acquire();
    const leaseOptions2 = LeaseOptions.create()
      .withName('f')
      .withOwner('B')
      .withTtlMs(200);
    await sleep(80); // let TTL expire

    const leaseB = new InMemoryLease(leaseOptions2);
    expect(await leaseB.acquire()).toBe(true);
    await leaseB.release();
  });
});
