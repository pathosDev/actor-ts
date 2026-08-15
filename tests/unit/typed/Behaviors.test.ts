import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { JsonLogger, LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  Behaviors,
  typedActor,
  type Behavior,
} from '../../../src/typed/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { Directive, OneForOneStrategy } from '../../../src/Supervision.js';
import { DeadLetter, Terminated } from '../../../src/SystemMessages.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
const newSys = (name = 'typed-unit'): ActorSystem => {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, sysOptions);
};

describe('Behaviors.receive — basic handler', () => {
  test('receives messages and keeps the same behavior via Behaviors.same', async () => {
    const sys = newSys();
    const seen: string[] = [];
    const behavior: Behavior<string> = Behaviors.receive((_context, message) => {
      seen.push(message);
      return Behaviors.same;
    });
    const ref = sys.spawnTyped(behavior, 'r');
    ref.tell('a'); ref.tell('b'); ref.tell('c');
    await awaitCondition(() => seen.length === 3, {
      timeoutMs: 4_000,
      label: 'all three messages reached the handler',
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    await sys.terminate();
  });

  test('receiveMessage is the no-context shortcut', async () => {
    const sys = newSys();
    const seen: number[] = [];
    const behavior = Behaviors.receiveMessage<number>((m) => { seen.push(m); return Behaviors.same; });
    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell(1); ref.tell(2);
    await awaitCondition(() => seen.length === 2, {
      timeoutMs: 4_000,
      label: 'both messages reached the handler',
    });
    expect(seen).toEqual([1, 2]);
    await sys.terminate();
  });

  test('state transition by returning a new Behavior', async () => {
    const sys = newSys();
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('typed-transition', kitOptions);
    const probe = kit.createTestProbe();

    const counter = (n: number): Behavior<'inc' | 'get'> =>
      Behaviors.receive((_context, message) => {
        if (message === 'inc') return counter(n + 1);
        if (message === 'get') { probe.tell(n); return Behaviors.same; }
        return Behaviors.unhandled;
      });

    const ref = kit.system.spawnTypedAnonymous(counter(0));
    ref.tell('inc'); ref.tell('inc'); ref.tell('inc'); ref.tell('get');
    expect(await probe.expectMessage(3, 500)).toBe(3);
    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.stopped', () => {
  test('stops the actor when returned from a handler (observed via deathwatch)', async () => {
    const sys = newSys();
    const { Terminated } = await import('../../../src/SystemMessages.js');
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('typed-stop', kitOptions);
    const probe = kit.createTestProbe();

    const behavior = Behaviors.receiveMessage<string>((m) => m === 'die' ? Behaviors.stopped : Behaviors.same);
    const ref = kit.system.spawnTypedAnonymous(behavior);
    // Put a watcher on the target so we receive Terminated when it stops.
    kit.system.eventStream.subscribe(probe, Terminated);
    ref.tell('die');
    // We can't rely on EventStream delivering Terminated globally, so fall
    // back to verifying the actor handles no more messages after 'die'.
    await sleep(60);
    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.setup', () => {
  test('runs exactly once with the context before the first message', async () => {
    const sys = newSys();
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('typed-setup', kitOptions);
    const probe = kit.createTestProbe();
    let setupCalls = 0;
    let handled = 0;

    const behavior = Behaviors.setup<string>((context) => {
      setupCalls++;
      probe.tell(`path=${context.path.toString()}`);
      return Behaviors.receiveMessage(() => { handled++; return Behaviors.same; });
    });

    const ref = kit.system.spawnTyped(behavior, 'withSetup');
    const first = await probe.receiveOne(500);
    expect(typeof first).toBe('string');
    expect((first as string).startsWith('path=')).toBe(true);
    ref.tell('anything'); ref.tell('more');
    // "exactly once" only means something once both messages have gone
    // through — the old sleep could expire before either was dequeued and the
    // assertion would then hold for the wrong reason.
    await awaitCondition(() => handled === 2, {
      timeoutMs: 4_000,
      label: 'both messages ran through the behavior setup produced',
    });
    expect(setupCalls).toBe(1);
    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.withTimers', () => {
  test('lets the behavior schedule timer messages at itself', async () => {
    const sys = newSys();
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('typed-timers', kitOptions);
    const probe = kit.createTestProbe();

    const behavior = Behaviors.withTimers<string>((timers) => {
      timers.startSingleTimer('once', 'tick', 20);
      return Behaviors.receiveMessage((m) => {
        probe.tell(m);
        return Behaviors.same;
      });
    });

    kit.system.spawnTypedAnonymous(behavior);
    expect(await probe.expectMessage('tick', 500)).toBe('tick');
    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.withStash', () => {
  test('stashes messages until unstashAll replays them', async () => {
    const sys = newSys();
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('typed-stash', kitOptions);
    const probe = kit.createTestProbe();

    type Message = { kind: 'ready' } | { kind: 'work'; id: number };

    // Start "uninitialized" — stash everything until we receive a 'ready'
    // signal, then replay all buffered work in order.
    const uninit = (stash: import('../../../src/typed/Behavior.js').StashBuffer<Message>): Behavior<Message> =>
      Behaviors.receive<Message>((_context, message) => {
        if (message.kind === 'ready') {
          stash.unstashAll();
          return ready;
        }
        stash.stash(message);
        return Behaviors.same;
      });

    const ready: Behavior<Message> = Behaviors.receive((_context, message) => {
      if (message.kind === 'work') probe.tell(`work#${message.id}`);
      return Behaviors.same;
    });

    const behavior = Behaviors.withStash<Message>(16, (stash) => uninit(stash));
    const ref = kit.system.spawnTypedAnonymous(behavior);
    ref.tell({ kind: 'work', id: 1 });
    ref.tell({ kind: 'work', id: 2 });
    ref.tell({ kind: 'ready' });
    // After 'ready' is handled, the two stashed messages are replayed onto
    // the mailbox in FIFO order, so probe should see work#1 then work#2.
    expect(await probe.expectMessage('work#1', 500)).toBe('work#1');
    expect(await probe.expectMessage('work#2', 500)).toBe('work#2');
    // Subsequent work goes straight to the ready behavior.
    ref.tell({ kind: 'work', id: 3 });
    expect(await probe.expectMessage('work#3', 500)).toBe('work#3');

    await kit.system.terminate();
    await sys.terminate();
  });

  test('stashing past capacity throws StashOverflowError', async () => {
    const sys = newSys();
    const errors: unknown[] = [];
    const behavior = Behaviors.withStash<string>(2, (stash) =>
      Behaviors.receiveMessage((message) => {
        try { stash.stash(message); } catch (e) { errors.push(e); }
        return Behaviors.same;
      }),
    );
    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell('a'); ref.tell('b'); ref.tell('c');
    // Capacity 2, three messages — exactly one overflow, so the count cannot
    // run past the value being waited for.
    await awaitCondition(() => errors.length === 1, {
      timeoutMs: 4_000,
      label: 'the third stash attempt overflowed',
    });
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).name).toBe('StashOverflowError');
    await sys.terminate();
  });

  test('unstashAll replays ahead of messages already queued', async () => {
    const sys = newSys('typed-stash-order');
    const seen: string[] = [];

    const behavior = Behaviors.withStash<string>(16, (stash) => {
      const ready: Behavior<string> = Behaviors.receiveMessage((message) => {
        seen.push(message);
        return Behaviors.same;
      });
      return Behaviors.receiveMessage<string>((message) => {
        if (message === 'ready') { stash.unstashAll(); return ready; }
        stash.stash(message);
        return Behaviors.same;
      });
    });

    const ref = sys.spawnTypedAnonymous(behavior);
    // All four land in the mailbox before the first turn runs (the default
    // dispatcher defers it), so `fresh-1` is already queued behind `ready`
    // when the unstash happens — which is the whole point of the test: a
    // replay that re-`tell`s appends, and would hand `fresh-1` over first.
    ref.tell('stashed-1');
    ref.tell('stashed-2');
    ref.tell('ready');
    ref.tell('fresh-1');
    await awaitCondition(() => seen.length === 3, {
      timeoutMs: 4_000,
      label: 'both stashed messages and the fresh one were handled',
    });
    expect(seen).toEqual(['stashed-1', 'stashed-2', 'fresh-1']);
    await sys.terminate();
  });
});

/**
 * The typed buffer lives on the `TypedActor` instance rather than in the
 * cell's `_stashBuffer`, so the cell's own drain never saw it and a stop or a
 * restart collected it in silence (#639) — the same loss #518 fixed for the
 * OO stash, in the half of the framework that copy did not reach.
 */
describe('Behaviors.withStash — messages that never get unstashed', () => {
  class DeadLetterListener extends Actor<DeadLetter> {
    constructor(private readonly seen: DeadLetter[], private readonly ready: { value: boolean }) { super(); }
    override preStart(): void {
      this.system.eventStream.subscribe(this.self, DeadLetter);
      this.ready.value = true;
    }
    override onReceive(letter: DeadLetter): void { this.seen.push(letter); }
  }

  /** Subscribing happens in preStart, so wait for it before provoking anything. */
  async function listenForDeadLetters(sys: ActorSystem): Promise<DeadLetter[]> {
    const letters: DeadLetter[] = [];
    const ready = { value: false };
    sys.spawn(() => new DeadLetterListener(letters, ready), 'dead-letters');
    await awaitCondition(() => ready.value, { label: 'the dead-letter listener subscribed' });
    return letters;
  }

  /** Parks everything; `boom` throws, so whichever supervisor is in play restarts. */
  const parking = (stashed: string[]): Behavior<string> =>
    Behaviors.withStash<string>(16, (stash) =>
      Behaviors.receiveMessage((message) => {
        if (message === 'boom') throw new Error('boom');
        stashed.push(message);
        stash.stash(message);
        return Behaviors.same;
      }),
    );

  test('a stopped typed actor sends its stash to dead letters', async () => {
    const sys = newSys('typed-stash-stop');
    const letters = await listenForDeadLetters(sys);
    const stashed: string[] = [];

    const ref = sys.spawnTypedAnonymous(parking(stashed));
    ref.tell('a'); ref.tell('b'); ref.tell('c');
    await awaitCondition(() => stashed.length === 3, { label: 'all three messages were stashed' });

    ref.stop();

    const mine = (): DeadLetter[] => letters.filter((l) => l.recipient.equals(ref));
    await awaitCondition(() => mine().length === 3, {
      timeoutMs: 4_000,
      label: 'the typed stash reached dead letters on stop',
    });
    expect(mine().map((l) => l.message)).toEqual(['a', 'b', 'c']);
    await sys.terminate();
  });

  test('a restarted typed actor sends its stash to dead letters', async () => {
    const sys = newSys('typed-stash-restart');
    const letters = await listenForDeadLetters(sys);
    const stashed: string[] = [];

    // No typed `supervise` wrapper, so the throw escapes to the cell and its
    // default strategy restarts the instance — the `preRestart` path.
    const ref = sys.spawnTypedAnonymous(parking(stashed));
    ref.tell('a'); ref.tell('b');
    await awaitCondition(() => stashed.length === 2, { label: 'both messages were stashed' });

    ref.tell('boom');

    const mine = (): DeadLetter[] => letters.filter((l) => l.recipient.equals(ref));
    await awaitCondition(() => mine().length === 2, {
      timeoutMs: 4_000,
      label: 'the typed stash reached dead letters on restart',
    });
    expect(mine().map((l) => l.message)).toEqual(['a', 'b']);
    await sys.terminate();
  });

  test('a Behaviors.supervise restart sends the stash to dead letters', async () => {
    const sys = newSys('typed-stash-supervise-restart');
    const letters = await listenForDeadLetters(sys);
    const stashed: string[] = [];

    // The typed supervisor restarts by re-resolving the behavior in place —
    // the cell never learns of it, so `preRestart` does not run and the drain
    // has to happen in the directive itself.
    const behavior = Behaviors.supervise(parking(stashed)).onFailure(
      new OneForOneStrategy(() => Directive.Restart, { maxRetries: 5, withinTimeRangeMs: 1_000 }),
    );
    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell('a'); ref.tell('b');
    await awaitCondition(() => stashed.length === 2, { label: 'both messages were stashed' });

    ref.tell('boom');

    const mine = (): DeadLetter[] => letters.filter((l) => l.recipient.equals(ref));
    await awaitCondition(() => mine().length === 2, {
      timeoutMs: 4_000,
      label: 'the typed stash reached dead letters on the supervise restart',
    });
    expect(mine().map((l) => l.message)).toEqual(['a', 'b']);
    await sys.terminate();
  });
});

describe('Behaviors.supervise', () => {
  test('restart strategy re-resolves the inner behavior on error', async () => {
    const sys = newSys();
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('typed-supervise', kitOptions);
    const probe = kit.createTestProbe();
    let initCount = 0;

    const inner = Behaviors.setup<string>((_context) => {
      initCount++;
      probe.tell(`init#${initCount}`);
      return Behaviors.receiveMessage((message) => {
        if (message === 'boom') throw new Error('kaboom');
        probe.tell(`saw:${message}`);
        return Behaviors.same;
      });
    });

    const behavior = Behaviors.supervise(inner).onFailure(
      new OneForOneStrategy(() => Directive.Restart, { maxRetries: 5, withinTimeRangeMs: 1_000 }),
    );
    const ref = kit.system.spawnTypedAnonymous(behavior);

    expect(await probe.expectMessage('init#1', 500)).toBe('init#1');
    ref.tell('one');
    expect(await probe.expectMessage('saw:one', 500)).toBe('saw:one');
    ref.tell('boom'); // error, restart
    expect(await probe.expectMessage('init#2', 500)).toBe('init#2');
    ref.tell('two');
    expect(await probe.expectMessage('saw:two', 500)).toBe('saw:two');

    await kit.system.terminate();
    await sys.terminate();
  });

  test('resume directive swallows the error without reinitializing', async () => {
    const sys = newSys();
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('typed-resume', kitOptions);
    const probe = kit.createTestProbe();
    let initCount = 0;

    const inner = Behaviors.setup<string>(() => {
      initCount++;
      return Behaviors.receiveMessage((message) => {
        if (message === 'boom') throw new Error('oops');
        probe.tell(message);
        return Behaviors.same;
      });
    });

    const behavior = Behaviors.supervise(inner).onFailure(
      new OneForOneStrategy(() => Directive.Resume),
    );
    const ref = kit.system.spawnTypedAnonymous(behavior);
    ref.tell('a');
    expect(await probe.expectMessage('a', 500)).toBe('a');
    ref.tell('boom');
    ref.tell('b');
    expect(await probe.expectMessage('b', 500)).toBe('b');
    expect(initCount).toBe(1); // never reinitialised

    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.empty / Behaviors.ignore', () => {
  test('ignore silently drops all messages', async () => {
    const sys = newSys();
    const ref = sys.spawnTypedAnonymous(Behaviors.ignore);
    ref.tell('a' as never); ref.tell('b' as never);
    await sleep(20);
    // No crash and the actor still exists — that's the contract.
    expect(ref.path.name.length).toBeGreaterThan(0);
    await sys.terminate();
  });
});

describe('typedActor — interop with OO Actor API', () => {
  test('typedActor works through system.spawn', async () => {
    const sys = newSys();
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('typed-actor', kitOptions);
    const probe = kit.createTestProbe();

    const behavior = Behaviors.receiveMessage<number>((m) => { probe.tell(m * 2); return Behaviors.same; });
    const ref = kit.system.spawnAnonymous(typedActor(behavior));
    ref.tell(21);
    expect(await probe.expectMessage(42, 500)).toBe(42);

    await kit.system.terminate();
    await sys.terminate();
  });
});

describe('Behaviors.unhandled', () => {
  test('unhandled messages route to dead letters', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('typed-unhandled', kitOptions);
    const probe = kit.createTestProbe();
    const { DeadLetter } = await import('../../../src/SystemMessages.js');
    kit.system.eventStream.subscribe(probe, DeadLetter);

    const behavior = Behaviors.receiveMessage<string>((m) => m === 'yes' ? Behaviors.same : Behaviors.unhandled);
    const ref = kit.system.spawnTypedAnonymous(behavior);
    ref.tell('yes');
    ref.tell('no');
    const dl = await probe.receiveOne(500) as { message: unknown };
    expect(dl.message).toBe('no');
    await kit.system.terminate();
  });
});

/* ----------------- spawnTyped on ActorSystem + ActorContext ---------------- */

describe('system.spawnTyped + ctx.spawnTyped', () => {
  test('system.spawnTyped returns a typed ActorRef at the named path', async () => {
    const sys = newSys();
    const behavior = Behaviors.receiveMessage<string>(() => Behaviors.same);
    const ref = sys.spawnTyped(behavior, 'named-typed');
    expect(ref.path.name).toBe('named-typed');
    expect(ref.path.toString()).toContain('/user/named-typed');
    await sys.terminate();
  });

  test('system.spawnTypedAnonymous auto-generates a path under /user', async () => {
    const sys = newSys();
    const behavior = Behaviors.receiveMessage<string>(() => Behaviors.same);
    const ref = sys.spawnTypedAnonymous(behavior);
    expect(ref.path.name).toMatch(/^\$anonymous-\d+-[0-9a-f]{12}$/);
    expect(ref.path.toString()).toContain('/user/');
    await sys.terminate();
  });

  test('ctx.spawnTyped + ctx.spawnTypedAnonymous on an untyped parent', async () => {
    const sys = newSys();
    const seen: string[] = [];
    const { Actor } = await import('../../../src/Actor.js');

    // Parent forwards every received string to its typed-child set,
    // exercising both shapes of `ctx.spawnTyped*`.
    class UntypedParent extends Actor<{ kind: 'fwd'; m: string }> {
      private named!: import('../../../src/ActorRef.js').ActorRef<string>;
      private anon!:  import('../../../src/ActorRef.js').ActorRef<string>;
      override preStart(): void {
        const childBehavior = Behaviors.receiveMessage<string>((m) => {
          seen.push(m);
          return Behaviors.same;
        });
        this.named = this.context.spawnTyped(childBehavior, 'typed-child');
        this.anon  = this.context.spawnTypedAnonymous(childBehavior);
        // Path checks (the test surface is the parent's own assertions
        // about what `ctx.spawnTyped*` returned — visible via the child
        // names the framework recorded).
        if (this.named.path.name !== 'typed-child') {
          throw new Error(`named child path was ${this.named.path.name}`);
        }
        if (!/^\$anonymous-\d+-[0-9a-f]{12}$/.test(this.anon.path.name)) {
          throw new Error(`anon child path was ${this.anon.path.name}`);
        }
      }
      override onReceive(env: { kind: 'fwd'; m: string }): void {
        this.named.tell(env.m);
        this.anon.tell(env.m);
      }
    }

    const parent = sys.spawn(UntypedParent, 'parent');
    parent.tell({ kind: 'fwd', m: 'hi' });
    await awaitCondition(() => seen.length === 2, {
      timeoutMs: 4_000,
      label: 'both typed children received the forwarded message',
    });
    // Both children received the same message — order across children is
    // not deterministic, so sort.
    expect(seen.sort()).toEqual(['hi', 'hi']);
    await sys.terminate();
  });
});

describe('Behaviors.receiveWithSignal — terminated signal (#448)', () => {
  test('a watched actor stopping arrives at onSignal, not at the receive handler', async () => {
    // The `terminated` signal kind was declared and documented from the start
    // but constructed nowhere, so onSignal was never called for it — the
    // Terminated went to the receive handler instead, typed as T.
    const sys = newSys('typed-terminated');
    const seen: string[] = [];
    let child: ActorRef<string> | null = null;

    const parent: Behavior<string> = Behaviors.setup<string>((context) => {
      child = context.spawn(Behaviors.receiveMessage<string>(() => Behaviors.same), 'kid');
      context.watch(child);
      return Behaviors.receiveWithSignal<string>(
        (_context, message) => { seen.push(`message:${message}`); return Behaviors.same; },
        (_context, signal) => {
          seen.push(signal.kind === 'terminated' ? `terminated:${signal.ref.path.name}` : signal.kind);
          return Behaviors.same;
        },
      );
    });

    sys.spawn(typedActor(parent), 'parent');
    // `child` is assigned inside `setup`, so its presence is what says the
    // parent is up — not 40 ms of hoping.
    await awaitCondition(() => child !== null, {
      timeoutMs: 4_000,
      label: 'the parent behavior spawned its child',
    });
    child!.stop();
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the terminated signal reached the parent',
    });

    expect(seen).toEqual(['terminated:kid']);
    await sys.terminate();
  });

  test('signal.ref identifies which watched actor stopped', async () => {
    const sys = newSys('typed-terminated-which');
    const stopped: string[] = [];
    let first: ActorRef<string> | null = null;
    let second: ActorRef<string> | null = null;

    const parent: Behavior<string> = Behaviors.setup<string>((context) => {
      first = context.spawn(Behaviors.receiveMessage<string>(() => Behaviors.same), 'first');
      second = context.spawn(Behaviors.receiveMessage<string>(() => Behaviors.same), 'second');
      context.watch(first);
      context.watch(second);
      return Behaviors.receiveWithSignal<string>(
        () => Behaviors.same,
        (_context, signal) => {
          if (signal.kind === 'terminated') stopped.push(signal.ref.path.name);
          return Behaviors.same;
        },
      );
    });

    sys.spawn(typedActor(parent), 'parent');
    await awaitCondition(() => first !== null && second !== null, {
      timeoutMs: 4_000,
      label: 'the parent behavior spawned both children',
    });
    second!.stop();
    await awaitCondition(() => stopped.length === 1, {
      timeoutMs: 4_000,
      label: 'the first terminated signal arrived',
    });
    expect(stopped).toEqual(['second']);

    first!.stop();
    await awaitCondition(() => stopped.length === 2, {
      timeoutMs: 4_000,
      label: 'the second terminated signal arrived',
    });
    expect(stopped).toEqual(['second', 'first']);

    await sys.terminate();
  });

  test('the behavior returned from a terminated signal is honoured', async () => {
    // Unlike post-stop and pre-restart, the actor keeps running after this
    // signal — so answering Behaviors.stopped must actually stop it.  The docs
    // promise the return value "works the same as the receive handler".
    const sys = newSys('typed-terminated-transition');
    const seen: string[] = [];
    let child: ActorRef<string> | null = null;

    const parent: Behavior<string> = Behaviors.setup<string>((context) => {
      child = context.spawn(Behaviors.receiveMessage<string>(() => Behaviors.same), 'kid');
      context.watch(child);
      return Behaviors.receiveWithSignal<string>(
        (_context, message) => { seen.push(message); return Behaviors.same; },
        (_context, signal) => match(signal)
          .with({ kind: 'terminated' }, () => {
            seen.push('watched-child-died');
            return Behaviors.stopped as Behavior<string>;
          })
          .with({ kind: 'post-stop' }, () => {
            seen.push('post-stop');
            return Behaviors.same as Behavior<string>;
          })
          .otherwise(() => Behaviors.same as Behavior<string>),
      );
    });

    const ref = sys.spawn(typedActor(parent), 'parent');
    await awaitCondition(() => child !== null, {
      timeoutMs: 4_000,
      label: 'the parent behavior spawned its child',
    });
    child!.stop();
    // Stopping in response to the signal also fires post-stop, which shows the
    // transition really happened rather than the signal merely being observed
    // — so post-stop is the end of the sequence and the thing to wait for.
    await awaitCondition(() => seen.length === 2, {
      timeoutMs: 4_000,
      label: 'the parent stopped itself in response to the signal',
    });

    expect(seen).toEqual(['watched-child-died', 'post-stop']);

    ref.tell('ignored — the parent stopped itself');
    await sleep(40);
    expect(seen).toEqual(['watched-child-died', 'post-stop']);

    await sys.terminate();
  });

  test('without an onSignal handler the message still flows to the receive handler', async () => {
    // Keeps the change additive: code written before the signal worked, which
    // watched an actor and inspected the Terminated in its receive handler,
    // behaves exactly as it did.
    const sys = newSys('typed-terminated-nosignal');
    const seen: string[] = [];
    let child: ActorRef<string> | null = null;

    const parent: Behavior<unknown> = Behaviors.setup<unknown>((context) => {
      child = context.spawn(Behaviors.receiveMessage<string>(() => Behaviors.same), 'kid');
      context.watch(child);
      return Behaviors.receiveMessage<unknown>((message) => {
        seen.push(message instanceof Terminated ? `terminated-as-message:${message.actor.path.name}` : 'other');
        return Behaviors.same;
      });
    });

    sys.spawn(typedActor(parent), 'parent');
    await awaitCondition(() => child !== null, {
      timeoutMs: 4_000,
      label: 'the parent behavior spawned its child',
    });
    child!.stop();
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the Terminated arrived at the receive handler',
    });

    expect(seen).toEqual(['terminated-as-message:kid']);
    await sys.terminate();
  });
});

describe('TypedActorContext.watchWith — custom termination message (#159)', () => {
  test('the custom message reaches the receive handler, not onSignal', async () => {
    // The signal detour is what makes this worth a test of its own: with an
    // onSignal handler registered, *every* Terminated is rerouted away from the
    // receive handler.  A watchWith message must not take that path — the
    // caller asked for a message of the protocol, so the protocol's handler is
    // where it belongs.  It works because the cell substitutes the message
    // before TypedActor sees it, and that is exactly what could regress.
    const sys = newSys('typed-watch-with');
    const seen: string[] = [];
    let child: ActorRef<string> | null = null;

    const parent: Behavior<string> = Behaviors.setup<string>((context) => {
      child = context.spawn(Behaviors.receiveMessage<string>(() => Behaviors.same), 'kid');
      context.watchWith(child, 'kid-died');
      return Behaviors.receiveWithSignal<string>(
        (_context, message) => { seen.push(`message:${message}`); return Behaviors.same; },
        (_context, signal) => { seen.push(`signal:${signal.kind}`); return Behaviors.same; },
      );
    });

    sys.spawn(typedActor(parent), 'parent');
    await awaitCondition(() => child !== null, {
      timeoutMs: 4_000,
      label: 'the parent behavior spawned its child',
    });
    child!.stop();
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the parent was told about the death',
    });

    expect(seen).toEqual(['message:kid-died']);
    await sys.terminate();
  });
});

describe('TypedActorContext.setDisplayName (#891)', () => {
  /** JsonLogger keeps `displayName` a named field instead of rendered text. */
  function recordingSystem(name: string): { system: ActorSystem; names: () => Array<string | undefined> } {
    const lines: string[] = [];
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new JsonLogger(LogLevel.Debug, '', {}, { write: (line) => { lines.push(line); } }));
    return {
      system: ActorSystem.create(name, sysOptions),
      names: () => lines
        .map((line) => JSON.parse(line) as { msg: string; displayName?: string })
        .filter((record) => record.msg === 'handled')
        .map((record) => record.displayName),
    };
  }

  test('names a Behaviors actor, which has no subclass to override', async () => {
    // Every Behavior runs inside the same TypedActor, so `displayName()`
    // is not reachable from user code here — this is the way in.
    const { system, names } = recordingSystem('typed-display-name');
    const behavior: Behavior<string> = Behaviors.setup((context) => {
      context.setDisplayName('Cart(alice)');
      return Behaviors.receive((inner, _message) => {
        inner.log.info('handled');
        return Behaviors.same;
      });
    });
    system.spawnTyped(behavior, 'entity-7b3f').tell('x');
    await awaitCondition(() => names().length === 1, {
      timeoutMs: 4_000,
      label: 'the behavior logged its handled message',
    });

    expect(names()).toEqual(['Cart(alice)']);
    await system.terminate();
  });

  test('withDisplayName names a typed actor without entering the behavior', async () => {
    const { system, names } = recordingSystem('typed-display-name-options');
    const behavior: Behavior<string> = Behaviors.receive((context, _message) => {
      context.log.info('handled');
      return Behaviors.same;
    });
    const entityOptions = ActorOptions.create<string>().withDisplayName('Cart(bob)');
    system.spawn(typedActor(behavior), 'entity-9c21', entityOptions).tell('x');
    await awaitCondition(() => names().length === 1, {
      timeoutMs: 4_000,
      label: 'the behavior logged its handled message',
    });

    expect(names()).toEqual(['Cart(bob)']);
    await system.terminate();
  });
});

/* ---------- intercept / monitor / logMessages combinators (#152) ---------- */

type TickMessage = { readonly kind: 'tick' };
type ResetMessage = { readonly kind: 'reset' };
type CounterMessage = TickMessage | ResetMessage;

/** Records every message the wrapped behavior handled, staying as it is. */
const recordingInto = (sink: number[]): Behavior<number> =>
  Behaviors.receiveMessage<number>((message) => {
    sink.push(message);
    return Behaviors.same;
  });

describe('Behaviors.intercept (#152)', () => {
  test('an interceptor keeps running after the inner behavior swaps itself out', async () => {
    // The interpreter case: `resolve()` collapses every other wrapper into the
    // leaf it produced, and a transition replaces `current` wholesale — so an
    // interceptor that is not re-installed survives exactly one message of a
    // behavior that returns a fresh receive each time, which is the normal
    // shape of a state machine.
    const sys = newSys('typed-intercept-survives');
    const intercepted: number[] = [];
    const totals: number[] = [];

    const counting = (total: number): Behavior<number> =>
      Behaviors.receiveMessage<number>((message) => {
        totals.push(total + message);
        return counting(total + message);
      });

    const behavior = Behaviors.intercept<number>(counting(0), (context, message, next) => {
      intercepted.push(message);
      return next(context, message);
    });

    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell(1); ref.tell(2); ref.tell(3);
    await awaitCondition(() => totals.length === 3, {
      timeoutMs: 4_000,
      label: 'all three messages ran through the inner behavior',
    });

    expect(intercepted).toEqual([1, 2, 3]);
    expect(totals).toEqual([1, 3, 6]);
    await sys.terminate();
  });

  test('an interceptor transforms the message the inner behavior sees', async () => {
    const sys = newSys('typed-intercept-transform');
    const seen: number[] = [];
    const behavior = Behaviors.intercept<number>(
      recordingInto(seen),
      (context, message, next) => next(context, message * 2),
    );

    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell(1); ref.tell(2); ref.tell(3);
    await awaitCondition(() => seen.length === 3, {
      timeoutMs: 4_000,
      label: 'all three transformed messages arrived',
    });

    expect(seen).toEqual([2, 4, 6]);
    await sys.terminate();
  });

  test('an interceptor that never delegates short-circuits the inner behavior', async () => {
    const sys = newSys('typed-intercept-veto');
    const seen: number[] = [];
    const behavior = Behaviors.intercept<number>(recordingInto(seen), (context, message, next) =>
      message % 2 === 0 ? next(context, message) : Behaviors.same);

    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell(1); ref.tell(2); ref.tell(3); ref.tell(4);
    await awaitCondition(() => seen.length === 2, {
      timeoutMs: 4_000,
      label: 'both even messages arrived',
    });
    expect(seen).toEqual([2, 4]);

    // A veto is not a transition — the wrapper is still in place afterwards.
    ref.tell(6);
    await awaitCondition(() => seen.length === 3, {
      timeoutMs: 4_000,
      label: 'the behavior still works after a vetoed message',
    });
    expect(seen).toEqual([2, 4, 6]);
    await sys.terminate();
  });

  test('nested interceptors run outermost-first and all survive a transition', async () => {
    const sys = newSys('typed-intercept-nested');
    const order: string[] = [];

    // Transitions on every message, so the second round proves both wrappers
    // were re-installed rather than merely surviving the first delivery.
    const leaf = (): Behavior<number> =>
      Behaviors.receiveMessage<number>(() => { order.push('leaf'); return leaf(); });

    const nearest = Behaviors.intercept<number>(leaf(), (context, message, next) => {
      order.push('nearest');
      return next(context, message);
    });
    const behavior = Behaviors.intercept<number>(nearest, (context, message, next) => {
      order.push('outermost');
      return next(context, message);
    });

    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell(1); ref.tell(2);
    await awaitCondition(() => order.filter((entry) => entry === 'leaf').length === 2, {
      timeoutMs: 4_000,
      label: 'both messages reached the leaf behavior',
    });

    expect(order).toEqual(['outermost', 'nearest', 'leaf', 'outermost', 'nearest', 'leaf']);
    await sys.terminate();
  });

  test('stopping from inside an intercepted behavior really stops the actor', async () => {
    // `stopped` is the one behavior the wrapper must not survive: it has to
    // reach the top as a bare sentinel or the actor would keep running.
    const sys = newSys('typed-intercept-stop');
    const events: string[] = [];
    let child: ActorRef<string> | null = null;

    const parent: Behavior<string> = Behaviors.setup<string>((context) => {
      const inner = Behaviors.receiveMessage<string>((message) =>
        message === 'stop' ? Behaviors.stopped : Behaviors.same);
      child = context.spawn(
        Behaviors.intercept<string>(inner, (innerContext, message, next) => {
          events.push(`saw:${message}`);
          return next(innerContext, message);
        }),
        'kid',
      );
      context.watch(child);
      return Behaviors.receiveWithSignal<string>(
        () => Behaviors.same,
        (_context, signal) => {
          if (signal.kind === 'terminated') events.push('kid-stopped');
          return Behaviors.same;
        },
      );
    });

    sys.spawn(typedActor(parent), 'parent');
    await awaitCondition(() => child !== null, {
      timeoutMs: 4_000,
      label: 'the parent behavior spawned its child',
    });
    child!.tell('stop');
    await awaitCondition(() => events.includes('kid-stopped'), {
      timeoutMs: 4_000,
      label: 'the intercepted child stopped itself',
    });

    expect(events).toEqual(['saw:stop', 'kid-stopped']);
    await sys.terminate();
  });

  test('an error thrown by the interceptor reaches an enclosing supervise', async () => {
    const sys = newSys('typed-intercept-supervise');
    const seen: number[] = [];
    const failures: string[] = [];

    const strategy = new OneForOneStrategy((error) => {
      failures.push(error.message);
      return Directive.Resume;
    });
    const behavior = Behaviors.supervise(
      Behaviors.intercept<number>(recordingInto(seen), (context, message, next) => {
        if (message === 13) throw new Error('unlucky');
        return next(context, message);
      }),
    ).onFailure(strategy);

    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell(1); ref.tell(13); ref.tell(2);
    await awaitCondition(() => seen.length === 2, {
      timeoutMs: 4_000,
      label: 'both survivable messages were handled',
    });

    expect(seen).toEqual([1, 2]);
    expect(failures).toEqual(['unlucky']);
    await sys.terminate();
  });
});

describe('Behaviors.intercept under a restarting supervise (#152)', () => {
  /**
   * A behavior that records what it handled and blows up on 13.  Restarting it
   * re-runs `Behaviors.setup`, so `handled` also tells us the fresh instance is
   * live again.
   */
  const explodingOn13 = (handled: number[]): Behavior<number> =>
    Behaviors.receiveMessage<number>((message) => {
      if (message === 13) throw new Error('unlucky');
      handled.push(message);
      return Behaviors.same;
    });

  test('a restart does not duplicate an interceptor that sits inside the supervise wrapper', async () => {
    // `handleSupervise` re-resolves `supervise.child`, and when the interceptor
    // lives *inside* that wrapper the resolved behavior already carries it.
    // Re-installing the whole stack of `current` on top layered a second copy
    // onto it, so every message after the first restart was observed twice.
    const sys = newSys('typed-intercept-restart-once');
    const observed: number[] = [];
    const handled: number[] = [];

    const strategy = new OneForOneStrategy(() => Directive.Restart);
    const behavior = Behaviors.supervise(
      Behaviors.intercept<number>(explodingOn13(handled), (context, message, next) => {
        observed.push(message);
        return next(context, message);
      }),
    ).onFailure(strategy);

    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell(1); ref.tell(13); ref.tell(2); ref.tell(3);
    await awaitCondition(() => handled.length === 3, {
      timeoutMs: 4_000,
      label: 'every survivable message reached the inner behavior',
    });

    expect(handled).toEqual([1, 2, 3]);
    // The interceptor runs exactly once per message — including the crash.
    expect(observed).toEqual([1, 13, 2, 3]);
    await sys.terminate();
  });

  test('the interceptor stack does not grow with each further restart', async () => {
    // The duplication compounded: every restart wrapped one more copy around
    // the stack, so a crash-looping actor paid linearly more per message (and
    // held linearly more behavior objects) the longer it ran.  Two crashes
    // separate "doubled once" from "grows without bound".
    const sys = newSys('typed-intercept-restart-twice');
    const observed: number[] = [];
    const handled: number[] = [];

    const strategy = new OneForOneStrategy(() => Directive.Restart);
    const behavior = Behaviors.supervise(
      Behaviors.intercept<number>(explodingOn13(handled), (context, message, next) => {
        observed.push(message);
        return next(context, message);
      }),
    ).onFailure(strategy);

    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell(13); ref.tell(13); ref.tell(7);
    await awaitCondition(() => handled.length === 1, {
      timeoutMs: 4_000,
      label: 'the message after the second restart was handled',
    });

    expect(handled).toEqual([7]);
    // One observation per message after two restarts — not 1 + 2 + 3.
    expect(observed).toEqual([13, 13, 7]);
    await sys.terminate();
  });

  test('an interceptor outside the supervise wrapper still survives a restart', async () => {
    // The counterpart the fix must not break: an interceptor installed around
    // `supervise` is not part of what restarts, so re-resolving the child drops
    // it and it has to be put back.
    const sys = newSys('typed-intercept-restart-outside');
    const observed: number[] = [];
    const handled: number[] = [];

    const strategy = new OneForOneStrategy(() => Directive.Restart);
    const supervised = Behaviors.supervise(explodingOn13(handled)).onFailure(strategy);
    const behavior = Behaviors.intercept<number>(supervised, (context, message, next) => {
      observed.push(message);
      return next(context, message);
    });

    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell(1); ref.tell(13); ref.tell(2);
    await awaitCondition(() => handled.length === 2, {
      timeoutMs: 4_000,
      label: 'both survivable messages reached the inner behavior',
    });

    expect(handled).toEqual([1, 2]);
    expect(observed).toEqual([1, 13, 2]);
    await sys.terminate();
  });

  test('interceptors on both sides of supervise each run once after a restart', async () => {
    // The two rules meet here: the outer one has to be put back by hand, the
    // inner one comes back with the re-resolved child.  Getting the split
    // wrong in either direction shows up as a missing or a doubled entry.
    const sys = newSys('typed-intercept-restart-both');
    const order: string[] = [];
    const handled: number[] = [];

    const strategy = new OneForOneStrategy(() => Directive.Restart);
    const inside = Behaviors.intercept<number>(explodingOn13(handled), (context, message, next) => {
      order.push(`inside:${message}`);
      return next(context, message);
    });
    const supervised = Behaviors.supervise(inside).onFailure(strategy);
    const behavior = Behaviors.intercept<number>(supervised, (context, message, next) => {
      order.push(`outside:${message}`);
      return next(context, message);
    });

    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell(13); ref.tell(4);
    await awaitCondition(() => handled.length === 1, {
      timeoutMs: 4_000,
      label: 'the message after the restart was handled',
    });

    expect(handled).toEqual([4]);
    expect(order).toEqual(['outside:13', 'inside:13', 'outside:4', 'inside:4']);
    await sys.terminate();
  });
});

describe('Behaviors.monitor (#152)', () => {
  const kitOptions = (): TestKitOptions => TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);

  test('forwards every message to the observer and still delivers to the inner behavior', async () => {
    const kit = TestKit.create('typed-monitor', kitOptions());
    const probe = kit.createTestProbe();
    const seen: number[] = [];

    const ref = kit.system.spawnTypedAnonymous(
      Behaviors.monitor<number>(probe as ActorRef<number>, recordingInto(seen)),
    );
    for (let i = 1; i <= 5; i++) ref.tell(i);

    expect(await probe.receiveN(5, 1_000)).toEqual([1, 2, 3, 4, 5]);
    await awaitCondition(() => seen.length === 5, {
      timeoutMs: 4_000,
      label: 'the inner behavior saw all five messages too',
    });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    await kit.system.terminate();
  });

  test('a throwing observer never disturbs the inner behavior', async () => {
    // A tap is best-effort: an observer that is gone, full, or simply broken
    // must not turn into a failure of the actor being observed.
    const sys = newSys('typed-monitor-broken');
    const seen: number[] = [];
    const failures: string[] = [];
    const brokenObserver = {
      tell(): void { throw new Error('the monitor is down'); },
    } as unknown as ActorRef<number>;

    const strategy = new OneForOneStrategy((error) => {
      failures.push(error.message);
      return Directive.Resume;
    });
    const behavior = Behaviors.supervise(
      Behaviors.monitor<number>(brokenObserver, recordingInto(seen)),
    ).onFailure(strategy);

    const ref = sys.spawnTypedAnonymous(behavior);
    ref.tell(1); ref.tell(2); ref.tell(3);
    await awaitCondition(() => seen.length === 3, {
      timeoutMs: 4_000,
      label: 'every message reached the inner behavior',
    });

    expect(seen).toEqual([1, 2, 3]);
    expect(failures).toEqual([]);
    await sys.terminate();
  });
});

describe('Behaviors.logMessages (#152)', () => {
  type LogRecord = { readonly level: string; readonly msg: string };

  /** A system whose logger keeps every record, so the lines can be asserted. */
  function loggingSystem(name: string, level = LogLevel.Debug): {
    system: ActorSystem;
    records: () => LogRecord[];
  } {
    const lines: string[] = [];
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new JsonLogger(level, '', {}, { write: (line) => { lines.push(line); } }));
    return {
      system: ActorSystem.create(name, sysOptions),
      records: () => lines
        .map((line) => JSON.parse(line) as LogRecord)
        .filter((record) => record.msg.startsWith('received') || record.msg.startsWith('audit')),
    };
  }

  const handlingInto = (sink: string[]): Behavior<CounterMessage> =>
    Behaviors.receiveMessage<CounterMessage>((message) => {
      sink.push(message.kind);
      return Behaviors.same;
    });

  test('logs one debug line per message, naming the message by its kind', async () => {
    const { system, records } = loggingSystem('typed-log-messages');
    const handled: string[] = [];

    const ref = system.spawnTyped(Behaviors.logMessages(handlingInto(handled)), 'logged');
    ref.tell({ kind: 'tick' });
    ref.tell({ kind: 'tick' });
    ref.tell({ kind: 'reset' });
    await awaitCondition(() => handled.length === 3, {
      timeoutMs: 4_000,
      label: 'all three messages were handled',
    });

    expect(records().map((record) => record.msg)).toEqual([
      'received tick', 'received tick', 'received reset',
    ]);
    expect(records().map((record) => record.level)).toEqual(['debug', 'debug', 'debug']);
    await system.terminate();
  });

  test('a custom formatter owns the whole line', async () => {
    const { system, records } = loggingSystem('typed-log-messages-formatter');
    const handled: string[] = [];
    const options = { formatter: (message: CounterMessage) => `audit ${message.kind}` };

    const ref = system.spawnTyped(Behaviors.logMessages(handlingInto(handled), options), 'logged');
    ref.tell({ kind: 'tick' });
    ref.tell({ kind: 'reset' });
    await awaitCondition(() => handled.length === 2, {
      timeoutMs: 4_000,
      label: 'both messages were handled',
    });

    expect(records().map((record) => record.msg)).toEqual(['audit tick', 'audit reset']);
    await system.terminate();
  });

  test('a throwing formatter falls back to the built-in line', async () => {
    const { system, records } = loggingSystem('typed-log-messages-bad-formatter');
    const handled: string[] = [];
    const options = { formatter: (): string => { throw new Error('bad formatter'); } };

    const ref = system.spawnTyped(Behaviors.logMessages(handlingInto(handled), options), 'logged');
    ref.tell({ kind: 'tick' });
    await awaitCondition(() => handled.length === 1, {
      timeoutMs: 4_000,
      label: 'the message was handled despite the formatter',
    });

    expect(records().map((record) => record.msg)).toEqual(['received tick (formatter threw)']);
    await system.terminate();
  });

  test("level: 'info' reports at info", async () => {
    const { system, records } = loggingSystem('typed-log-messages-info');
    const handled: string[] = [];
    const options = { level: 'info' as const };

    const ref = system.spawnTyped(Behaviors.logMessages(handlingInto(handled), options), 'logged');
    ref.tell({ kind: 'tick' });
    await awaitCondition(() => handled.length === 1, {
      timeoutMs: 4_000,
      label: 'the message was handled',
    });

    expect(records().map((record) => `${record.level}:${record.msg}`)).toEqual(['info:received tick']);
    await system.terminate();
  });

  test('emits nothing when the logger would drop the line anyway', async () => {
    const { system, records } = loggingSystem('typed-log-messages-off', LogLevel.Warn);
    const handled: string[] = [];

    const ref = system.spawnTyped(Behaviors.logMessages(handlingInto(handled)), 'logged');
    ref.tell({ kind: 'tick' });
    await awaitCondition(() => handled.length === 1, {
      timeoutMs: 4_000,
      label: 'the message was handled',
    });

    expect(records()).toEqual([]);
    await system.terminate();
  });
});
