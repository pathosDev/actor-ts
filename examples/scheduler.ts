/**
 * Demonstrates the scheduler: scheduleOnce and scheduleAtFixedRate.
 *
 *   tsx examples/scheduler.ts
 */
import { Actor, ActorSystem } from '../src/index.js';
import { attachDevTools } from './devtools.js';

class TickActor extends Actor<'tick' | 'once'> {
  private count = 0;

  override onReceive(message: 'tick' | 'once'): void {
    if (message === 'once') {
      console.log('[once] fired');
      return;
    }
    this.count++;
    console.log(`[tick] #${this.count}`);
    if (this.count >= 5) {
      this.self.stop();
    }
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('scheduler');
  const devtools = await attachDevTools(system);
  const actor = system.spawn(() => new TickActor(), 'ticker');

  // Fire once after 100ms.
  system.scheduler.scheduleOnce(100, actor, 'once');

  // Then fire 'tick' every 50ms starting immediately.
  const periodic = system.scheduler.scheduleAtFixedRate(0, 50, actor, 'tick');

  await new Promise(resolve => setTimeout(resolve, 500));
  periodic.cancel();
  await devtools.holdOpen();
  await system.terminate();
}

void main();
