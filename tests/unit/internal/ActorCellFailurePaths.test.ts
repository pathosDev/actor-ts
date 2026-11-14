import { afterEach, describe, expect, test } from 'bun:test';
import {
  Actor,
  ActorInitializationError,
  ActorSystem,
  ActorSystemOptions,
  DeadLetter,
  Directive,
  JsonLogger,
  LogLevel,
  NoopLogger,
  OneForOneStrategy,
  PoisonPill,
  Terminated,
  type ActorRef,
  type Dispatcher,
  type Logger,
  type SupervisorStrategy,
} from '../../../src/index.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';
import { ThrowingLogger } from '../../util/ThrowingLogger.js';

/**
 * The failure paths through `ActorCell` that left an actor in a state nothing
 * would ever leave: a constructor that throws (#914), a terminating actor with
 * a message still queued (#915), a crash nobody hears about (#916), and a
 * logger that throws while the failure is being reported (#1749).
 */

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function quietSystem(name: string, logger: Logger = new NoopLogger()): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(logger.level);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

function collectDeadLetters(system: ActorSystem): unknown[] {
  const letters: unknown[] = [];
  system.eventStream.subscribeFunction(DeadLetter, (letter) => { letters.push(letter.message); });
  return letters;
}

/* ------------------------------------ #914 ----------------------------------- */

describe('an actor whose constructor throws is stopped, not left suspended (#914)', () => {
  class Unbuildable extends Actor<string> {
    constructor() {
      super();
      throw new Error('constructor boom');
    }
    override onReceive(): void {}
  }

  type ParentQuery = { kind: 'children'; replyTo: (count: number) => void } | string;

  /** Spawns the unbuildable child, watches it, and reports `Terminated`. */
  function parentClass(seen: string[], strategy: SupervisorStrategy | null) {
    return class Parent extends Actor<ParentQuery | Terminated> {
      override supervisorStrategy(): SupervisorStrategy {
        return strategy ?? super.supervisorStrategy();
      }
      override preStart(): void {
        const child = this.context.spawn(Unbuildable, 'unbuildable');
        this.context.watch(child);
        // Queued behind the `create` that is about to fail.
        for (let i = 0; i < 3; i++) child.tell(`queued-${i}`);
      }
      override onReceive(message: ParentQuery | Terminated): void {
        if (message instanceof Terminated) seen.push(`terminated:${message.actor.path.name}`);
        else if (typeof message === 'object') {
          message.replyTo(this.context.child('unbuildable').isSome() ? 1 : 0);
        }
      }
    };
  }

  async function childCount(parent: ActorRef<ParentQuery | Terminated>): Promise<number> {
    return new Promise((resolve) => parent.tell({ kind: 'children', replyTo: resolve }));
  }

  test('under the default strategy: watchers notified, child removed, queue dead-lettered', async () => {
    const system = quietSystem('constructor-failure-default');
    const letters = collectDeadLetters(system);
    const seen: string[] = [];
    const parent = system.spawn(parentClass(seen, null), 'parent');

    await awaitCondition(() => seen.includes('terminated:unbuildable'), {
      label: 'the watcher received Terminated for the child whose constructor threw',
    });
    expect(await childCount(parent)).toBe(0);
    expect(letters).toEqual(['queued-0', 'queued-1', 'queued-2']);
  });

  test('a strategy that answers Restart for an initialization failure still stops the actor', async () => {
    const system = quietSystem('constructor-failure-restart');
    const seen: string[] = [];
    const restartEverything = new OneForOneStrategy((error) => {
      expect(error).toBeInstanceOf(ActorInitializationError);
      return Directive.Restart;
    });
    const parent = system.spawn(parentClass(seen, restartEverything), 'parent');

    await awaitCondition(() => seen.includes('terminated:unbuildable'), {
      label: 'a Restart for an actor that never existed ended in a stop, not a zombie',
    });
    expect(await childCount(parent)).toBe(0);
  });
});

/* ------------------------------------ #915 ----------------------------------- */

describe('a terminating actor with a queued message does not spin the dispatcher (#915)', () => {
  test('dispatcher executions during a slow child stop stay O(1)', async () => {
    const system = quietSystem('terminating-no-spin');
    const letters = collectDeadLetters(system);
    let executions = 0;
    const counting: Dispatcher = {
      id: 'counting',
      execute(task) {
        executions++;
        setImmediate(() => { void task(); });
      },
    };

    let childStarted = false;
    let childStopped = false;
    class SlowChild extends Actor<string> {
      override preStart(): void { childStarted = true; }
      override onReceive(): void {}
      override async postStop(): Promise<void> {
        // The fixture for the whole case: a child that takes this long to stop
        // is what keeps its parent in `terminating` with a message queued.
        await sleep(150);
        childStopped = true;
      }
    }
    let parentStopped = false;
    class Parent extends Actor<unknown> {
      override preStart(): void { this.context.spawn(SlowChild, 'slow'); }
      override onReceive(): void {}
      override postStop(): void { parentStopped = true; }
    }

    const parent = system.spawn(Parent, 'parent', { dispatcher: counting });
    await awaitCondition(() => childStarted, { label: 'the parent and its slow child started' });
    // Lets the parent's start-up turns settle, so the count below is teardown only.
    await sleep(20);
    const before = executions;

    parent.tell(PoisonPill.instance);
    parent.tell('late');

    await awaitCondition(() => parentStopped, { label: 'the parent finished stopping after its slow child' });
    expect(childStopped).toBe(true);
    // A handful: the PoisonPill turn, the `childTerminated` turn, and the one
    // `late` itself schedules.  The spin measured ~120 000 in 300 ms.
    expect(executions - before).toBeLessThan(20);
    expect(letters).toContain('late');
  });
});

