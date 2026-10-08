import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorPath } from '../../src/ActorPath.js';
import { ActorRef, AskResponseRef } from '../../src/ActorRef.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Scheduler, type Cancellable, type HostTimers } from '../../src/Scheduler.js';
import { AskTimeoutError } from '../../src/SystemMessages.js';
import { ManualScheduler } from '../../src/testkit/ManualScheduler.js';
import { MAX_TIMER_DELAY_MS } from '../../src/util/Constants.js';
import { assertDoesNotCompleteWithin } from '../util/AsyncAssertions.js';
import { awaitCondition } from '../util/AwaitCondition.js';

/**
 * A delay past the host timer ceiling waits the whole delay.
 *
 * `setTimeout` and `setInterval` cannot hold a delay above
 * {@link MAX_TIMER_DELAY_MS} (~24.9 days): Bun and Node arm one as 1 ms, Deno
 * wraps it modulo 2^32.  The scheduler handed its delays straight through, so
 * on bun 1.4.2 a one-shot of 2^31 ms fired after about 17 ms, a 30-day one
 * after about 1 ms, and a fixed-rate schedule with a 2^31 ms interval turned
 * into a ~1 ms loop — about 150 ticks in 250 ms — for the life of the
 * schedule.  Every actor timer is armed here, so they all inherited it.
 *
 * Waiting 24.9 days to watch a link elapse is not a test, so most cases hand
 * the scheduler host timers on a virtual clock.  Only the chained path arms
 * through them, and the boundary block below pins exactly that: a delay at the
 * ceiling never reaches the virtual host, because it still takes the one host
 * timer it always took.  The two wall-clock cases exist because the virtual
 * host proves the chain and not the symptom — they are the defect as a user
 * met it, a long timer that fires at once.
 */

const CEILING_PLUS_ONE_MS = MAX_TIMER_DELAY_MS + 1;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

/** One timer the virtual host holds. */
type VirtualTimer = {
  readonly id: number;
  readonly callback: () => void;
  dueAt: number;
  /** `null` for a one-shot, the period for an interval. */
  readonly repeatMs: number | null;
};

/**
 * More firings than any case here needs by two orders of magnitude.  A wrong
 * implementation that re-arms a link as 0 or 1 ms would otherwise loop inside
 * `elapse` for the whole virtual span — synchronously, so bun's per-test cap
 * could never interrupt it.
 */
const RUNAWAY_FIRINGS = 1_000;

/**
 * Host timers on a virtual clock.  Nothing is armed for real: every timer is
 * recorded, and {@link elapse} fires the ones that fall due in deadline order —
 * including a timer armed by one that fired — so 24.9 days pass in one call.
 */
class VirtualHostTimers implements HostTimers {
  private now = 0;
  private nextId = 1;
  private readonly armed = new Map<number, VirtualTimer>();
  /** Every delay handed to `setTimeout`, in arming order. */
  readonly timeoutDelays: number[] = [];
  /** Every period handed to `setInterval`, in arming order. */
  readonly intervalDelays: number[] = [];
  /** Every handle a clear was asked for, in order. */
  readonly cleared: unknown[] = [];

  setTimeout(callback: () => void, delayMs: number): number {
    this.timeoutDelays.push(delayMs);
    return this.arm(callback, delayMs, null);
  }

  clearTimeout(handle: unknown): void { this.clear(handle); }

  setInterval(callback: () => void, intervalMs: number): number {
    this.intervalDelays.push(intervalMs);
    return this.arm(callback, intervalMs, intervalMs);
  }

  clearInterval(handle: unknown): void { this.clear(handle); }

  /** The handles still armed, oldest first. */
  get pendingHandles(): number[] { return [...this.armed.keys()]; }

  elapse(ms: number): void {
    const target = this.now + ms;
    for (let firings = 0; ; firings++) {
      if (firings > RUNAWAY_FIRINGS) {
        throw new Error(`the virtual host fired more than ${RUNAWAY_FIRINGS} timers in one elapse — a runaway re-arm`);
      }
      let next: VirtualTimer | undefined;
      for (const timer of this.armed.values()) {
        if (timer.dueAt <= target && (next === undefined || timer.dueAt < next.dueAt)) next = timer;
      }
      if (next === undefined) break;
      this.now = next.dueAt;
      if (next.repeatMs === null) this.armed.delete(next.id);
      else next.dueAt += Math.max(next.repeatMs, 1);
      next.callback();
    }
    this.now = target;
  }

