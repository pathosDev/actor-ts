import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { Props } from '../../../src/Props.js';
import { TestKit } from '../../../src/testkit/TestKit.js';

describe('TestKit', () => {
  test('creates a usable ActorSystem and probes', async () => {
    const tk = TestKit.create('unit');
    expect(tk.system).toBeDefined();
    expect(tk.system.isTerminated).toBe(false);
    const probe = tk.createTestProbe();
    expect(probe.messageCount).toBe(0);
    await tk.shutdown();
    expect(tk.system.isTerminated).toBe(true);
  });

  test('default is quiet — no console output from the actor log', async () => {
    const originalLog = console.log;
    const lines: unknown[][] = [];
    console.log = (...args) => { lines.push(args); };
    try {
      const tk = TestKit.create('quiet');
      class Loud extends Actor<string> {
        override onReceive(m: string): void { this.log.info('hello', m); }
      }
      const ref = tk.system.spawn(Props.create(() => new Loud()), 'loud');
      ref.tell('world');
      await Bun.sleep(30);
      expect(lines).toEqual([]);
      await tk.shutdown();
    } finally {
      console.log = originalLog;
    }
  });

  test('withManualScheduler returns a scheduler wired into the system', async () => {
    const { kit, scheduler } = TestKit.withManualScheduler('ms-kit');
    expect(kit.system.scheduler).toBe(scheduler);
    await kit.shutdown();
  });

  test('timers driven by ManualScheduler fire deterministically via advance()', async () => {
    const { kit, scheduler } = TestKit.withManualScheduler('timer-kit');
    const probe = kit.createTestProbe();
    class T extends Actor<string> {
      constructor(private readonly probe: typeof probe) { super(); }
      override preStart(): void {
        this.context.timers.startSingleTimer('k', 'tick', 100);
      }
      override onReceive(m: string): void { this.probe.tell(m); }
    }
    kit.system.spawn(Props.create(() => new T(probe)), 't');

    await Bun.sleep(10); // let preStart run
    // No wall-clock elapsed — without advance the timer stays pending.
    await probe.expectNoMessage(30);

    scheduler.advance(100);
    // The probe receives 'tick' after advance.
    expect(await probe.receiveOne(200)).toBe('tick');

    await kit.shutdown();
  });
});