/* ------------------------------------ #1749 ---------------------------------- */

describe('a logger that cannot render the failure never skips its supervision step (#1749)', () => {
  function unrenderable(): Error {
    const error = new Error('x');
    Object.defineProperty(error, 'message', { get() { throw new Error('message getter boom'); } });
    return error;
  }

  /** Records JsonLogger output so the lifecycle line can be inspected. */
  function jsonSystem(name: string): { system: ActorSystem; lines: string[] } {
    const lines: string[] = [];
    const logger = new JsonLogger(LogLevel.Info, '', {}, { write: (line) => { lines.push(line); } });
    return { system: quietSystem(name, logger), lines };
  }

  test('preStart: the actor is restarted and the next message reaches the new instance', async () => {
    const { system, lines } = jsonSystem('unrenderable-prestart');
    let starts = 0;
    let received = 0;
    class Subject extends Actor<string> {
      override preStart(): void { starts++; if (starts === 1) throw unrenderable(); }
      override onReceive(): void { received++; }
    }
    const subject = system.spawn(Subject, 'subject');
    await awaitCondition(() => starts === 2, { label: 'the failed start was supervised and restarted' });
    subject.tell('hello');
    await awaitCondition(() => received === 1, { label: 'the restarted instance handled the message' });
    expect(lines.some((line) => line.includes('Actor initialization failed'))).toBe(true);
  });

  test('postStop: watchers still receive Terminated', async () => {
    const { system, lines } = jsonSystem('unrenderable-poststop');
    class Subject extends Actor<string> {
      override onReceive(): void {}
      override postStop(): void { throw unrenderable(); }
    }
    const seen: string[] = [];
    class Watcher extends Actor<Terminated> {
      constructor(private readonly target: ActorRef) { super(); }
      override preStart(): void { this.context.watch(this.target); }
      override onReceive(message: Terminated): void { seen.push(message.actor.path.name); }
    }
    const subject = system.spawn(Subject, 'subject');
    system.spawn(() => new Watcher(subject), 'watcher');
    await sleep(20); // lets the watch register before the stop; the poll below is the assertion
    system.stop(subject);
    await awaitCondition(() => seen.includes('subject'), { label: 'Terminated reached the watcher' });
    expect(lines.some((line) => line.includes('postStop threw'))).toBe(true);
  });

  test('preRestart: a new instance is created and handles the next message', async () => {
    const { system, lines } = jsonSystem('unrenderable-prerestart');
    let starts = 0;
    let received = 0;
    class Subject extends Actor<string> {
      override preStart(): void { starts++; }
      override onReceive(message: string): void {
        if (message === 'crash') throw new Error('crash');
        received++;
      }
      override preRestart(): void { throw unrenderable(); }
    }
    const subject = system.spawn(Subject, 'subject');
    subject.tell('crash');
    subject.tell('after');
    await awaitCondition(() => starts === 2 && received === 1, {
      label: 'the restart completed and the new instance handled the next message',
    });
    expect(lines.some((line) => line.includes('preRestart threw'))).toBe(true);
  });

  /**
   * A caller-supplied logger that throws on every call: each lifecycle hook
   * below fails, so each has a report to make, and none of the reports may
   * cost the step after it.
   */
  test('a logger that throws on every call costs no lifecycle step', async () => {
    const system = quietSystem('throwing-logger', new ThrowingLogger());
    let starts = 0;
    let received = 0;
    class Subject extends Actor<string> {
      override preStart(): void { starts++; if (starts === 1) throw new Error('first start'); }
      override onReceive(message: string): void {
        if (message === 'crash') throw new Error('handler');
        received++;
      }
      override preRestart(): void { throw new Error('preRestart'); }
      override postStop(): void { throw new Error('postStop'); }
    }
    const seen: string[] = [];
    class Watcher extends Actor<Terminated> {
      constructor(private readonly target: ActorRef) { super(); }
      override preStart(): void { this.context.watch(this.target); }
      override onReceive(message: Terminated): void { seen.push(message.actor.path.name); }
    }
    const subject = system.spawn(Subject, 'subject');
    await awaitCondition(() => starts === 2, { label: 'the failed start was restarted despite the logger' });

    subject.tell('crash');
    subject.tell('after');
    await awaitCondition(() => starts === 3 && received === 1, {
      label: 'the restart whose preRestart threw completed despite the logger',
    });

    system.spawn(() => new Watcher(subject), 'watcher');
    await sleep(20); // lets the watch register before the stop; the poll below is the assertion
    system.stop(subject);
    await awaitCondition(() => seen.includes('subject'), {
      label: 'Terminated reached the watcher although postStop threw and its report did too',
    });
  });
});