  private arm(callback: () => void, delayMs: number, repeatMs: number | null): number {
    const id = this.nextId++;
    this.armed.set(id, { id, callback, dueAt: this.now + Math.max(delayMs, 0), repeatMs });
    return id;
  }

  private clear(handle: unknown): void {
    this.cleared.push(handle);
    this.armed.delete(handle as number);
  }
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** One call the runtime's `setTimeout` received while it was recorded. */
type RuntimeTimeout = {
  readonly callback: unknown;
  readonly delayMs: unknown;
  readonly handle: ReturnType<typeof setTimeout>;
};

/**
 * Run `arm` with the runtime's own `setTimeout` recorded, and hand back every
 * call it received.  The calls still reach the real primitive, because the
 * handle it returns is what `cancel()` has to clear — so every case that uses
 * this cancels what it armed.
 */
function recordingRuntimeTimeouts<T>(arm: () => T): { readonly result: T; readonly timeouts: readonly RuntimeTimeout[] } {
  const realSetTimeout = globalThis.setTimeout;
  const timeouts: RuntimeTimeout[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    timeouts.push({ callback: args[0], delayMs: args[1], handle });
    return handle;
  }) as typeof setTimeout;
  try {
    return { result: arm(), timeouts };
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

const delaysOf = (timeouts: readonly RuntimeTimeout[]): unknown[] => timeouts.map((timeout) => timeout.delayMs);

/** Captures `tell` calls into an array for verification. */
class RecordingRef<T = unknown> extends ActorRef<T> {
  readonly path = new ActorPath('recording');
  readonly received: T[] = [];
  tell(message: T): void { this.received.push(message); }
}

describe('a one-shot past the host timer ceiling', () => {
  test('is armed as a chain whose links add up to the delay', () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    let fired = 0;
    const handle = scheduler.scheduleOnceFunction(CEILING_PLUS_ONE_MS, () => { fired++; });
    try {
      expect(host.timeoutDelays).toEqual([MAX_TIMER_DELAY_MS]);

      host.elapse(MAX_TIMER_DELAY_MS);
      // A link elapsing on the way is not the schedule firing, and it does
      // not settle the handle either: the chain is one schedule.
      expect(fired).toBe(0);
      expect(handle.isCancelled).toBe(false);
      expect(host.timeoutDelays).toEqual([MAX_TIMER_DELAY_MS, 1]);

      host.elapse(1);
      expect(fired).toBe(1);
      expect(handle.isCancelled).toBe(true);
      expect(sum(host.timeoutDelays)).toBe(CEILING_PLUS_ONE_MS);
      expect(host.pendingHandles).toEqual([]);
    } finally {
      scheduler.shutdown();
    }
  });

  test('waits the whole of a 30-day delay, not a millisecond less', () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    let fired = 0;
    scheduler.scheduleOnceFunction(THIRTY_DAYS_MS, () => { fired++; });
    try {
      host.elapse(THIRTY_DAYS_MS - 1);
      expect(fired).toBe(0);
      host.elapse(1);
      expect(fired).toBe(1);
      expect(host.timeoutDelays).toEqual([MAX_TIMER_DELAY_MS, THIRTY_DAYS_MS - MAX_TIMER_DELAY_MS]);
    } finally {
      scheduler.shutdown();
    }
  });

  test('delivers a scheduled message only once the whole delay has passed', () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    const target = new RecordingRef<string>();
    scheduler.scheduleOnce(CEILING_PLUS_ONE_MS, target, 'late');
    try {
      host.elapse(MAX_TIMER_DELAY_MS);
      expect(target.received).toEqual([]);
      host.elapse(1);
      expect(target.received).toEqual(['late']);
    } finally {
      scheduler.shutdown();
    }
  });

