/**
 * Realistic Lease: three "workers" try to run a daily batch job.  Only the
 * lease holder actually executes — the others see the false acquire and
 * wait.  Every 120 ms each worker probes again.  When the holder releases,
 * a different worker takes over on the next tick.
 *
 *   bun run examples/coordination/lease-guarded-work.ts
 */
import { InMemoryLease, LeaseOptions } from '../../src/index.js';

const LEASE = 'daily-batch';

async function worker(name: string, runtimeMs: number, durationMs: number): Promise<void> {
  const leaseOptions = LeaseOptions.create()
    .withName(LEASE)
    .withOwner(name)
    .withTtlMs(300)
    .withRenewalIntervalMs(100);
  const lease = new InMemoryLease(leaseOptions);

  const deadline = Date.now() + runtimeMs;
  while (Date.now() < deadline) {
    if (await lease.acquire()) {
      console.log(`[${name}] ACQUIRED the lease — starting work`);
      await new Promise(r => setTimeout(r, durationMs));
      console.log(`[${name}] work done — releasing`);
      await lease.release();
    } else {
      console.log(`[${name}] probe: someone else holds the lease`);
    }
    await new Promise(r => setTimeout(r, 120));
  }
}

async function main(): Promise<void> {
  // Three workers run concurrently for ~1 second each; each job slot takes
  // 180 ms so there's room for multiple hand-overs.
  await Promise.all([
    worker('alpha',  1_000, 180),
    worker('beta',   1_000, 180),
    worker('gamma',  1_000, 180),
  ]);
}

void main();
