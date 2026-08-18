import { describe, expect, test } from 'bun:test';
import { ActorRef } from '../../src/ActorRef.js';
import { ActorPath } from '../../src/ActorPath.js';
import { Scheduler } from '../../src/Scheduler.js';
import { awaitCondition } from '../util/AwaitCondition.js';

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
    // The 20 ms lower bound is asserted by the `false` above; this half only
    // has to see the callback land.
    await awaitCondition(() => fired, {
      timeoutMs: 4_000,
      label: 'the one-shot callback fired',
    });
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

  test('a throwing callback is reported to the sink instead of propagating', async () => {
    // The old shape of this test stubbed `console.error` to a no-op and then
    // asserted `expect(true).toBe(true)`, so it could not tell a working error
    // channel from no channel at all.  The destination is the claim (#678):
    // with a sink wired, the console branch is not taken and the failure is
    // observable.
    const scheduler = new Scheduler();
    const reported: unknown[] = [];
    scheduler.onError = (error) => { reported.push(error); };
    scheduler.scheduleOnceFunction(10, () => { throw new Error('boom'); });
    await awaitCondition(() => reported.length === 1, {
      timeoutMs: 4_000,
      label: 'the throwing callback was reported to the scheduler error sink',
    });
    expect((reported[0] as Error).message).toBe('boom');
  });
});

describe('Scheduler.scheduleOnce (message to actor)', () => {
  test('delivers the message exactly once to the target', async () => {
    const scheduler = new Scheduler();
    const ref = new RecordingRef<string>();
    scheduler.scheduleOnce(10, ref, 'hi');
    await awaitCondition(() => ref.received.length === 1, {
      timeoutMs: 4_000,
      label: 'the scheduled message was delivered',
    });
    // "exactly once" is the other half of the claim, and polling returns on
    // the first delivery — so the settle is what would catch a second.
    await sleep(30);
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
    await awaitCondition(() => count >= 3, {
      timeoutMs: 4_000,
      label: 'the fixed-rate callback fired at least three times',
    });
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
    await sleep(10); // inside initial delay — the elapsed time *is* the claim
    expect(count).toBe(0);
    await awaitCondition(() => count >= 1, {
      timeoutMs: 4_000,
      label: 'the schedule fired once the initial delay elapsed',
    });
    cancellable.cancel();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('shutdown suppresses further firings', async () => {
    const scheduler = new Scheduler();
    let count = 0;
    scheduler.scheduleAtFixedRateFunction(0, 20, () => { count++; });
    // Without this the shutdown could land before the first firing and the
    // assertion would compare 0 against 0.
    await awaitCondition(() => count >= 1, {
      timeoutMs: 4_000,
      label: 'the schedule fired before the shutdown',
    });
    scheduler.shutdown();
    const snapshot = count;
    await sleep(80);
    expect(count).toBe(snapshot);
  });

  test('exceptions in the callback do not stop the schedule', async () => {
    const scheduler = new Scheduler();
    const reported: unknown[] = [];
    scheduler.onError = (error) => { reported.push(error); };
    let count = 0;
    const cancellable = scheduler.scheduleAtFixedRateFunction(0, 20, () => {
      count++;
      if (count === 2) throw new Error('transient');
    });
    await awaitCondition(() => count >= 3, {
      timeoutMs: 4_000,
      label: 'the schedule kept firing past the throwing tick',
    });
    cancellable.cancel();
    expect(count).toBeGreaterThanOrEqual(3);
    // Surviving the throw was this test's whole claim, and it stayed true
    // whether the error went anywhere or not.  The other half is that the tick
    // was reported exactly once (#678).
    expect(reported.length).toBe(1);
    expect((reported[0] as Error).message).toBe('transient');
  });
});

describe('Scheduler.scheduleAtFixedRate (message delivery)', () => {
  test('delivers messages repeatedly', async () => {
    const scheduler = new Scheduler();
    const ref = new RecordingRef<string>();
    const cancellable = scheduler.scheduleAtFixedRate(0, 20, ref, 'tick');
    await awaitCondition(() => ref.received.length >= 3, {
      timeoutMs: 4_000,
      label: 'the repeating schedule delivered at least three messages',
    });
    cancellable.cancel();
    expect(ref.received.length).toBeGreaterThanOrEqual(3);
    for (const message of ref.received) expect(message).toBe('tick');
  });
});

// #641 / #762 — `shutdown()` set a flag and stopped there.  That makes the
// callbacks no-ops but leaves the native handles armed, and an armed
// `setInterval` holds the event loop open: a terminated ActorSystem kept the
// whole process alive.
describe('Scheduler.shutdown', () => {
  test('clears the handles it created, not just their callbacks', async () => {
    const scheduler = new Scheduler();
    const fired: string[] = [];

    const once = scheduler.scheduleOnceFunction(20, () => fired.push('once'));
    const repeating = scheduler.scheduleAtFixedRateFunction(10, 10, () => fired.push('tick'));

    scheduler.shutdown();

    // Observable proxy for "the handle is gone": a cleared schedule reports
    // itself finished, where a suppressed one would still look pending.
    expect(once.isCancelled).toBe(true);
    expect(repeating.isCancelled).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fired).toEqual([]);
  });

  test('a schedule armed before shutdown cannot fire after it', async () => {
    const scheduler = new Scheduler();
    let fired = false;
    scheduler.scheduleOnceFunction(15, () => { fired = true; });
    scheduler.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fired).toBe(false);
  });

  test('shutdown is idempotent', () => {
    const scheduler = new Scheduler();
    scheduler.scheduleOnceFunction(50, () => {});
    scheduler.shutdown();
    expect(() => scheduler.shutdown()).not.toThrow();
  });
});

