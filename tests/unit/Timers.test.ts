import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSystem = (name = 'timers-unit'): ActorSystem =>
  ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });

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
    sys.actorOf(Props.create(() => new T()), 'a');
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
    sys.actorOf(Props.create(() => new T()), 'a');
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
    const ref = sys.actorOf(Props.create(() => new T()), 'a');
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
    const ref = sys.actorOf(Props.create(() => new T()), 'a');
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
    const ref = sys.actorOf(Props.create(() => new T()), 'a');
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
    const ref = sys.actorOf(Props.create(() => new T()), 'a');
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
    const ref = sys.actorOf(Props.create(() => new T()), 'a');
    ref.tell('report');
    ref.tell('cancel');
    await sleep(30);
    expect(beforeCancel).toEqual(['a', 'b']);
    expect(active).toEqual([true, true]);
    expect(afterCancel).toEqual(['b']);
    await sys.terminate();
  });
});
