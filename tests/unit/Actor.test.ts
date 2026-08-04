import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { JsonLogger, LogLevel, NoopLogger } from '../../src/Logger.js';
import { Props } from '../../src/Props.js';

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
    const ref = system.spawn(Props.create(() => new Talker()), 'plain');
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
    const ref = system.spawn(Props.create(() => new Named()), 'named');
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
    system.spawn(Props.create(() => new Late()), 'late').tell('hello');
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
    system.spawn(Props.create(() => new Redundant()), 'redundant').tell('hello');
    await sleep(30);

    expect(Object.hasOwn(said(records(), 'hello')!, 'displayName')).toBe(false);
    await system.terminate();
  });

  test('Props outranks the method — the spawn site is the more specific statement', async () => {
    class Named extends Talker {
      override displayName(): string { return 'from-method'; }
    }
    const { system, records } = recordingSystem('display-props-wins');
    system.spawn(Props.create(() => new Named()).withDisplayName('from-props'), 'both').tell('hello');
    await sleep(30);

    expect(said(records(), 'hello')!.displayName).toBe('from-props');
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
    system.spawn(Props.create(() => new Renamer()).withDisplayName('from-props'), 'renamer').tell('x');
    await sleep(30);

    expect(said(records(), 'before:x')!.displayName).toBe('from-props');
    expect(said(records(), 'after:x')!.displayName).toBe('from-runtime');
    await system.terminate();
  });

  test('a throwing hook falls back to the path and warns exactly once', async () => {
    class Broken extends Talker {
      override displayName(): string { throw new Error('boom'); }
    }
    const { system, records } = recordingSystem('display-throws');
    const ref = system.spawn(Props.create(() => new Broken()), 'broken');
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
    const ref = system.spawn(Props.create(() => new Generational(++instances)), 'worker');
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
    const ref = system.spawn(Props.create<string>(() => { throw new Error('nope'); }), 'stillborn');
    await sleep(50);

    const failure = said(records(), 'Actor initialization failed')!;
    expect(failure.source).toBe(ref.path.toString());
    expect(Object.hasOwn(failure, 'displayName')).toBe(false);
    await system.terminate();
  });
});
