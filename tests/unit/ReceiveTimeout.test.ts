import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem, ActorSystemOptions } from '../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';
import { ReceiveTimeout } from '../../src/SystemMessages.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSystem = (name = 'rt-unit'): ActorSystem =>
  ActorSystem.create(name, ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));

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
    sys.spawn(Props.create(() => new A()), 'a');
    await sleep(150);
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
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    // Keep nudging the actor every 20ms — timeout (50ms) should not elapse.
    for (let i = 0; i < 6; i++) {
      ref.tell('ping');
      await sleep(20);
    }
    expect(fired).toBe(0);
    // Now leave it alone long enough for timeout to elapse.
    await sleep(80);
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
    sys.spawn(Props.create(() => new A()), 'a');
    await sleep(100);
    expect(fired).toBe(0);
    await sys.terminate();
  });
});