  test('a delay that never elapses never fires', () => {
    // `Infinity` used to fire after 1 ms like every other overflowing delay.
    // Taken at its word it is a schedule that is only ever cancelled, so the
    // chain keeps re-arming a ceiling-long link and nothing fires.
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    let fired = 0;
    const handle = scheduler.scheduleOnceFunction(Number.POSITIVE_INFINITY, () => { fired++; });
    try {
      host.elapse(MAX_TIMER_DELAY_MS * 3);
      expect(fired).toBe(0);
      expect(host.timeoutDelays).toEqual([MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS]);
      expect(handle.cancel()).toBe(true);
      expect(host.pendingHandles).toEqual([]);
    } finally {
      scheduler.shutdown();
    }
  });

  test('has not fired on the wall clock long after the overflow would have fired it', async () => {
    // The symptom itself, on the runtime's own timers: before the chain this
    // settled after ~17 ms on bun.  An absence, so it needs a window, and the
    // window only has to outlast that overflow by a wide margin.
    const scheduler = new Scheduler();
    let markFired: () => void = () => {};
    const fired = new Promise<void>((resolve) => { markFired = resolve; });
    const handle = scheduler.scheduleOnceFunction(CEILING_PLUS_ONE_MS, () => { markFired(); });
    try {
      await assertDoesNotCompleteWithin(fired, 150, 'a one-shot armed for 2^31 ms');
    } finally {
      handle.cancel();
      scheduler.shutdown();
    }
  });
});

describe('a fixed-rate schedule past the host timer ceiling', () => {
  test('ticks at the full interval rather than in a one-millisecond loop', () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    let ticks = 0;
    scheduler.scheduleAtFixedRateFunction(1, CEILING_PLUS_ONE_MS, () => { ticks++; });
    try {
      host.elapse(1);
      expect(ticks).toBe(1);
      host.elapse(CEILING_PLUS_ONE_MS - 1);
      expect(ticks).toBe(1);
      host.elapse(1);
      expect(ticks).toBe(2);
      host.elapse(CEILING_PLUS_ONE_MS);
      expect(ticks).toBe(3);
      // Driven by chained one-shots: an interval this long cannot be handed to
      // `setInterval`, which would coerce it exactly as `setTimeout` does.
      expect(host.intervalDelays).toEqual([]);
      expect(host.timeoutDelays.every((delayMs) => delayMs <= MAX_TIMER_DELAY_MS)).toBe(true);
    } finally {
      scheduler.shutdown();
    }
  });

  test('chains a long initial delay, then runs a short interval on the host interval', () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    let ticks = 0;
    scheduler.scheduleAtFixedRateFunction(CEILING_PLUS_ONE_MS, 10, () => { ticks++; });
    try {
      host.elapse(MAX_TIMER_DELAY_MS);
      expect(ticks).toBe(0);
      host.elapse(1);
      expect(ticks).toBe(1);
      // An interval that fits one host timer keeps the host's own repeat, so
      // the period does not stretch by the task's run time on every tick.
      expect(host.intervalDelays).toEqual([10]);
      host.elapse(20);
      expect(ticks).toBe(3);
    } finally {
      scheduler.shutdown();
    }
  });

  test('a task that cancels itself on its first tick leaves nothing armed (#1567)', () => {
    // The chained path re-arms after the tick exactly where `fixedRate` arms
    // its interval, so it needs the same re-check: a link armed after the task
    // cancelled its own handle is one no `cancel()` or `shutdown()` can reach.
    for (const [initialDelayMs, intervalMs] of [[1, CEILING_PLUS_ONE_MS], [CEILING_PLUS_ONE_MS, 10]] as const) {
      const host = new VirtualHostTimers();
      const scheduler = new Scheduler(host);
      let ticks = 0;
      const cancellable: Cancellable = scheduler.scheduleAtFixedRateFunction(initialDelayMs, intervalMs, () => {
        ticks++;
        cancellable.cancel();
      });
      try {
        host.elapse(initialDelayMs);
        expect(ticks).toBe(1);
        expect(cancellable.isCancelled).toBe(true);
        expect(host.pendingHandles).toEqual([]);
        expect(host.intervalDelays).toEqual([]);
      } finally {
        scheduler.shutdown();
      }
    }
  });

  test('has not looped on the wall clock', async () => {
    // Before the chain this interval became a ~1 ms `setInterval`: about 150
    // ticks in 250 ms.  The first tick is due at 1 ms; nothing after it is due
    // for 24.9 days.
    const scheduler = new Scheduler();
    let ticks = 0;
    let markSecondTick: () => void = () => {};
    const secondTick = new Promise<void>((resolve) => { markSecondTick = resolve; });
    const handle = scheduler.scheduleAtFixedRateFunction(1, CEILING_PLUS_ONE_MS, () => {
      ticks++;
      if (ticks === 2) markSecondTick();
    });
    try {
      await awaitCondition(() => ticks >= 1, { timeoutMs: 4_000, label: 'the first tick fired' });
      await assertDoesNotCompleteWithin(secondTick, 150, 'a second tick of a 2^31 ms interval');
      expect(ticks).toBe(1);
    } finally {
      handle.cancel();
      scheduler.shutdown();
    }
  });
});

