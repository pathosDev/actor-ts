import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';
import { Behaviors } from '../../src/typed/Behaviors.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function newSystem(name = 'actor-unit'): ActorSystem {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
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
    const actorRef = new A();
    expect(actorRef.supervisorStrategy().decider(new Error())).toBe('restart');
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

/**
 * The counterpart to the `askResp-` naming tests in Ask.test.ts — same concern
 * (a framework-generated name that used to be a bare counter), same technique.
 */
describe('anonymous child names', () => {
  const ANONYMOUS = /^\$anonymous-\d+-[0-9a-f]{12}$/;

  class Idle extends Actor<string> {
    override onReceive(_: string): void {}
  }
  const idleProps = (): Props<string> => Props.create(() => new Idle());

  test('every entry point that omits a name produces the same shape', async () => {
    const sys = newSystem();
    const behavior = Behaviors.receiveMessage<string>(() => Behaviors.same);

    const names: string[] = [
      sys.spawnAnonymous(idleProps()).path.name,
      sys.spawnTypedAnonymous(behavior).path.name,
    ];

    // The two context-level forms, plus the fallback in TypedActorContext.spawn
    // when the optional `name` is omitted — the one nobody thinks to cover.
    class Parent extends Actor<string> {
      override preStart(): void {
        names.push(this.context.spawnAnonymous(idleProps()).path.name);
        names.push(this.context.spawnTypedAnonymous(behavior).path.name);
      }
      override onReceive(_: string): void {}
    }
    sys.spawn(Props.create(() => new Parent()), 'shapes-parent');

    const viaTypedContext = await new Promise<string>((resolve) => {
      sys.spawnTyped(
        Behaviors.setup<string>((context) => {
          resolve(context.spawn(behavior).path.name);
          return Behaviors.receiveMessage(() => Behaviors.same);
        }),
        'typed-shapes-parent',
      );
    });
    names.push(viaTypedContext);

    await sleep(40);
    expect(names).toHaveLength(5);
    for (const name of names) expect(name).toMatch(ANONYMOUS);
    await sys.terminate();
  });

  test('names do not repeat and do not run in sequence', async () => {
    const sys = newSystem();
    const names: string[] = [];
    class Parent extends Actor<string> {
      override preStart(): void {
        for (let i = 0; i < 200; i++) names.push(this.context.spawnAnonymous(idleProps()).path.name);
      }
      override onReceive(_: string): void {}
    }
    sys.spawn(Props.create(() => new Parent()), 'volume-parent');
    await sleep(60);

    expect(names).toHaveLength(200);
    expect(new Set(names).size).toBe(200);

    // The counter half is consecutive by design; the random half must not be.
    // Deliberately not "no suffix is all digits" — hex digits include 0-9, so a
    // legitimate suffix is all-digits about once in 139 draws, which over 200
    // samples would fail almost every run.
    const suffixes = names.map((name) => parseInt(name.slice(name.lastIndexOf('-') + 1), 16));
    const consecutive = suffixes.every((value, index) => index === 0 || value === suffixes[index - 1]! + 1);
    expect(consecutive).toBe(false);
    await sys.terminate();
  });

  test('two parents produce disjoint names even though both counters start at 1', async () => {
    // The property the random half actually buys: under the old scheme both
    // parents handed out `$1`, `$2`, … and only the full path told them apart.
    const sys = newSystem();
    const byParent = new Map<string, string[]>();
    class Parent extends Actor<string> {
      constructor(private readonly label: string) { super(); }
      override preStart(): void {
        const names: string[] = [];
        for (let i = 0; i < 20; i++) names.push(this.context.spawnAnonymous(idleProps()).path.name);
        byParent.set(this.label, names);
      }
      override onReceive(_: string): void {}
    }
    sys.spawn(Props.create(() => new Parent('left')), 'left');
    sys.spawn(Props.create(() => new Parent('right')), 'right');
    await sleep(60);

    const left = byParent.get('left')!;
    const right = byParent.get('right')!;
    expect(left).toHaveLength(20);
    expect(right).toHaveLength(20);
    // Counter halves collide across parents; whole names must not.
    expect(left.map((n) => n.split('-')[1])).toEqual(right.map((n) => n.split('-')[1]));
    expect(left.filter((name) => right.includes(name))).toEqual([]);
    await sys.terminate();
  });

  test('a restart re-spawns an anonymous child without a name collision', async () => {
    // `preRestart`'s default only calls `postStop()` — children are NOT stopped —
    // so `preStart` runs again while the previous incarnation's anonymous child
    // is still in the parent's child map.  The old per-parent counter made that
    // safe by construction; this pins that the new scheme is too.
    const names: string[] = [];
    class Parent extends Actor<string> {
      override preStart(): void {
        names.push(this.context.spawnAnonymous(idleProps()).path.name);
      }
      override onReceive(m: string): void { if (m === 'boom') throw new Error('boom'); }
    }
    const sys = newSystem();
    const ref = sys.spawn(Props.create(() => new Parent()), 'restarting-parent');
    ref.tell('boom');
    await sleep(80);

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).toMatch(ANONYMOUS);
    await sys.terminate();
  });
});
