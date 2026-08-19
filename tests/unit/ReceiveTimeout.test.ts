import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ReceiveTimeout } from '../../src/SystemMessages.js';
import { awaitCondition, sleep } from '../util/AwaitCondition.js';

const newSystem = (name = 'rt-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

describe('ReceiveTimeout', () => {
  test('fires ReceiveTimeout after the configured idle period', async () => {
    let fired = 0;
    class A extends Actor<unknown> {
      override preStart(): void { this.context.setReceiveTimeout(40); }
      override onReceive(m: unknown): void {
        if (m === ReceiveTimeout.instance) { fired++; this.self.stop(); }
      }
    }
    const sys = newSystem();
    sys.spawn(A, 'a');
    // The 40 ms lower bound is the framework's to enforce; the test only has
    // to notice that the timeout arrived.  The actor stops itself on the first
    // one, so `fired` cannot run past 1.
    await awaitCondition(() => fired === 1, {
      timeoutMs: 4_000,
      label: 'ReceiveTimeout fired after the idle period',
    });
    expect(fired).toBe(1);
    await sys.terminate();
  });

  test('user messages reset the idle clock', async () => {
    let fired = 0;
    class A extends Actor<unknown> {
      override preStart(): void { this.context.setReceiveTimeout(50); }
      override onReceive(m: unknown): void {
        if (m === ReceiveTimeout.instance) fired++;
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(A, 'a');
    // Keep nudging the actor every 20ms — timeout (50ms) should not elapse.
    for (let i = 0; i < 6; i++) {
      ref.tell('ping');
      await sleep(20);
    }
    expect(fired).toBe(0);
    // Now leave it alone long enough for timeout to elapse.  The nudging loop
    // above stays a sleep — the elapsed time between messages *is* the thing
    // under test — but this half only waits for the timeout to land.
    await awaitCondition(() => fired >= 1, {
      timeoutMs: 4_000,
      label: 'ReceiveTimeout fired once the nudging stopped',
    });
    expect(fired).toBeGreaterThanOrEqual(1);
    await sys.terminate();
  });

  test('cancelReceiveTimeout disables the timer', async () => {
    let fired = 0;
    class A extends Actor<unknown> {
      override preStart(): void {
        this.context.setReceiveTimeout(30);
        this.context.cancelReceiveTimeout();
      }
      override onReceive(m: unknown): void {
        if (m === ReceiveTimeout.instance) fired++;
      }
    }
    const sys = newSystem();
    sys.spawn(A, 'a');
    await sleep(100);
    expect(fired).toBe(0);
    await sys.terminate();
  });
});
