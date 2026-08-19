import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSystem = (name = 'timers-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

describe('context.timers.startSingleTimer', () => {
  test('delivers the message once after the delay', async () => {
    const seen: string[] = [];
    class T extends Actor<string> {
      override preStart(): void {
        this.context.timers.startSingleTimer('one', 'tick', 30);
      }
      override onReceive(m: string): void { seen.push(m); }
    }
    const sys = newSystem();
    sys.spawn(T, 'a');
    // The 30 ms lower bound is the scheduler's to honour; the test waits for
    // the delivery and then settles briefly, because "once" is half the claim
    // and polling alone returns on the first tick.
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the one-shot timer delivered its message',
    });
    await sleep(30);
    expect(seen).toEqual(['tick']);
    await sys.terminate();
  });

  test('starting with an existing key replaces the previous timer', async () => {
    const seen: string[] = [];
    class T extends Actor<string> {
      override preStart(): void {
        this.context.timers.startSingleTimer('k', 'old', 40);
        this.context.timers.startSingleTimer('k', 'new', 40);
      }
      override onReceive(m: string): void { seen.push(m); }
    }
    const sys = newSystem();
    sys.spawn(T, 'a');
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the replacing timer delivered its message',
    });
    // The replaced timer would arrive on the same 40 ms schedule, so the
    // settle is what proves it was really dropped.
    await sleep(40);
    expect(seen).toEqual(['new']);
    await sys.terminate();
  });

  test('cancel() prevents delivery', async () => {
    const seen: string[] = [];
    const cancelled = { value: false };
    class T extends Actor<string | 'cancel'> {
      override preStart(): void {
        this.context.timers.startSingleTimer('x', 'boom', 40);
      }
      override onReceive(m: string | 'cancel'): void {
        if (m === 'cancel') {
          expect(this.context.timers.cancel('x')).toBe(true);
          cancelled.value = true;
          return;
        }
        seen.push(m);
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'a');
    ref.tell('cancel');
    // The cancel has to have been *handled* before the window is meaningful —
    // the old 100 ms covered both steps at once and would have passed even if
    // the message had never been dequeued.  The window itself stays a sleep:
    // outliving the 40 ms delay is exactly what is being observed.
    await awaitCondition(() => cancelled.value, {
      timeoutMs: 4_000,
      label: 'the cancel message was handled',
    });
    await sleep(80);
    expect(seen).toEqual([]);
    await sys.terminate();
  });

  test('cancel() returns false for unknown keys', async () => {
    let result: boolean | null = null;
    class T extends Actor<'go'> {
      override onReceive(_: 'go'): void {
        result = this.context.timers.cancel('does-not-exist');
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'a');
    ref.tell('go');
    await awaitCondition(() => result !== null, {
      timeoutMs: 4_000,
      label: 'the actor reported the cancel result',
    });
    // Written only inside `onReceive`, so flow analysis still has `result` at
    // its `null` initialiser here; the `awaitCondition` above is the proof.
    expect<boolean | null>(result).toBe(false);
    await sys.terminate();
  });
});

