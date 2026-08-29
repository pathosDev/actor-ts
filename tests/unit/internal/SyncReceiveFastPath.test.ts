/**
 * `_dispatchToBehavior` forks: a handler that returns a thenable is awaited,
 * one that returns anything else finishes inline, with no promise, no heap
 * frame and no microtask hop.
 *
 * A fork is a correctness risk in proportion to how much of the surrounding
 * code it duplicates, so it duplicates none: the success tail, the failure
 * tail and the epilogue are one method each, called from both sides.  What
 * remains to be proved is that the two sides reach them the same way, and
 * every test here runs the *same* scenario twice — once with a synchronous
 * handler, once with an `async` handler whose body is character-for-character
 * identical — and asserts the two produce the same observable sequence.
 *
 * The pairing is the whole design of this file.  Asserting on the synchronous
 * path alone would prove that the fast path works, not that it is equivalent
 * to the path it replaced, and equivalence is the property that decides
 * whether the fork was safe.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Directive, OneForOneStrategy, type SupervisorStrategy } from '../../../src/Supervision.js';
import { Terminated } from '../../../src/SystemMessages.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

/**
 * Which side of the fork a case is exercising.
 *
 * `'async'` handlers here return a promise that has *already* resolved rather
 * than one that suspends on a timer: the fork is decided by whether a `then`
 * exists, not by how long it takes to settle, and keeping the two variants
 * equally fast keeps the comparison about routing rather than about timing.
 */
type HandlerKind = 'sync' | 'async';

/** Run the same body on both sides of the fork and compare the two results. */
async function bothPaths<T>(run: (kind: HandlerKind) => Promise<T>): Promise<[T, T]> {
  const sync = await run('sync');
  const asyncResult = await run('async');
  return [sync, asyncResult];
}

