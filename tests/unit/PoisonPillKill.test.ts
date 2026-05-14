import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSystem = (name = 'pp-unit'): ActorSystem =>
  ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });

describe('PoisonPill', () => {
  test('stops the actor after processing previously-enqueued messages', async () => {
    const trace: string[] = [];
    class A extends Actor<string> {
      override onReceive(m: string): void { trace.push(`recv:${m}`); }
      override postStop(): void { trace.push('stopped'); }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    ref.tell('a'); ref.tell('b');
    ref.stop();          // PoisonPill
    ref.tell('c');       // should not be delivered
    await sleep(50);
    expect(trace).toEqual(['recv:a', 'recv:b', 'stopped']);
    await sys.terminate();
  });

  test('stop on an actor with no pending messages still triggers postStop', async () => {
    let stopped = false;
    class A extends Actor<string> {
      override onReceive(_: string): void {}
      override postStop(): void { stopped = true; }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    ref.stop();
    await sleep(30);
    expect(stopped).toBe(true);
    await sys.terminate();
  });
});

describe('Kill', () => {
  test('Kill causes a supervised failure — default supervision restarts', async () => {
    let starts = 0;
    class A extends Actor<string> {
      override preStart(): void { starts++; }
      override onReceive(_: string): void {}
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    await sleep(20);
    ref.kill();
    await sleep(60);
    expect(starts).toBeGreaterThanOrEqual(2);
    await sys.terminate();
  });
});
