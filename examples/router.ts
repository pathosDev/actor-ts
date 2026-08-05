/**
 * A router fronting a pool of workers.  Messages are distributed round-robin
 * across 4 workers.
 *
 *   tsx examples/router.ts
 */
import { Actor, ActorSystem, Broadcast, Router } from '../src/index.js';
import { attachDevTools } from './devtools.js';

class Worker extends Actor<string> {
  override onReceive(job: string): void {
    console.log(`[${this.self.path.name}] processing "${job}"`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('router-demo');
  const devtools = await attachDevTools(system);

  const pool = system.spawn(
    Router.roundRobin(4, Worker),
    'pool',
  );

  for (let i = 1; i <= 10; i++) pool.tell(`job-${i}`);

  // Broadcast a message to every worker.
  pool.tell(new Broadcast('shutdown-notice'));

  await new Promise(resolve => setTimeout(resolve, 100));
  await devtools.holdOpen();
  await system.terminate();
}

void main();
