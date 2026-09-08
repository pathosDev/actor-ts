import { describe, expect, test } from 'bun:test';
import { CircuitBreaker, CircuitBreakerTimeoutError } from '../../../src/pattern/CircuitBreaker.js';
import { CircuitBreakerOptions } from '../../../src/pattern/CircuitBreakerOptions.js';
import { after } from '../../../src/pattern/After.js';
import { retry } from '../../../src/pattern/Retry.js';
import { gracefulStop } from '../../../src/pattern/GracefulStop.js';
import { Actor } from '../../../src/Actor.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * #1424 — the four pattern helpers take their time from a scheduler.
 *
 * Each of them holds a duration a test has to cross, and each of them armed a
 * raw timer, so the only way to cross one was to wait.  The circuit breaker's
 * reset window is the worst case: a realistic one is seconds, so every test of
 * "it reopens after the window" either waits those seconds or shrinks the
 * window until it is asserting a shape production never takes.
 */

describe('CircuitBreaker measures its reset window on its scheduler', () => {
  const failing = (): Promise<never> => Promise.reject(new Error('upstream'));

  test('a ten-second reset window is crossed in no real time', async () => {
    const scheduler = new ManualScheduler();
    const breaker = new CircuitBreaker(
      CircuitBreakerOptions.create()
        .withMaxFailures(1)
        .withResetTimeoutMs(10_000)
        .withScheduler(scheduler),
    );
    const realStart = Date.now();

    await expect(breaker.call(failing)).rejects.toThrow('upstream');
    expect(breaker.state).toBe('open');

    // Still open just before the window closes...
    scheduler.advance(9_999);
    await expect(breaker.call(failing)).rejects.toThrow(/circuit breaker is open/);

    // ...and probing the moment it does.
    scheduler.advance(1);
    await expect(breaker.call(failing)).rejects.toThrow('upstream');

    expect(Date.now() - realStart).toBeLessThan(1_000);
  });

  test('nextProbeAt is stamped in virtual time', () => {
    const scheduler = new ManualScheduler();
    const breaker = new CircuitBreaker(
      CircuitBreakerOptions.create()
        .withMaxFailures(1)
        .withResetTimeoutMs(5_000)
        .withScheduler(scheduler),
    );
    scheduler.advance(1_000);
    breaker.setState('open');
    expect(breaker.nextProbeAt).toBe(6_000);
  });

  test('a call timeout fires on the scheduler when time is virtual', async () => {
    const scheduler = new ManualScheduler();
    const breaker = new CircuitBreaker(
      CircuitBreakerOptions.create()
        .withMaxFailures(5)
        .withResetTimeoutMs(1_000)
        .withCallTimeoutMs(3_000)
        .withScheduler(scheduler),
    );
    const pending = breaker.call(() => new Promise<never>(() => { /* never settles */ }));
    scheduler.advance(3_000);
    await expect(pending).rejects.toThrow(CircuitBreakerTimeoutError);
  });

  test('without a scheduler the window is still the wall clock', async () => {
    // Nothing outside a test changes.
    const breaker = new CircuitBreaker(
      CircuitBreakerOptions.create().withMaxFailures(1).withResetTimeoutMs(60_000),
    );
    await expect(breaker.call(failing)).rejects.toThrow('upstream');
    expect(breaker.state).toBe('open');
    // A minute has emphatically not passed, so the breaker is still open.
    await expect(breaker.call(failing)).rejects.toThrow(/circuit breaker is open/);
  });
});

describe('after arms its delay on the scheduler it is given', () => {
  test('a minute-long delay resolves the moment virtual time reaches it', async () => {
    const scheduler = new ManualScheduler();
    let ran = false;
    const pending = after(60_000, async () => { ran = true; return 'done'; }, scheduler);

    scheduler.advance(59_999);
    expect(ran).toBe(false);

    scheduler.advance(1);
    expect(await pending).toBe('done');
    expect(ran).toBe(true);
  });

  test('cancelling disarms the scheduled task rather than leaking it', async () => {
    const scheduler = new ManualScheduler();
    const before = scheduler.pendingCount;
    const pending = after(60_000, async () => 'done', scheduler);
    expect(scheduler.pendingCount).toBe(before + 1);

    pending.cancel();
    await expect(pending).rejects.toThrow(/cancelled/);
    // The advance must not run a factory belonging to a cancelled delay.
    scheduler.advance(60_000);
  });

  test('with no scheduler it still uses a host timer', async () => {
    expect(await after(1, async () => 'real')).toBe('real');
  });
});

