import { describe, expect, test } from 'bun:test';
import { ActorPath } from '../../../src/ActorPath.js';
import { ActorRef } from '../../../src/ActorRef.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';

class RecordingRef<T = unknown> extends ActorRef<T> {
  readonly path = new ActorPath('rec');
  readonly received: T[] = [];
  tell(m: T): void { this.received.push(m); }
}

describe('ManualScheduler.scheduleOnceFn', () => {
  test('fires when virtual time reaches the deadline', () => {
    const s = new ManualScheduler();
    let fired = 0;
    s.scheduleOnceFn(100, () => { fired++; });
    expect(fired).toBe(0);
    s.advance(50);
    expect(fired).toBe(0);
    s.advance(50);
    expect(fired).toBe(1);
    s.advance(500);
    expect(fired).toBe(1);
  });

  test('cancel prevents firing', () => {
    const s = new ManualScheduler();
    let fired = 0;
    const c = s.scheduleOnceFn(10, () => { fired++; });
    expect(c.cancel()).toBe(true);
    expect(c.isCancelled).toBe(true);
    s.advance(1_000);
    expect(fired).toBe(0);
    expect(c.cancel()).toBe(false); // already cancelled
  });

  test('tasks fire in deterministic order (earliest first, ties break by id)', () => {
    const s = new ManualScheduler();
    const order: string[] = [];
    s.scheduleOnceFn(10, () => order.push('a'));
    s.scheduleOnceFn(10, () => order.push('b')); // same time, later id
    s.scheduleOnceFn(5,  () => order.push('c')); // earlier
    s.advance(20);
    expect(order).toEqual(['c', 'a', 'b']);
  });

  test('now() reflects the fire time of the most recent task', () => {
    const s = new ManualScheduler();
    s.scheduleOnceFn(30, () => {});
    s.advance(100);
    expect(s.now()).toBe(100);
  });
});

describe('ManualScheduler.scheduleAtFixedRateFn', () => {
  test('fires repeatedly at the given interval', () => {
    const s = new ManualScheduler();
    let count = 0;
    const c = s.scheduleAtFixedRateFn(0, 50, () => { count++; });
    s.advance(25);
    expect(count).toBe(1);      // fires at t=0
    s.advance(50);
    expect(count).toBe(2);      // fires at t=50
    s.advance(100);
    expect(count).toBe(4);      // fires at 100, 150
    c.cancel();
    s.advance(100);
    expect(count).toBe(4);      // no further firings after cancel
  });

  test('respects the initial delay', () => {
    const s = new ManualScheduler();
    let count = 0;
    s.scheduleAtFixedRateFn(30, 10, () => { count++; });
    s.advance(20);
    expect(count).toBe(0);
    s.advance(20);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe('ManualScheduler — actor refs', () => {
  test('scheduleOnce delivers a message to an ActorRef', () => {
    const s = new ManualScheduler();
    const ref = new RecordingRef<string>();
    s.scheduleOnce(20, ref, 'tick');
    s.advance(50);
    expect(ref.received).toEqual(['tick']);
  });

  test('scheduleAtFixedRate delivers repeatedly', () => {
    const s = new ManualScheduler();
    const ref = new RecordingRef<string>();
    s.scheduleAtFixedRate(0, 10, ref, 'beat');
    s.advance(35);
    expect(ref.received.length).toBe(4); // t=0,10,20,30
  });
});

describe('ManualScheduler lifecycle', () => {
  test('shutdown clears pending tasks', () => {
    const s = new ManualScheduler();
    let fired = 0;
    s.scheduleOnceFn(10, () => { fired++; });
    s.shutdown();
    s.advance(100);
    expect(fired).toBe(0);
  });

  test('scheduling after shutdown yields a pre-cancelled handle', () => {
    const s = new ManualScheduler();
    s.shutdown();
    const c = s.scheduleOnceFn(10, () => {});
    expect(c.isCancelled).toBe(true);
  });

  test('pendingCount reflects active tasks', () => {
    const s = new ManualScheduler();
    expect(s.pendingCount).toBe(0);
    s.scheduleOnceFn(10, () => {});
    s.scheduleOnceFn(20, () => {});
    expect(s.pendingCount).toBe(2);
    s.advance(15);
    expect(s.pendingCount).toBe(1);
  });

  test('advanceToNext jumps to the next pending fireAt', () => {
    const s = new ManualScheduler();
    let fired = false;
    s.scheduleOnceFn(500, () => { fired = true; });
    s.advanceToNext();
    expect(s.now()).toBe(500);
    expect(fired).toBe(true);
  });

  test('task exceptions are swallowed (scheduler keeps running)', () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const s = new ManualScheduler();
      let subsequent = 0;
      s.scheduleOnceFn(5, () => { throw new Error('oops'); });
      s.scheduleOnceFn(10, () => { subsequent++; });
      s.advance(50);
      expect(subsequent).toBe(1);
    } finally {
      console.error = originalError;
    }
  });
});