describe('cancel and shutdown reach the link that is armed', () => {
  test('cancel() clears the second link once the first has elapsed', () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    let fired = 0;
    const handle = scheduler.scheduleOnceFunction(THIRTY_DAYS_MS, () => { fired++; });
    try {
      host.elapse(MAX_TIMER_DELAY_MS);
      const [secondLink] = host.pendingHandles;
      expect(secondLink).toBeDefined();

      expect(handle.cancel()).toBe(true);
      expect(host.cleared).toEqual([secondLink]);
      expect(host.pendingHandles).toEqual([]);

      host.elapse(THIRTY_DAYS_MS);
      expect(fired).toBe(0);
      expect(handle.cancel()).toBe(false);
    } finally {
      scheduler.shutdown();
    }
  });

  test('cancel() before the first link elapses clears that one', () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    const handle = scheduler.scheduleOnceFunction(CEILING_PLUS_ONE_MS, () => {});
    try {
      const [firstLink] = host.pendingHandles;
      // `toEqual` reads `[undefined]` as `[]`, so without this the clear below
      // would pass over a chain that armed nothing at all.
      expect(firstLink).toBeDefined();
      expect(handle.cancel()).toBe(true);
      expect(host.cleared).toEqual([firstLink]);
      expect(host.pendingHandles).toEqual([]);
    } finally {
      scheduler.shutdown();
    }
  });

  test('shutdown() clears the armed link of every chain', () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    let fired = 0;
    let ticks = 0;
    const once = scheduler.scheduleOnceFunction(THIRTY_DAYS_MS, () => { fired++; });
    const repeating = scheduler.scheduleAtFixedRateFunction(1, CEILING_PLUS_ONE_MS, () => { ticks++; });
    // Midway: the one-shot is on its second link, the fixed-rate schedule has
    // ticked once and is on the first link of its next period.
    host.elapse(MAX_TIMER_DELAY_MS);
    expect(ticks).toBe(1);
    const armedAtShutdown = host.pendingHandles;
    expect(armedAtShutdown).toHaveLength(2);

    scheduler.shutdown();

    expect([...host.cleared].sort()).toEqual([...armedAtShutdown].sort());
    expect(host.pendingHandles).toEqual([]);
    expect(once.isCancelled).toBe(true);
    expect(repeating.isCancelled).toBe(true);
    host.elapse(THIRTY_DAYS_MS * 2);
    expect(fired).toBe(0);
    expect(ticks).toBe(1);
  });
});

