/**
 * Demonstrates the scheduler: scheduleOnce and scheduleAtFixedRate.
 *
 *   tsx examples/scheduler.ts
 */
import { Actor, ActorSystem, Props } from '../src/index.js';

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
  const actor = system.spawn(Props.create(() => new TickActor()), 'ticker');

  // Fire once after 100ms.
  system.scheduler.scheduleOnce(100, actor, 'once');

  // Then fire 'tick' every 50ms starting immediately.
  const periodic = system.scheduler.scheduleAtFixedRate(0, 50, actor, 'tick');

  await new Promise(resolve => setTimeout(resolve, 500));
  periodic.cancel();
  await system.terminate();
}

void main();
