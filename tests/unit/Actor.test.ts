import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorOptions } from '../../src/ActorOptions.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import type { ActorFactory } from '../../src/Actor.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { JsonLogger, LogLevel, NoopLogger } from '../../src/Logger.js';
import { Behaviors, same } from '../../src/typed/Behaviors.js';

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
    const ref = sys.spawn(() => new A(), 'a');
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
    const ref = sys.spawn(() => new A(), 'a');
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
    const ref = sys.spawn(() => new Parent(), 'p');
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
    const ref = sys.spawn(() => new A(), 'a');
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
    const ref = sys.spawn(() => new A(), 'a');
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
    const ref = sys.spawn(() => new A(), 'a');
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
  const idle = (): ActorFactory<string> => () => new Idle();

  test('every entry point that omits a name produces the same shape', async () => {
    const sys = newSystem();
    // `same<string>()` rather than `Behaviors.same`, which is `Behavior<never>`.
    const behavior = Behaviors.receiveMessage<string>(() => same<string>());

    const names: string[] = [
      sys.spawnAnonymous(idle()).path.name,
      sys.spawnTypedAnonymous(behavior).path.name,
    ];

    // The two context-level forms, plus the fallback in TypedActorContext.spawn
    // when the optional `name` is omitted — the one nobody thinks to cover.
    class Parent extends Actor<string> {
      override preStart(): void {
        names.push(this.context.spawnAnonymous(idle()).path.name);
        names.push(this.context.spawnTypedAnonymous(behavior).path.name);
      }
      override onReceive(_: string): void {}
    }
    sys.spawn(() => new Parent(), 'shapes-parent');

    const viaTypedContext = await new Promise<string>((resolve) => {
      sys.spawnTyped(
        Behaviors.setup<string>((context) => {
          resolve(context.spawn(behavior).path.name);
          return Behaviors.receiveMessage(() => same<string>());
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
        for (let i = 0; i < 200; i++) names.push(this.context.spawnAnonymous(idle()).path.name);
      }
      override onReceive(_: string): void {}
    }
    sys.spawn(() => new Parent(), 'volume-parent');
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
        for (let i = 0; i < 20; i++) names.push(this.context.spawnAnonymous(idle()).path.name);
        byParent.set(this.label, names);
      }
      override onReceive(_: string): void {}
    }
    sys.spawn(() => new Parent('left'), 'left');
    sys.spawn(() => new Parent('right'), 'right');
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
        names.push(this.context.spawnAnonymous(idle()).path.name);
      }
      override onReceive(m: string): void { if (m === 'boom') throw new Error('boom'); }
    }
    const sys = newSystem();
    const ref = sys.spawn(() => new Parent(), 'restarting-parent');
    ref.tell('boom');
    await sleep(80);

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).toMatch(ANONYMOUS);
    await sys.terminate();
  });
});

/* ------------------------- displayName (#891) ------------------------- */

type LogRecord = {
  readonly level: string;
  readonly msg: string;
  readonly source?: string;
  readonly displayName?: string;
};

/**
 * A system logging into an array.  `JsonLogger` rather than the console
 * one because it keeps `source` and `displayName` as named fields — the
 * rendered text would have to be parsed back apart to assert on them.
 */
function recordingSystem(name: string): { system: ActorSystem; records: () => LogRecord[] } {
  const lines: string[] = [];
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new JsonLogger(LogLevel.Debug, '', {}, { write: (line) => { lines.push(line); } }));
  return {
    system: ActorSystem.create(name, sysOptions),
    records: () => lines.map((line) => JSON.parse(line) as LogRecord),
  };
}

const said = (records: LogRecord[], msg: string): LogRecord | undefined =>
  records.find((record) => record.msg === msg);

class Talker extends Actor<string> {
  override onReceive(message: string): void { this.log.info(message); }
}

