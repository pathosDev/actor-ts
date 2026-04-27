import { describe, expect, test, beforeEach } from 'bun:test';
import { InMemoryLease, inMemoryLeaseStore } from '../../../src/coordination/index.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

beforeEach(() => {
  inMemoryLeaseStore._clear();
});

describe('InMemoryLease', () => {
  test('acquire succeeds when nothing holds the lease', async () => {
    const lease = new InMemoryLease({ name: 'a', owner: 'me', ttlMs: 200 });
    expect(await lease.acquire()).toBe(true);
    expect(lease.checkAlive()).toBe(true);
    await lease.release();
  });

  test('second holder is denied while first still holds', async () => {
    const a = new InMemoryLease({ name: 'b', owner: 'A', ttlMs: 500 });
    const b = new InMemoryLease({ name: 'b', owner: 'B', ttlMs: 500 });
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    await a.release();
  });

  test('release lets a new holder acquire', async () => {
    const a = new InMemoryLease({ name: 'c', owner: 'A', ttlMs: 500 });
    const b = new InMemoryLease({ name: 'c', owner: 'B', ttlMs: 500 });
    await a.acquire();
    await a.release();
    expect(await b.acquire()).toBe(true);
    await b.release();
  });

  test('renewal keeps the lease alive past the initial TTL', async () => {
    const lease = new InMemoryLease({
      name: 'd', owner: 'A', ttlMs: 120, renewalIntervalMs: 40,
    });
    await lease.acquire();
    await sleep(300); // several TTL spans — renewal must kick in
    expect(lease.checkAlive()).toBe(true);
    await lease.release();
  });

  test('acquire retries respect acquireRetries setting', async () => {
    const a = new InMemoryLease({ name: 'e', owner: 'A', ttlMs: 200 });
    await a.acquire();

    const b = new InMemoryLease({
      name: 'e', owner: 'B', ttlMs: 200,
      acquireRetries: 3, acquireRetryDelayMs: 10,
    });
    const start = Date.now();
    expect(await b.acquire()).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20); // at least 2 delays

    await a.release();
    expect(await b.acquire()).toBe(true);
    await b.release();
  });

  test('expired lease (after TTL with no renewal) can be re-acquired', async () => {
    // Disable the renewal loop by using TTL equal to a very short renewal.
    const a = new InMemoryLease({
      name: 'f', owner: 'A', ttlMs: 50, renewalIntervalMs: 100_000, // never fires
    });
    await a.acquire();
    await sleep(80); // let TTL expire

    const b = new InMemoryLease({ name: 'f', owner: 'B', ttlMs: 200 });
    expect(await b.acquire()).toBe(true);
    await b.release();
  });
});
