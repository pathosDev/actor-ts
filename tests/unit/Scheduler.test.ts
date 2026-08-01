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

describe('Scheduler.scheduleOnceFunction', () => {
  test('fires the callback after the delay', async () => {
    const scheduler = new Scheduler();
    let fired = false;
    scheduler.scheduleOnceFunction(20, () => { fired = true; });
    expect(fired).toBe(false);
    await sleep(60);
    expect(fired).toBe(true);
  });

  test('cancel prevents the callback', async () => {
    const scheduler = new Scheduler();
    let fired = false;
    const cancellable = scheduler.scheduleOnceFunction(20, () => { fired = true; });
    expect(cancellable.cancel()).toBe(true);
    expect(cancellable.isCancelled).toBe(true);
    await sleep(50);
    expect(fired).toBe(false);
  });

  test('cancel called twice returns false the second time', () => {
    const scheduler = new Scheduler();
    const cancellable = scheduler.scheduleOnceFunction(100, () => {});
    expect(cancellable.cancel()).toBe(true);
    expect(cancellable.cancel()).toBe(false);
  });

  test('shutdown prevents delivery for unfired timers', async () => {
    const scheduler = new Scheduler();
    let fired = false;
    scheduler.scheduleOnceFunction(30, () => { fired = true; });
    scheduler.shutdown();
    await sleep(60);
    expect(fired).toBe(false);
  });

  test('exceptions in the callback do not propagate', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const scheduler = new Scheduler();
      scheduler.scheduleOnceFunction(10, () => { throw new Error('boom'); });
      await sleep(30);
      expect(true).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});

describe('Scheduler.scheduleOnce (message to actor)', () => {
  test('delivers the message exactly once to the target', async () => {
    const scheduler = new Scheduler();
    const ref = new RecordingRef<string>();
    scheduler.scheduleOnce(10, ref, 'hi');
    await sleep(40);
    expect(ref.received).toEqual(['hi']);
  });

  test('cancel prevents delivery', async () => {
    const scheduler = new Scheduler();
    const ref = new RecordingRef<string>();
    const cancellable = scheduler.scheduleOnce(10, ref, 'hi');
    cancellable.cancel();
    await sleep(30);
    expect(ref.received).toEqual([]);
  });
});

describe('Scheduler.scheduleAtFixedRateFunction', () => {
  test('fires periodically until cancelled', async () => {
    const scheduler = new Scheduler();
    let count = 0;
    const cancellable = scheduler.scheduleAtFixedRateFunction(0, 20, () => { count++; });
    await sleep(110);
    cancellable.cancel();
    const snapshot = count;
    await sleep(50);
    expect(snapshot).toBeGreaterThanOrEqual(3);
    // After cancel the count must not grow further.
    expect(count).toBe(snapshot);
  });

  test('respects the initial delay', async () => {
    const scheduler = new Scheduler();
    let count = 0;
    const cancellable = scheduler.scheduleAtFixedRateFunction(40, 20, () => { count++; });
    await sleep(10); // inside initial delay
    expect(count).toBe(0);
    await sleep(80);
    cancellable.cancel();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('shutdown suppresses further firings', async () => {
    const scheduler = new Scheduler();
    let count = 0;
    scheduler.scheduleAtFixedRateFunction(0, 20, () => { count++; });
    await sleep(50);
    scheduler.shutdown();
    const snapshot = count;
    await sleep(80);
    expect(count).toBe(snapshot);
  });

  test('exceptions in the callback do not stop the schedule', async () => {
    const originalError = console.error;
    console.error = () => {}; // suppress expected "scheduler error" log
    try {
      const scheduler = new Scheduler();
      let count = 0;
      const cancellable = scheduler.scheduleAtFixedRateFunction(0, 20, () => {
        count++;
        if (count === 2) throw new Error('transient');
      });
      await sleep(100);
      cancellable.cancel();
      expect(count).toBeGreaterThanOrEqual(3);
    } finally {
      console.error = originalError;
    }
  });
});

describe('Scheduler.scheduleAtFixedRate (message delivery)', () => {
  test('delivers messages repeatedly', async () => {
    const scheduler = new Scheduler();
    const ref = new RecordingRef<string>();
    const cancellable = scheduler.scheduleAtFixedRate(0, 20, ref, 'tick');
    await sleep(90);
    cancellable.cancel();
    expect(ref.received.length).toBeGreaterThanOrEqual(3);
    for (const message of ref.received) expect(message).toBe('tick');
  });
});
