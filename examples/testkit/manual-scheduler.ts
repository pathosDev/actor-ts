/**
 * ManualScheduler: drive timers deterministically from a test — no sleeps.
 *
 *   bun run examples/testkit/manual-scheduler.ts
 */
import { Actor, Props, TestKit } from '../../src/index.js';

class Heartbeat extends Actor<'tick'> {
  constructor(private readonly probe: import('../../src/index.js').TestProbe) { super(); }
  override preStart(): void {
    this.context.timers.startTimerWithFixedDelay('hb', 'tick', 100, 50);
  }
  override onReceive(_: 'tick'): void { this.probe.tell('beat'); }
}

async function main(): Promise<void> {
  const { kit, scheduler } = TestKit.withManualScheduler('ms-demo');
  const probe = kit.createTestProbe();
  kit.system.actorOf(Props.create(() => new Heartbeat(probe)), 'hb');

  // preStart runs on its own dispatcher tick — give it a real micro-sleep.
  await Bun.sleep(5);

  console.log('pending tasks before advance:', scheduler.pendingCount);
  scheduler.advance(50);   // initial delay elapsed → first tick
  console.log('after first tick received:', await probe.receiveOne(50));

  scheduler.advance(100);  // one interval → second tick
  console.log('after second tick received:', await probe.receiveOne(50));

  scheduler.advance(200);  // two more intervals → two more ticks
  console.log('after 200 ms advance  :', await probe.receiveN(2, 50));

  await kit.shutdown();
}

void main();
