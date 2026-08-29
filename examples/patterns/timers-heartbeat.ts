/**
 * Per-actor Timers example — a heartbeat every 50 ms plus a one-shot
 * graceful-shutdown timer after 300 ms.  Both timers are automatically
 * cancelled when the actor stops.
 *
 *   bun run examples/patterns/timers-heartbeat.ts
 */
import { Actor, ActorSystem } from '../../src/index.js';

type Message = 'heartbeat' | 'shutdown';

class Monitor extends Actor<Message> {
  private count = 0;

  override preStart(): void {
    this.context.timers.startTimerWithFixedDelay('hb', 'heartbeat', 50, 0);
    this.context.timers.startSingleTimer('exit', 'shutdown', 300);
  }

  override onReceive(m: Message): void {
    if (m === 'heartbeat') {
      this.count++;
      this.log.info(`heartbeat #${this.count} (active timers: ${this.context.timers.activeKeys().join(', ')})`);
    } else {
      this.log.info(`shutting down after ${this.count} beats`);
      this.self.stop(); // stop triggers timers.cancelAll()
    }
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('timers-demo');
  system.spawn(Monitor, 'monitor');
  // Not a drain sleep: nothing is ever told to the monitor.  Every heartbeat
  // comes from the timer it arms in preStart, and the drain does not wait for
  // work that is not enqueued yet — this 400 ms *is* the five heartbeats.
  await new Promise(r => setTimeout(r, 400));
  await system.terminate();
}

void main();
