/**
 * Multi-core actor cluster via Bun workers.
 *
 *   bun run examples/worker/main.ts
 *
 * Spawns 4 Bun workers, each with its own ActorSystem.  All four form a
 * cluster through the shared WorkerBroker in this process.  Each worker
 * prints a line when it registers itself.
 */
import { WorkerCluster } from '../../src/index.js';

async function main(): Promise<void> {
  const cluster = await WorkerCluster.spawn({
    workers: 4,
    bootstrap: new URL('./worker-node.ts', import.meta.url),
    systemName: 'multi-core',
    hostname: 'worker',
    basePort: 2552,
    initData: { workerId: 0, seedAddr: undefined },
    readyTimeoutMs: 5_000,
  });

  console.log(`Spawned ${cluster.size} workers:`);
  for (const addr of cluster.addresses) console.log('  -', addr.toString());

  // Run for 3 seconds so the workers gossip + shut themselves down.
  await new Promise(resolve => setTimeout(resolve, 3_000));

  await cluster.terminate();
  console.log('main: worker cluster terminated');
}

void main();
