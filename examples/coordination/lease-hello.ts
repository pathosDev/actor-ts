/**
 * Hello Lease: two competing processes (simulated by two InMemoryLease
 * instances) race for the same lease.  Only one wins; the other politely
 * backs off until the winner releases.
 *
 *   bun run examples/coordination/lease-hello.ts
 */
import { InMemoryLease } from '../../src/index.js';

async function main(): Promise<void> {
  const primary = new InMemoryLease({
    name: 'critical-section', owner: 'worker-A', ttlMs: 300, renewalIntervalMs: 100,
  });
  const backup = new InMemoryLease({
    name: 'critical-section', owner: 'worker-B', ttlMs: 300,
    acquireRetries: 5, acquireRetryDelayMs: 80,
  });

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