describe('Actor.displayName (#891)', () => {
  test('defaults to the path, which the source already is — so nothing is added', async () => {
    const { system, records } = recordingSystem('display-default');
    const ref = system.spawn(() => new Talker(), 'plain');
    ref.tell('hello');
    await sleep(30);

    const record = said(records(), 'hello')!;
    expect(record.source).toBe(ref.path.toString());
    expect(Object.hasOwn(record, 'displayName')).toBe(false);
    await system.terminate();
  });

  test('an override rides alongside the path, never instead of it', async () => {
    class Named extends Talker {
      override displayName(): string { return 'Order(42)'; }
    }
    const { system, records } = recordingSystem('display-override');
    const ref = system.spawn(() => new Named(), 'named');
    ref.tell('hello');
    await sleep(30);

    const record = said(records(), 'hello')!;
    expect(record.displayName).toBe('Order(42)');
    expect(record.source).toBe(ref.path.toString());
    await system.terminate();
  });

  test('may be derived from state preStart set up', async () => {
    // The case that rules out resolving once at construction: at that
    // point `id` is still empty.
    class Late extends Actor<string> {
      private id = '';
      override preStart(): void {
        this.id = 'user-7';
        this.log.info('starting');
      }
      override displayName(): string { return this.id === '' ? '' : `User(${this.id})`; }
      override onReceive(message: string): void { this.log.info(message); }
    }
    const { system, records } = recordingSystem('display-late');
    system.spawn(() => new Late(), 'late').tell('hello');
    await sleep(30);

    // Named already in preStart — the same call that set the state.
    expect(said(records(), 'starting')!.displayName).toBe('User(user-7)');
    expect(said(records(), 'hello')!.displayName).toBe('User(user-7)');
    await system.terminate();
  });

  test('a name equal to the path collapses back to nothing', async () => {
    class Redundant extends Talker {
      override displayName(): string { return this.context.path.toString(); }
    }
    const { system, records } = recordingSystem('display-redundant');
    system.spawn(() => new Redundant(), 'redundant').tell('hello');
    await sleep(30);

    expect(Object.hasOwn(said(records(), 'hello')!, 'displayName')).toBe(false);
    await system.terminate();
  });

  test('the spawn options outrank the method — the spawn site is the more specific statement', async () => {
    class Named extends Talker {
      override displayName(): string { return 'from-method'; }
    }
    const { system, records } = recordingSystem('display-options-win');
    const namedOptions = ActorOptions.create().withDisplayName('from-options');
    system.spawn(Named, 'both', namedOptions).tell('hello');
    await sleep(30);

    expect(said(records(), 'hello')!.displayName).toBe('from-options');
    await system.terminate();
  });

  test('setDisplayName outranks both, from the very next record', async () => {
    class Renamer extends Actor<string> {
      override displayName(): string { return 'from-method'; }
      override onReceive(message: string): void {
        this.log.info(`before:${message}`);
        this.context.setDisplayName('from-runtime');
        this.log.info(`after:${message}`);
      }
    }
    const { system, records } = recordingSystem('display-runtime-wins');
    const renamerOptions = ActorOptions.create().withDisplayName('from-options');
    system.spawn(Renamer, 'renamer', renamerOptions).tell('x');
    await sleep(30);

    expect(said(records(), 'before:x')!.displayName).toBe('from-options');
    expect(said(records(), 'after:x')!.displayName).toBe('from-runtime');
    await system.terminate();
  });

  test('a throwing hook falls back to the path and warns exactly once', async () => {
    class Broken extends Talker {
      override displayName(): string { throw new Error('boom'); }
    }
    const { system, records } = recordingSystem('display-throws');
    const ref = system.spawn(() => new Broken(), 'broken');
    ref.tell('one'); ref.tell('two'); ref.tell('three');
    await sleep(50);

    const all = records();
    expect(Object.hasOwn(said(all, 'three')!, 'displayName')).toBe(false);
    // Once per instance, however many records the actor wrote.
    expect(all.filter((r) => r.msg.startsWith('displayName() threw'))).toHaveLength(1);
    await system.terminate();
  });

  test('a restart asks the fresh instance again', async () => {
    class Generational extends Actor<string> {
      constructor(private readonly generation: number) { super(); }
      override displayName(): string { return `worker-${this.generation}`; }
      override onReceive(message: string): void {
        if (message === 'boom') throw new Error('boom');
        this.log.info(message);
      }
    }
    let instances = 0;
    const { system, records } = recordingSystem('display-restart');
    const ref = system.spawn(() => new Generational(++instances), 'worker');
    ref.tell('before');
    ref.tell('boom');
    await sleep(50);
    ref.tell('after');
    await sleep(50);

    expect(said(records(), 'before')!.displayName).toBe('worker-1');
    expect(said(records(), 'after')!.displayName).toBe('worker-2');
    await system.terminate();
  });

  test('an actor that never got built still logs its failure against the path', async () => {
    // There is no instance to ask at that point — the resolver has to
    // survive being called anyway.
    const { system, records } = recordingSystem('display-no-instance');
    const ref = system.spawn<string>(() => { throw new Error('nope'); }, 'stillborn');
    await sleep(50);

    const failure = said(records(), 'Actor initialization failed')!;
    expect(failure.source).toBe(ref.path.toString());
    expect(Object.hasOwn(failure, 'displayName')).toBe(false);
    await system.terminate();
  });
});