// #642 — a fired one-shot never flipped its own cancelled flag, so every
// consumer that asked "is this still pending?" got the wrong answer forever.
describe('Cancellable settlement', () => {
  test('a fired one-shot reports itself finished', async () => {
    const scheduler = new Scheduler();
    // The callback records the firing so the wait has an anchor that is not
    // `isCancelled` itself — that flag is the assertion, and polling it would
    // make the test pass by definition.
    let ran = false;
    const handle = scheduler.scheduleOnceFunction(5, () => { ran = true; });
    expect(handle.isCancelled).toBe(false);

    await awaitCondition(() => ran, {
      timeoutMs: 4_000,
      label: 'the one-shot ran',
    });
    expect(handle.isCancelled).toBe(true);
  });

  test('cancelling an already-fired one-shot returns false', async () => {
    // "Did I get there before it ran?" was unanswerable: cancel() always
    // claimed success.
    const scheduler = new Scheduler();
    let ran = false;
    const handle = scheduler.scheduleOnceFunction(5, () => { ran = true; });
    await awaitCondition(() => ran, {
      timeoutMs: 4_000,
      label: 'the one-shot ran',
    });

    expect(handle.cancel()).toBe(false);
  });

  test('cancelling before it fires returns true, and only once', () => {
    const scheduler = new Scheduler();
    const handle = scheduler.scheduleOnceFunction(1_000, () => {});
    expect(handle.cancel()).toBe(true);
    expect(handle.cancel()).toBe(false);
    scheduler.shutdown();
  });

  test('a repeating schedule stays pending across ticks', async () => {
    // Only cancellation ends a repeating schedule — it must not settle the
    // way a one-shot does after its first run.
    const scheduler = new Scheduler();
    let ticks = 0;
    const handle = scheduler.scheduleAtFixedRateFunction(5, 5, () => { ticks++; });

    await awaitCondition(() => ticks > 1, {
      timeoutMs: 4_000,
      label: 'the repeating schedule ticked more than once',
    });
    expect(ticks).toBeGreaterThan(1);
    expect(handle.isCancelled).toBe(false);

    handle.cancel();
    expect(handle.isCancelled).toBe(true);
    scheduler.shutdown();
  });
});