describe('context.timers.startTimerWithFixedDelay', () => {
  test('fires repeatedly until cancelled', async () => {
    let count = 0;
    const cancelled = { value: false };
    class T extends Actor<'tick' | 'cancel'> {
      override preStart(): void {
        this.context.timers.startTimerWithFixedDelay('hb', 'tick', 20, 0);
      }
      override onReceive(m: 'tick' | 'cancel'): void {
        if (m === 'tick') count++;
        else if (m === 'cancel') { this.context.timers.cancel('hb'); cancelled.value = true; }
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'a');
    // Three ticks, however long they take — the 110 ms this used to wait is
    // 5.5 intervals on an idle machine and barely 3 on a loaded one.
    await awaitCondition(() => count >= 3, {
      timeoutMs: 4_000,
      label: 'the fixed-delay timer ticked at least three times',
    });
    const snapshot = count;
    ref.tell('cancel');
    // The fade budget is counted from when the cancel was *handled*, not from
    // when it was sent: anything else measures mailbox latency instead.
    await awaitCondition(() => cancelled.value, {
      timeoutMs: 4_000,
      label: 'the cancel message was handled',
    });
    await sleep(60);
    expect(snapshot).toBeGreaterThanOrEqual(3);
    expect(count - snapshot).toBeLessThanOrEqual(2); // graceful fade after cancel
    await sys.terminate();
  });
});

describe('context.timers lifecycle integration', () => {
  test('timers are cancelled automatically when the actor stops', async () => {
    let ticks = 0;
    const stopped = { value: false };
    class T extends Actor<'tick' | 'stop'> {
      override preStart(): void {
        this.context.timers.startTimerWithFixedDelay('t', 'tick', 20, 0);
      }
      override onReceive(m: 'tick' | 'stop'): void {
        if (m === 'tick') ticks++;
        else if (m === 'stop') this.self.stop();
      }
      override postStop(): void { stopped.value = true; }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'a');
    await awaitCondition(() => ticks >= 2, {
      timeoutMs: 4_000,
      label: 'the timer ticked before the stop',
    });
    ref.tell('stop');
    await awaitCondition(() => stopped.value, {
      timeoutMs: 4_000,
      label: 'the actor stopped',
    });
    const snapshot = ticks;
    await sleep(80); // no timers should fire after stop
    expect(ticks).toBe(snapshot);
    await sys.terminate();
  });

  test('activeKeys / isTimerActive reflect currently-scheduled timers', async () => {
    let beforeCancel: string[] = [], afterCancel: string[] = [], active: boolean[] = [];
    class T extends Actor<'report' | 'cancel'> {
      override preStart(): void {
        this.context.timers.startSingleTimer('a', 'x' as never, 10_000);
        this.context.timers.startTimerWithFixedDelay('b', 'y' as never, 10_000);
      }
      override onReceive(m: 'report' | 'cancel'): void {
        if (m === 'report') {
          beforeCancel = [...this.context.timers.activeKeys()].sort();
          active = [this.context.timers.isTimerActive('a'), this.context.timers.isTimerActive('b')];
        } else if (m === 'cancel') {
          this.context.timers.cancel('a');
          afterCancel = [...this.context.timers.activeKeys()].sort();
        }
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'a');
    ref.tell('report');
    ref.tell('cancel');
    // `afterCancel` is written by the second message, so it is the end of the
    // sequence — and it starts empty, which makes the length a real signal.
    await awaitCondition(() => afterCancel.length > 0, {
      timeoutMs: 4_000,
      label: 'both the report and the cancel were handled',
    });
    expect(beforeCancel).toEqual(['a', 'b']);
    expect(active).toEqual([true, true]);
    expect(afterCancel).toEqual(['b']);
    await sys.terminate();
  });
});

// #642 — a fired one-shot left its entry in the cell's timer map forever, so
// every question the map answers was wrong once a timer had run: it listed
// dead keys as active, claimed to cancel schedules that were already over,
// and grew for the life of an actor that cycles through keys.
describe('timer bookkeeping after a one-shot fires', () => {
  test('a fired key is no longer active', async () => {
    let activeBefore = false;
    let activeAfter = true;
    let keysAfter: string[] = ['unset'];
    const fired = { value: false };
    const checked = { value: false };

    class T extends Actor<'tick' | 'check'> {
      override preStart(): void {
        this.context.timers.startSingleTimer('once', 'tick', 10);
        activeBefore = this.context.timers.isTimerActive('once');
      }
      override onReceive(m: 'tick' | 'check'): void {
        if (m === 'tick') { fired.value = true; return; }
        activeAfter = this.context.timers.isTimerActive('once');
        keysAfter = [...this.context.timers.activeKeys()];
        checked.value = true;
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'fired');
    // `check` must be handled *after* the one-shot fired, which the actor now
    // records; the old 60 ms was a guess at when that would be, and `check`
    // overtaking the tick would have made the assertions read the pre-fire
    // state.  A separate `checked` flag rather than `keysAfter` being empty, so
    // that the leak this test guards fails as a diff rather than as a timeout.
    await awaitCondition(() => fired.value, {
      timeoutMs: 4_000,
      label: 'the one-shot timer fired',
    });
    ref.tell('check');
    await awaitCondition(() => checked.value, {
      timeoutMs: 4_000,
      label: 'the actor reported its timer state',
    });

    expect(activeBefore).toBe(true);
    expect(activeAfter).toBe(false);
    expect(keysAfter).toEqual([]);
    await sys.terminate();
  });

  test('cancelling a fired timer reports that there was nothing to cancel', async () => {
    let cancelledPending: boolean | null = null;
    let cancelledFired: boolean | null = null;
    const fired = { value: false };

    class T extends Actor<'tick' | 'check'> {
      override preStart(): void {
        this.context.timers.startSingleTimer('gone', 'tick', 10);
        this.context.timers.startSingleTimer('waiting', 'tick', 10_000);
      }
      override onReceive(m: 'tick' | 'check'): void {
        if (m === 'tick') { fired.value = true; return; }
        cancelledPending = this.context.timers.cancel('waiting');
        cancelledFired = this.context.timers.cancel('gone');
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'cancel-fired');
    // Same shape as above: `gone` has to have fired before the cancel is asked
    // about it, otherwise the answer would legitimately be `true`.
    await awaitCondition(() => fired.value, {
      timeoutMs: 4_000,
      label: 'the short one-shot fired',
    });
    ref.tell('check');
    await awaitCondition(() => cancelledFired !== null, {
      timeoutMs: 4_000,
      label: 'the actor reported both cancel results',
    });

    // Same nested-writer situation as above.
    expect<boolean | null>(cancelledPending).toBe(true);
    expect<boolean | null>(cancelledFired).toBe(false);
    await sys.terminate();
  });

  test('cycling through timer keys does not grow the map', async () => {
    // The leak: a fired one-shot left its entry behind — nothing calls back
    // into the handle map when a timer runs — so an actor that starts a fresh
    // single timer per message accumulated one dead entry per key for its
    // whole life.  `activeKeys()` prunes settled handles on read.
    //
    // The timer message deliberately does *not* arm another timer.  An earlier
    // version of this test had it do exactly that, which made the population
    // self-perpetuating: 25 timers in flight forever, each fired message
    // arming its successor.  `activeKeys()` then reads 0 only when the actor
    // happens to be running *behind* its own timers — all 25 settled and none
    // of their messages handled yet — which is a property of the scheduler,
    // not of the map.  It held under a dispatcher costing a macrotask per turn
    // and stopped holding the moment turns got cheaper, reporting a leak where
    // there was none: the count sat at exactly 25, the live timers, correctly
    // retained.  Letting the timers settle for good tests the invariant
    // itself, and tests it identically under any scheduler.
    let keyCount = -1;

    class T extends Actor<'tick' | 'work' | 'check'> {
      private nextIndex = 0;
      override onReceive(m: 'tick' | 'work' | 'check'): void {
        if (m === 'work') this.context.timers.startSingleTimer(`k${this.nextIndex++}`, 'tick', 5);
        else if (m === 'check') keyCount = this.context.timers.activeKeys().length;
        // 'tick' is the timer firing, and it is meant to do nothing at all.
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'churn');

    // Three waves over 75 distinct keys.  One wave would catch a total failure
    // to prune; the waves catch the defect as it actually behaved, which was
    // cumulative — with entries retained the count reads 25, then 50, then 75
    // instead of returning to zero each time.
    for (let wave = 0; wave < 3; wave++) {
      for (let i = 0; i < 25; i++) ref.tell('work');
      await awaitCondition(
        async () => {
          keyCount = -1;
          ref.tell('check');
          await sleep(5);
          return keyCount === 0;
        },
        { timeoutMs: 4_000, intervalMs: 20, label: `wave ${wave + 1} drains to zero` },
      );
      expect(keyCount).toBe(0);
    }
    await sys.terminate();
  });
});