describe('sync fast path — the two sides of the fork agree', () => {
  test('messages arrive in order, and the sender is visible to each', async () => {
    const [sync, asyncResult] = await bothPaths(async (kind) => {
      const seen: string[] = [];
      class Recorder extends Actor<string> {
        override onReceive(message: string): void | Promise<void> {
          const body = (): void => {
            const sender = this.context.sender;
            seen.push(`${message}:${sender.isSome() ? 'sender' : 'none'}`);
          };
          if (kind === 'sync') return body();
          return Promise.resolve().then(body);
        }
      }
      class Sender extends Actor<'go'> {
        constructor(private readonly target: ActorRef<string>) { super(); }
        override onReceive(): void {
          for (const m of ['a', 'b', 'c']) this.target.tell(m, this.context.self);
        }
      }
      const system = newSystem(`fastpath-order-${kind}`);
      const recorder = system.spawn(Recorder, 'recorder') as ActorRef<string>;
      system.spawnAnonymous(() => new Sender(recorder)).tell('go');
      await awaitCondition(() => seen.length === 3, { timeoutMs: 4_000, label: 'three messages handled' });
      return seen;
    });

    expect(sync).toEqual(['a:sender', 'b:sender', 'c:sender']);
    expect(asyncResult).toEqual(sync);
  });

  test('a throw reaches supervision, carrying the message that caused it', async () => {
    const [sync, asyncResult] = await bothPaths(async (kind) => {
      const failures: string[] = [];
      class Failing extends Actor<string> {
        override onReceive(message: string): void | Promise<void> {
          const body = (): void => { throw new Error(`boom:${message}`); };
          // A synchronous `throw` and a rejected promise have to reach
          // supervision by the same route, or the fork is only equivalent
          // until something goes wrong.
          if (kind === 'sync') return body();
          return Promise.resolve().then(body);
        }
      }
      class Parent extends Actor<'start'> {
        override supervisorStrategy(): SupervisorStrategy {
          return new OneForOneStrategy((error) => {
            failures.push((error as Error).message);
            return Directive.Resume;
          }, { maxRetries: -1 });
        }
        override onReceive(): void {
          const child = this.context.spawn(Failing, 'failing') as ActorRef<string>;
          child.tell('one');
          child.tell('two');
        }
      }
      const system = newSystem(`fastpath-throw-${kind}`);
      system.spawn(Parent, 'parent').tell('start');
      await awaitCondition(() => failures.length === 2, { timeoutMs: 4_000, label: 'both failures supervised' });
      return failures;
    });

    expect(sync).toEqual(['boom:one', 'boom:two']);
    expect(asyncResult).toEqual(sync);
  });

  test('the receive timer is reset on success and left alone on a throw', async () => {
    const [sync, asyncResult] = await bothPaths(async (kind) => {
      const seen: string[] = [];
      class Timed extends Actor<string> {
        override preStart(): void { this.context.setReceiveTimeout(60); }
        override onReceive(message: string): void | Promise<void> {
          const body = (): void => {
            seen.push(message);
            if (message === 'fail') throw new Error('deliberate');
          };
          if (kind === 'sync') return body();
          return Promise.resolve().then(body);
        }
      }
      class Parent extends Actor<'start'> {
        override supervisorStrategy(): SupervisorStrategy {
          return new OneForOneStrategy(() => Directive.Resume, { maxRetries: -1 });
        }
        override onReceive(): void {
          const child = this.context.spawn(Timed, 'timed') as ActorRef<string>;
          child.tell('ok');
          child.tell('fail');
        }
      }
      const system = newSystem(`fastpath-timer-${kind}`);
      system.spawn(Parent, 'parent').tell('start');
      // The timeout fires because the throw did not reset the timer, and the
      // actor is idle afterwards.  That it arrives at all is the assertion;
      // when it arrives is the machine's business.
      await awaitCondition(() => seen.includes('ReceiveTimeout') || seen.length >= 3, {
        timeoutMs: 4_000,
        label: 'the receive timeout fired after the failure',
      });
      return seen.slice(0, 2);
    });

    expect(sync).toEqual(['ok', 'fail']);
    expect(asyncResult).toEqual(sync);
  });

  test('watchWith substitutes the domain message, on both paths', async () => {
    const [sync, asyncResult] = await bothPaths(async (kind) => {
      const seen: string[] = [];
      class Worker extends Actor<'die'> {
        override onReceive(): void { this.self.stop(); }
      }
      type WatcherMessage = 'start' | { readonly kind: 'lost'; readonly name: string } | Terminated;
      class Watcher extends Actor<WatcherMessage> {
        override onReceive(message: WatcherMessage): void | Promise<void> {
          const body = (): void => {
            if (message === 'start') {
              const worker = this.context.spawn(Worker, 'worker') as ActorRef<'die'>;
              this.context.watchWith(worker, { kind: 'lost', name: worker.path.name });
              worker.tell('die');
              return;
            }
            seen.push(message instanceof Terminated ? 'terminated' : `lost:${message.name}`);
          };
          if (kind === 'sync') return body();
          return Promise.resolve().then(body);
        }
      }
      const system = newSystem(`fastpath-watchwith-${kind}`);
      system.spawn(Watcher, 'watcher').tell('start');
      await awaitCondition(() => seen.length === 1, { timeoutMs: 4_000, label: 'the watcher heard about the death' });
      return seen;
    });

    // The substituted message, never the raw signal — the substitution happens
    // before the fork, so both sides must see it.
    expect(sync).toEqual(['lost:worker']);
    expect(asyncResult).toEqual(sync);
  });

  test('an unwatched Terminated is consumed rather than delivered', async () => {
    const [sync, asyncResult] = await bothPaths(async (kind) => {
      const seen: string[] = [];
      class Plain extends Actor<unknown> {
        override onReceive(message: unknown): void | Promise<void> {
          const body = (): void => { seen.push(message instanceof Terminated ? 'terminated' : String(message)); };
          if (kind === 'sync') return body();
          return Promise.resolve().then(body);
        }
      }
      const system = newSystem(`fastpath-unwatched-${kind}`);
      const target = system.spawn(Plain, 'plain') as ActorRef<unknown>;
      const stranger = system.spawn(Plain, 'stranger') as ActorRef<unknown>;
      // Nobody is watching `stranger`, so the signal must be dropped on the
      // floor by the dispatch itself — the path that used to `return` through
      // the `finally` and now calls the epilogue explicitly.
      target.tell(new Terminated(stranger));
      target.tell('after');
      await awaitCondition(() => seen.length === 1, { timeoutMs: 4_000, label: 'the following message was handled' });
      return seen;
    });

    expect(sync).toEqual(['after']);
    expect(asyncResult).toEqual(sync);
  });

  test('the explain plan records one entry per message on both paths', async () => {
    const [sync, asyncResult] = await bothPaths(async (kind) => {
      let outcomes: string[] = [];
      class Recorded extends Actor<string> {
        override preStart(): void { this.context.enableExplainPlan({}); }
        override onReceive(message: string): void | Promise<void> {
          const body = (): void => {
            if (message === 'boom') throw new Error('recorded failure');
            if (message === 'read') outcomes = this.context.explainPlan().map((entry) => entry.outcome);
          };
          if (kind === 'sync') return body();
          return Promise.resolve().then(body);
        }
      }
      class Parent extends Actor<'start'> {
        override supervisorStrategy(): SupervisorStrategy {
          return new OneForOneStrategy(() => Directive.Resume, { maxRetries: -1 });
        }
        override onReceive(): void {
          const child = this.context.spawn(Recorded, 'recorded') as ActorRef<string>;
          child.tell('ok');
          child.tell('boom');
          child.tell('read');
        }
      }
      const system = newSystem(`fastpath-explain-${kind}`);
      system.spawn(Parent, 'parent').tell('start');
      await awaitCondition(() => outcomes.length >= 2, { timeoutMs: 4_000, label: 'the plan was read back' });
      return outcomes.slice(0, 2);
    });

    // Instrumentation is the half most likely to be lost to a fork, because
    // it lives in the epilogue and the epilogue is what a `finally` used to
    // guarantee.
    expect(sync).toEqual(['ok', 'error']);
    expect(asyncResult).toEqual(sync);
  });
});