describe('at and below the ceiling nothing changes', () => {
  test('a delay at the ceiling arms one runtime timer directly, as it always did', () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    const { result: handle, timeouts } = recordingRuntimeTimeouts(
      () => scheduler.scheduleOnceFunction(MAX_TIMER_DELAY_MS, () => {}),
    );
    try {
      expect(delaysOf(timeouts)).toEqual([MAX_TIMER_DELAY_MS]);
      expect(host.timeoutDelays).toEqual([]);
    } finally {
      handle.cancel();
      scheduler.shutdown();
    }
  });

  test('a fixed-rate schedule at the ceiling arms its first runtime timer directly', () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    const { result: handle, timeouts } = recordingRuntimeTimeouts(
      () => scheduler.scheduleAtFixedRateFunction(MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS, () => {}),
    );
    try {
      expect(delaysOf(timeouts)).toEqual([MAX_TIMER_DELAY_MS]);
      expect(host.timeoutDelays).toEqual([]);
      expect(host.intervalDelays).toEqual([]);
    } finally {
      handle.cancel();
      scheduler.shutdown();
    }
  });

  test('a scheduler built without host timers chains through the runtime timers', () => {
    // The default every system builds.  The first link reaches the runtime at
    // the ceiling, where before the whole overflowing delay did; running that
    // link's callback by hand stands in for 24.9 days, and what it arms next
    // is the remaining millisecond — not the task, which a clamp would run.
    const scheduler = new Scheduler();
    let fired = 0;
    const first = recordingRuntimeTimeouts(
      () => scheduler.scheduleOnceFunction(CEILING_PLUS_ONE_MS, () => { fired++; }),
    );
    const handle = first.result;
    try {
      expect(delaysOf(first.timeouts)).toEqual([MAX_TIMER_DELAY_MS]);
      const [firstLink] = first.timeouts;
      clearTimeout(firstLink!.handle);
      const second = recordingRuntimeTimeouts(() => { (firstLink!.callback as () => void)(); });
      expect(fired).toBe(0);
      expect(delaysOf(second.timeouts)).toEqual([1]);
      expect(handle.isCancelled).toBe(false);
    } finally {
      // Clears the remaining link before it can fire: nothing above yielded.
      handle.cancel();
      scheduler.shutdown();
    }
  });

  test('ManualScheduler stays virtual: a long delay is advanced past, never chained', () => {
    // It overrides every scheduling entry point and never reaches the chain,
    // so a delay past the ceiling is one virtual deadline, as it always was.
    const scheduler = new ManualScheduler();
    let fired = 0;
    scheduler.scheduleOnceFunction(CEILING_PLUS_ONE_MS, () => { fired++; });
    scheduler.advance(MAX_TIMER_DELAY_MS);
    expect(fired).toBe(0);
    scheduler.advance(1);
    expect(fired).toBe(1);
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('everything armed on the scheduler inherits the chain', () => {
  test('an actor timer past the ceiling is delivered after the whole delay', async () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withScheduler(scheduler);
    const system = ActorSystem.create('long-actor-timer', systemOptions);
    const woke: string[] = [];
    class Sleeper extends Actor<string> {
      override preStart(): void {
        this.context.timers.startSingleTimer('wake', 'wake', CEILING_PLUS_ONE_MS);
      }
      override onReceive(message: string): void { woke.push(message); }
    }
    try {
      system.spawn(Sleeper, 'sleeper');
      await awaitCondition(() => host.timeoutDelays.length === 1, {
        timeoutMs: 4_000,
        label: 'the actor armed its timer on the scheduler',
      });
      host.elapse(MAX_TIMER_DELAY_MS);
      // The message is told by the last link and by nothing before it, so the
      // chain still waiting on that link is the proof it has not been sent.
      expect(host.timeoutDelays).toEqual([MAX_TIMER_DELAY_MS, 1]);
      expect(woke).toEqual([]);
      host.elapse(1);
      await awaitCondition(() => woke.length === 1, {
        timeoutMs: 4_000,
        label: 'the actor timer delivered its message',
      });
      expect(woke).toEqual(['wake']);
    } finally {
      await system.terminate();
      // Lent through the options, so the system leaves it running (#1424).
      scheduler.shutdown();
    }
  });

  test('an ask deadline armed on a scheduler waits the whole deadline', async () => {
    const host = new VirtualHostTimers();
    const scheduler = new Scheduler(host);
    const reply = new AskResponseRef<string>('long-ask', 'askResp-longdeadline', CEILING_PLUS_ONE_MS, 'target', scheduler);
    let outcome = 'pending';
    const settled = reply.promise.then(
      () => { outcome = 'replied'; },
      (error: unknown) => { outcome = error instanceof AskTimeoutError ? 'timed out' : 'rejected'; },
    );
    try {
      host.elapse(MAX_TIMER_DELAY_MS);
      expect(host.timeoutDelays).toEqual([MAX_TIMER_DELAY_MS, 1]);
      host.elapse(1);
      await settled;
      expect(outcome).toBe('timed out');
    } finally {
      scheduler.shutdown();
    }
  });
});
