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
