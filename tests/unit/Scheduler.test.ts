import { describe, expect, test } from 'bun:test';
import { ActorRef } from '../../src/ActorRef.js';
import { ActorPath } from '../../src/ActorPath.js';
import { Scheduler } from '../../src/Scheduler.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/** Captures `tell` calls into an array for verification. */
class RecordingRef<T = unknown> extends ActorRef<T> {
  readonly path = new ActorPath('rec');
  readonly received: T[] = [];
  tell(message: T): void { this.received.push(message); }
}

describe('Scheduler.scheduleOnceFn', () => {
  test('fires the callback after the delay', async () => {
    const s = new Scheduler();
    let fired = false;
    s.scheduleOnceFn(20, () => { fired = true; });
    expect(fired).toBe(false);
    await sleep(60);
    expect(fired).toBe(true);
  });

  test('cancel prevents the callback', async () => {
    const s = new Scheduler();
    let fired = false;
    const c = s.scheduleOnceFn(20, () => { fired = true; });
    expect(c.cancel()).toBe(true);
    expect(c.isCancelled).toBe(true);
    await sleep(50);
    expect(fired).toBe(false);
  });

  test('cancel called twice returns false the second time', () => {
    const s = new Scheduler();
    const c = s.scheduleOnceFn(100, () => {});
    expect(c.cancel()).toBe(true);
    expect(c.cancel()).toBe(false);
  });

  test('shutdown prevents delivery for unfired timers', async () => {
    const s = new Scheduler();
    let fired = false;
    s.scheduleOnceFn(30, () => { fired = true; });
    s.shutdown();
    await sleep(60);
    expect(fired).toBe(false);
  });

  test('exceptions in the callback do not propagate', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const s = new Scheduler();
      s.scheduleOnceFn(10, () => { throw new Error('boom'); });
      await sleep(30);
      expect(true).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});

describe('Scheduler.scheduleOnce (message to actor)', () => {
  test('delivers the message exactly once to the target', async () => {
    const s = new Scheduler();
    const ref = new RecordingRef<string>();
    s.scheduleOnce(10, ref, 'hi');
    await sleep(40);
    expect(ref.received).toEqual(['hi']);
  });

  test('cancel prevents delivery', async () => {
    const s = new Scheduler();
    const ref = new RecordingRef<string>();
    const c = s.scheduleOnce(10, ref, 'hi');
    c.cancel();
    await sleep(30);
    expect(ref.received).toEqual([]);
  });
});

describe('Scheduler.scheduleAtFixedRateFn', () => {
  test('fires periodically until cancelled', async () => {
    const s = new Scheduler();
    let count = 0;
    const c = s.scheduleAtFixedRateFn(0, 20, () => { count++; });
    await sleep(110);
    c.cancel();
    const snapshot = count;
    await sleep(50);
    expect(snapshot).toBeGreaterThanOrEqual(3);
    // After cancel the count must not grow further.
    expect(count).toBe(snapshot);
  });

  test('respects the initial delay', async () => {
    const s = new Scheduler();
    let count = 0;
    const c = s.scheduleAtFixedRateFn(40, 20, () => { count++; });
    await sleep(10); // inside initial delay
    expect(count).toBe(0);
    await sleep(80);
    c.cancel();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('shutdown suppresses further firings', async () => {
    const s = new Scheduler();
    let count = 0;
    s.scheduleAtFixedRateFn(0, 20, () => { count++; });
    await sleep(50);
    s.shutdown();
    const snapshot = count;
    await sleep(80);
    expect(count).toBe(snapshot);
  });

  test('exceptions in the callback do not stop the schedule', async () => {
    const originalError = console.error;
    console.error = () => {}; // suppress expected "scheduler error" log
    try {
      const s = new Scheduler();
      let count = 0;
      const c = s.scheduleAtFixedRateFn(0, 20, () => {
        count++;
        if (count === 2) throw new Error('transient');
      });
      await sleep(100);
      c.cancel();
      expect(count).toBeGreaterThanOrEqual(3);
    } finally {
      console.error = originalError;
    }
  });
});

describe('Scheduler.scheduleAtFixedRate (message delivery)', () => {
  test('delivers messages repeatedly', async () => {
    const s = new Scheduler();
    const ref = new RecordingRef<string>();
    const c = s.scheduleAtFixedRate(0, 20, ref, 'tick');
    await sleep(90);
    c.cancel();
    expect(ref.received.length).toBeGreaterThanOrEqual(3);
    for (const m of ref.received) expect(m).toBe('tick');
  });
});
