import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function newSystem(name = 'actor-unit'): ActorSystem {
  return ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });
}

describe('Actor lifecycle', () => {
  test('preStart runs before the first message', async () => {
    const events: string[] = [];
    class A extends Actor<string> {
      override preStart(): void { events.push('preStart'); }
      override onReceive(m: string): void { events.push(`recv:${m}`); }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    ref.tell('one');
    await sleep(30);
    expect(events).toEqual(['preStart', 'recv:one']);
    await sys.terminate();
  });

  test('postStop runs after the last message when stopped via PoisonPill', async () => {
    const events: string[] = [];
    class A extends Actor<string> {
      override onReceive(m: string): void { events.push(`recv:${m}`); }
      override postStop(): void { events.push('postStop'); }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    ref.tell('one');
    ref.tell('two');
    ref.stop();
    await sleep(30);
    expect(events).toEqual(['recv:one', 'recv:two', 'postStop']);
    await sys.terminate();
  });

  test('preRestart runs postStop on the outgoing instance and the supervisor restarts', async () => {
    const events: string[] = [];
    class Parent extends Actor<'fail'> {
      override preStart(): void { events.push('parent:preStart'); }
      override postStop(): void { events.push('parent:postStop'); }
      override preRestart(r: Error): void {
        events.push(`parent:preRestart:${r.message}`);
        super.preRestart(r); // default: call postStop()
      }
      override onReceive(_: 'fail'): void { throw new Error('boom'); }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new Parent()), 'p');
    ref.tell('fail');
    await sleep(60);
    expect(events).toContain('parent:preRestart:boom');
    expect(events).toContain('parent:postStop');
    // A new instance must have started after the restart.
    expect(events.filter(e => e === 'parent:preStart').length).toBeGreaterThanOrEqual(2);
    await sys.terminate();
  });

  test('postRestart default calls preStart on the new instance', async () => {
    const events: string[] = [];
    let instanceId = 0;
    class A extends Actor<'fail'> {
      id = ++instanceId;
      override preStart(): void { events.push(`start:${this.id}`); }
      override postRestart(reason: Error): void {
        events.push(`postRestart:${this.id}:${reason.message}`);
        super.postRestart(reason); // default: call preStart
      }
      override onReceive(_: 'fail'): void { throw new Error('x'); }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    await sleep(20);
    ref.tell('fail');
    await sleep(60);
    // First instance starts, then fails, then a new instance (id=2) enters postRestart
    // and the default implementation calls preStart again.
    const startCalls = events.filter(e => e.startsWith('start:'));
    expect(startCalls.length).toBeGreaterThanOrEqual(2);
    expect(events.find(e => e.startsWith('postRestart:'))).toBeDefined();
    await sys.terminate();
  });

  test('supervisorStrategy() default resolves to defaultStrategy', () => {
    class A extends Actor<string> { override onReceive(_: string): void {} }
    const a = new A();
    expect(a.supervisorStrategy().decider(new Error())).toBe('restart');
  });

  test('self/sender/system/log accessors are bound after attach', async () => {
    let capturedSelf: unknown;
    let capturedSystem: unknown;
    let capturedLog: unknown;
    class A extends Actor<string> {
      override onReceive(_: string): void {
        capturedSelf = this['self' as keyof this];
        capturedSystem = this['system' as keyof this];
        capturedLog = this['log' as keyof this];
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    ref.tell('hi');
    await sleep(30);
    expect(capturedSelf).toBeDefined();
    expect(capturedSystem).toBe(sys);
    expect(capturedLog).toBeDefined();
    await sys.terminate();
  });

  test('onReceive may return a Promise — the cell awaits before the next message', async () => {
    const events: string[] = [];
    class A extends Actor<number> {
      override async onReceive(n: number): Promise<void> {
        events.push(`start:${n}`);
        await sleep(10);
        events.push(`end:${n}`);
      }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new A()), 'a');
    ref.tell(1); ref.tell(2); ref.tell(3);
    await sleep(100);
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
    await sys.terminate();
  });
});
