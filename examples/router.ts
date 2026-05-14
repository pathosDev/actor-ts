/**
 * A router fronting a pool of workers.  Messages are distributed round-robin
 * across 4 workers.
 *
 *   tsx examples/router.ts
 */
import { Actor, ActorSystem, Broadcast, Props, Router } from '../src/index.js';

class Worker extends Actor<string> {
  override onReceive(job: string): void {
    console.log(`[${this.self.path.name}] processing "${job}"`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('router-demo');

  const pool = system.spawn(
    Router.roundRobin(4, Props.create(() => new Worker())),
    'pool',
  );

  for (let i = 1; i <= 10; i++) pool.tell(`job-${i}`);

  // Broadcast a message to every worker.
  pool.tell(new Broadcast('shutdown-notice'));

  await new Promise(resolve => setTimeout(resolve, 100));
  await system.terminate();
}

void main();