describe('retry puts its whole backoff schedule on the scheduler', () => {
  test('five exponential attempts complete in no real time', async () => {
    const scheduler = new ManualScheduler();
    let attempts = 0;
    const realStart = Date.now();

    const pending = retry(async () => {
      attempts++;
      if (attempts < 5) throw new Error('not yet');
      return 'ok';
    }, { attempts: 5, delayMs: 1_000, factor: 2, scheduler });

    // 1s + 2s + 4s + 8s of backoff, which is fifteen real seconds otherwise.
    //
    // Waiting on the scheduler's own state rather than yielding blindly: the
    // retry loop has to reach its `await sleep(...)` before there is anything
    // to advance past, and `pendingCount` is exactly that fact. A fixed yield
    // would be a guess about how many turns the loop takes to get there.
    for (let attempt = 1; attempt < 5; attempt++) {
      await awaitCondition(() => scheduler.pendingCount > 0, {
        label: `retry armed the delay before attempt ${attempt + 1}`,
      });
      scheduler.advance(16_000);
    }

    expect(await pending).toBe('ok');
    expect(attempts).toBe(5);
    expect(Date.now() - realStart).toBeLessThan(2_000);
  });

  test('an explicit sleep still wins over a scheduler', async () => {
    // The documented precedence: `sleep` is the lower-level door.
    const scheduler = new ManualScheduler();
    const slept: number[] = [];
    let attempts = 0;

    await retry(async () => {
      attempts++;
      if (attempts < 2) throw new Error('once');
      return 'ok';
    }, {
      attempts: 2,
      delayMs: 5_000,
      scheduler,
      sleep: async (ms) => { slept.push(ms); },
    });

    expect(slept).toEqual([5_000]);
    // Nothing was ever handed to the scheduler.
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('gracefulStop budgets on the system scheduler', () => {
  /**
   * Refuses to finish stopping until the latch is opened.
   *
   * A latch with a *flag*, not a stored resolver, and that distinction is the
   * lesson of #1422 applied to a fixture.  The budget expiring escalates to a
   * `terminate`, which runs `postStop` again — so a fixture that remembers one
   * resolver has whichever registration happened last, and releasing before
   * that second one registers leaves it waiting forever.  The system then
   * spends its whole drain budget in `shutdown()` and the test times out in
   * teardown while its assertions all passed.  A flag a later waiter can read
   * has no such order to get wrong.
   */
  class Stubborn extends Actor<string> {
    static released = false;
    static waiters: Array<() => void> = [];
    static open(): void {
      Stubborn.released = true;
      for (const waiter of Stubborn.waiters) waiter();
      Stubborn.waiters = [];
    }
    override onReceive(): void { /* nothing */ }
    override async postStop(): Promise<void> {
      if (Stubborn.released) return;
      await new Promise<void>((resolve) => { Stubborn.waiters.push(resolve); });
    }
  }

  test('a thirty-second budget expires in no real time', async () => {
    Stubborn.released = false;
    Stubborn.waiters = [];
    const { kit, scheduler } = TestKit.withManualScheduler('graceful-virtual');
    try {
      const stubborn = kit.system.spawn(Stubborn, 'stubborn');
      const pending = gracefulStop(stubborn, 30_000);
      const realStart = Date.now();

      scheduler.advance(30_000);

      expect(await pending).toBe(false);
      expect(Date.now() - realStart).toBeLessThan(2_000);
    } finally {
      Stubborn.open();
      await kit.shutdown();
    }
  });
});
