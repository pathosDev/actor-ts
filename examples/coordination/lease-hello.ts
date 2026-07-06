/**
 * Hello Lease: two competing processes (simulated by two InMemoryLease
 * instances) race for the same lease.  Only one wins; the other politely
 * backs off until the winner releases.
 *
 *   bun run examples/coordination/lease-hello.ts
 */
import { InMemoryLease, LeaseOptions } from '../../src/index.js';

async function main(): Promise<void> {
  const primary = new InMemoryLease(
    LeaseOptions.create().withName('critical-section').withOwner('worker-A').withTtlMs(300).withRenewalIntervalMs(100),
  );
  const backup = new InMemoryLease(
    LeaseOptions.create().withName('critical-section').withOwner('worker-B').withTtlMs(300)
      .withAcquireRetries(5).withAcquireRetryDelayMs(80),
  );

  const primaryWon = await primary.acquire();
  console.log(`worker-A acquired? ${primaryWon}`);

  // Backup tries while A holds — should fail.
  const backupWhileA = await backup.acquire();
  console.log(`worker-B acquired while A holds? ${backupWhileA}`);

  // A releases; B retries and wins.
  await primary.release();
  console.log('worker-A released the lease');
  const backupAfterRelease = await backup.acquire();
  console.log(`worker-B acquired after release? ${backupAfterRelease}`);

  await backup.release();
}

void main();
