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
    await sleep(100);
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
    await sleep(100);
    expect(seen).toEqual(['new']);
    await sys.terminate();
  });

  test('cancel() prevents delivery', async () => {
    const seen: string[] = [];
    class T extends Actor<string | 'cancel'> {
      override preStart(): void {
        this.context.timers.startSingleTimer('x', 'boom', 40);
      }
      override onReceive(m: string | 'cancel'): void {
        if (m === 'cancel') {
          expect(this.context.timers.cancel('x')).toBe(true);
          return;
        }
        seen.push(m);
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'a');
    ref.tell('cancel');
    await sleep(100);
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
    await sleep(30);
    expect(result).toBe(false);
    await sys.terminate();
  });
});

describe('context.timers.startTimerWithFixedDelay', () => {
  test('fires repeatedly until cancelled', async () => {
    let count = 0;
    class T extends Actor<'tick' | 'cancel'> {
      override preStart(): void {
        this.context.timers.startTimerWithFixedDelay('hb', 'tick', 20, 0);
      }
      override onReceive(m: 'tick' | 'cancel'): void {
        if (m === 'tick') count++;
        else if (m === 'cancel') this.context.timers.cancel('hb');
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'a');
    await sleep(110);
    const snapshot = count;
    ref.tell('cancel');
    await sleep(80);
    expect(snapshot).toBeGreaterThanOrEqual(3);
    expect(count - snapshot).toBeLessThanOrEqual(2); // graceful fade after cancel
    await sys.terminate();
  });
});

describe('context.timers lifecycle integration', () => {
  test('timers are cancelled automatically when the actor stops', async () => {
    let ticks = 0;
    class T extends Actor<'tick' | 'stop'> {
      override preStart(): void {
        this.context.timers.startTimerWithFixedDelay('t', 'tick', 20, 0);
      }
      override onReceive(m: 'tick' | 'stop'): void {
        if (m === 'tick') ticks++;
        else if (m === 'stop') this.self.stop();
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'a');
    await sleep(80);
    ref.tell('stop');
    await sleep(30);
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
    await sleep(30);
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

    class T extends Actor<'tick' | 'check'> {
      override preStart(): void {
        this.context.timers.startSingleTimer('once', 'tick', 10);
        activeBefore = this.context.timers.isTimerActive('once');
      }
      override onReceive(m: 'tick' | 'check'): void {
        if (m === 'check') {
          activeAfter = this.context.timers.isTimerActive('once');
          keysAfter = [...this.context.timers.activeKeys()];
        }
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'fired');
    await sleep(60);
    ref.tell('check');
    await sleep(30);

    expect(activeBefore).toBe(true);
    expect(activeAfter).toBe(false);
    expect(keysAfter).toEqual([]);
    await sys.terminate();
  });

  test('cancelling a fired timer reports that there was nothing to cancel', async () => {
    let cancelledPending: boolean | null = null;
    let cancelledFired: boolean | null = null;

    class T extends Actor<'tick' | 'check'> {
      override preStart(): void {
        this.context.timers.startSingleTimer('gone', 'tick', 10);
        this.context.timers.startSingleTimer('waiting', 'tick', 10_000);
      }
      override onReceive(m: 'tick' | 'check'): void {
        if (m === 'check') {
          cancelledPending = this.context.timers.cancel('waiting');
          cancelledFired = this.context.timers.cancel('gone');
        }
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'cancel-fired');
    await sleep(60);
    ref.tell('check');
    await sleep(30);

    expect(cancelledPending).toBe(true);
    expect(cancelledFired).toBe(false);
    await sys.terminate();
  });

  test('cycling through timer keys does not grow the map', async () => {
    // The leak: an actor that starts a fresh single timer per message kept
    // one dead entry per key, forever.
    let keyCount = -1;

    class T extends Actor<'work' | 'check'> {
      private nextIndex = 0;
      override onReceive(m: 'work' | 'check'): void {
        if (m === 'work') this.context.timers.startSingleTimer(`k${this.nextIndex++}`, 'work', 5);
        else keyCount = this.context.timers.activeKeys().length;
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(T, 'churn');
    for (let i = 0; i < 25; i++) ref.tell('work');

    // Poll rather than sleep.  The 80 ms this used to wait encodes an idle
    // machine: the cell dequeues one user message per event-loop turn, so
    // arming 25 timers already costs 25 turns before the first 5 ms delay
    // starts running down.  Under CI load that budget is not enough, and the
    // assertion then reads a map the invariant has not reached yet rather
    // than one it violated — 22 live keys on the run that caught this.  The
    // timeout is a failure budget; a healthy run returns on the first poll.
    await awaitCondition(
      async () => {
        keyCount = -1;
        ref.tell('check');
        await sleep(5);
        return keyCount === 0;
      },
      { timeoutMs: 4_000, intervalMs: 20, label: 'timer handles drain to zero' },
    );

    expect(keyCount).toBe(0);
    await sys.terminate();
  });
});
