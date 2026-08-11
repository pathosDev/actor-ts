import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const newSystem = (name = 'pp-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

describe('PoisonPill', () => {
  test('stops the actor after processing previously-enqueued messages', async () => {
    const trace: string[] = [];
    class A extends Actor<string> {
      override onReceive(m: string): void { trace.push(`recv:${m}`); }
      override postStop(): void { trace.push('stopped'); }
    }
    const sys = newSystem();
    const ref = sys.spawn(A, 'a');
    ref.tell('a'); ref.tell('b');
    ref.stop();          // PoisonPill
    ref.tell('c');       // should not be delivered
    // `stopped` is the terminal event, so waiting on it also covers both
    // handlers; `recv:c` never arriving is what the assertion then pins.
    await awaitCondition(() => trace.includes('stopped'), {
      timeoutMs: 4_000,
      label: 'the actor stopped after draining its mailbox',
    });
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
    const ref = sys.spawn(A, 'a');
    ref.stop();
    await awaitCondition(() => stopped, {
      timeoutMs: 4_000,
      label: 'postStop ran for an actor with an empty mailbox',
    });
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
    const ref = sys.spawn(A, 'a');
    // Kill has to land on a started actor for the restart to be the thing
    // observed, so the precondition is `starts`, not 20 ms.
    await awaitCondition(() => starts >= 1, {
      timeoutMs: 4_000,
      label: 'the actor started',
    });
    ref.kill();
    await awaitCondition(() => starts >= 2, {
      timeoutMs: 4_000,
      label: 'supervision restarted the killed actor',
    });
    expect(starts).toBeGreaterThanOrEqual(2);
    await sys.terminate();
  });
});
