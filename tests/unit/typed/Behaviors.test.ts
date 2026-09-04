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
  type WithStashBehavior,
} from '../../../src/typed/index.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { Directive, OneForOneStrategy } from '../../../src/Supervision.js';
import { DeadLetter, Terminated } from '../../../src/SystemMessages.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

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

  test('a bounded mailbox bounds the typed replay too (#772)', async () => {
    const sys = newSys('typed-stash-bounded');
    const seen: string[] = [];
    const parked: string[] = [];

    const behavior = Behaviors.withStash<string>(16, (stash) => {
      const ready: Behavior<string> = Behaviors.receiveMessage((message) => {
        seen.push(message);
        return Behaviors.same;
      });
      return Behaviors.receiveMessage<string>((message) => {
        if (message === 'ready') { stash.unstashAll(); return ready; }
        stash.stash(message);
        parked.push(message);
        return Behaviors.same;
      });
    });

    // The typed buffer's capacity is its own — 16 here — so the mailbox bound
    // is the only thing standing between a replay and the queue.  Until #772
    // it stood aside: `prependUserMessages` reached the same base
    // `prependUser` the OO stash did.
    const options = ActorOptions.create<string>()
      .withMailboxCapacity(4)
      .withMailboxOverflow('drop-head');
    const ref = sys.spawnAnonymous(typedActor<string>(behavior), options);

    ref.tell('p1');
    ref.tell('p2');
    await awaitCondition(() => parked.length === 2, { label: 'both messages were parked' });

    // Both parked, mailbox empty.  Now four in one burst: `ready` is taken
    // for the turn that unstashes, leaving x1..x3 queued on a capacity of 4.
    ref.tell('ready');
    ref.tell('x1');
    ref.tell('x2');
    ref.tell('x3');

    await awaitCondition(() => seen.length === 4, {
      timeoutMs: 4_000,
      label: 'the bounded mailbox delivered exactly its capacity',
    });
    // The assertion is an absence — `x3` must never arrive — so the wait has
    // to be elapsed time.  Polling `seen.length === 4` fires the instant it
    // reaches four and would pass with a fifth message still in flight, which
    // is exactly the pre-#772 behaviour this is meant to catch.
    await sleep(20);
    // One slot free, so `p2` cost the newest queued message rather than being
    // smuggled in past the bound.
    expect(seen).toEqual(['p1', 'p2', 'x1', 'x2']);
    await sys.terminate();
  });
});

/**
 * `withStash` took its capacity on trust, so a value that no comparison can
 * ever satisfy silently removed the bound the JSDoc promises (#795).  `NaN`
 * and `Infinity` are the ones that matter: `buffer.length >= capacity` is
 * false forever for both, so the buffer grows without limit *and* `isFull`
 * keeps answering `false` — no throw, no diagnostic, no ceiling.  Zero and
 * negatives fail the other way, leaving `stash()` throwing on its first call.
 *
 * These need no spawn, unlike every other stash test in this file: the guard
 * runs while the behavior is still a value, which is the point of putting it
 * in the combinator rather than only in the buffer.
 */
describe('Behaviors.withStash — capacity validation', () => {
  const innerBehavior = (): Behavior<string> =>
    Behaviors.receiveMessage(() => Behaviors.same);

  const rejected: readonly (readonly [string, number])[] = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['a negative', -1],
    ['a fractional', 2.5],
  ];

  for (const [label, capacity] of rejected) {
    test(`rejects ${label} capacity with an OptionsError`, () => {
      expect(() => Behaviors.withStash<string>(capacity, innerBehavior)).toThrow(OptionsError);
      // The field and the offending value travel on the error, so a caller
      // catching it can name the argument without parsing the message.
      try {
        Behaviors.withStash<string>(capacity, innerBehavior);
        throw new Error('unreachable — withStash should have thrown');
      } catch (e) {
        const error = e as OptionsError;
        expect(error.name).toBe('OptionsError');
        expect(error.field).toBe('capacity');
        expect(Object.is(error.value, capacity)).toBe(true);
      }
    });
  }

  test('accepts an integer capacity >= 1 and carries it onto the node', () => {
    const behavior = Behaviors.withStash<string>(1, innerBehavior);
    expect(behavior.kind).toBe('with-stash');
    expect((behavior as WithStashBehavior<string>).capacity).toBe(1);
  });

  /**
   * Defence in depth.  `WithStashBehavior` is exported from the package, so a
   * caller can write the node as a literal and hand it to `spawnTyped`
   * without the combinator's guard ever running — which is exactly the route
   * that would reinstate the unbounded buffer.  `StashBufferImplementation`
   * re-checks for that reason.
   *
   * Asserted on the log rather than on an absence: the rejection happens
   * inside `preStart`, so `ActorCell.onCreate` turns it into an
   * `ActorInitializationError` and records one `Actor initialization failed`
   * line.  Waiting for that line is a positive signal; waiting for "the
   * handler never ran" would pass on a tree with no guard at all.
   */
  test('re-checks a hand-built with-stash node that never went through the combinator', async () => {
    const lines: string[] = [];
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new JsonLogger(LogLevel.Error, '', {}, { write: (line) => { lines.push(line); } }));
    const sys = ActorSystem.create('typed-stash-bypass', sysOptions);

    const factoryCalls: string[] = [];
    const handled: string[] = [];
    const handWritten: WithStashBehavior<string> = {
      kind: 'with-stash',
      capacity: Number.NaN,
      factory: (): Behavior<string> => {
        factoryCalls.push('factory');
        return Behaviors.receiveMessage((message) => {
          handled.push(message);
          return Behaviors.same;
        });
      },
    };

    const ref = sys.spawnTypedAnonymous(handWritten);
    ref.tell('would-have-been-stashed');

    await awaitCondition(
      () => lines.some((line) => line.includes('capacity must be an integer >= 1')),
      { timeoutMs: 3_000, label: 'the hand-built with-stash node failed actor initialization' },
    );
    // The buffer is built before the inner behavior is, so a rejected capacity
    // means the user's factory never ran and no message was ever accepted.
    expect(factoryCalls.length).toBe(0);
    expect(handled).toEqual([]);

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

  test('a replay a reject mailbox refuses is dead-lettered, not lost (#772)', async () => {
    const sys = newSys('typed-stash-refused');
    const letters = await listenForDeadLetters(sys);
    const parked: string[] = [];
    const seen: string[] = [];

    const behavior = Behaviors.withStash<string>(16, (stash) => {
      const ready: Behavior<string> = Behaviors.receiveMessage((message) => {
        seen.push(message);
        return Behaviors.same;
      });
      return Behaviors.receiveMessage<string>((message) => {
        if (message === 'ready') { stash.unstashAll(); return ready; }
        stash.stash(message);
        parked.push(message);
        return Behaviors.same;
      });
    });

    const options = ActorOptions.create<string>()
      .withMailboxCapacity(4)
      .withMailboxOverflow('reject');
    const ref = sys.spawnAnonymous(typedActor<string>(behavior), options);

    ref.tell('p1');
    ref.tell('p2');
    await awaitCondition(() => parked.length === 2, { label: 'both messages were parked' });

    // One slot free once `ready` is taken for the turn, two envelopes offered:
    // `reject` refuses the batch whole.  The typed buffer emptied itself
    // before calling the cell and the cell owns nothing it could put back, so
    // dead letters are what keeps the refusal from being a disappearance.
    ref.tell('ready');
    ref.tell('x1');
    ref.tell('x2');
    ref.tell('x3');

    const mine = (): DeadLetter[] => letters.filter((l) => l.recipient.equals(ref));
    await awaitCondition(() => mine().length === 2, {
      timeoutMs: 4_000,
      label: 'the refused replay reached dead letters',
    });
    expect(mine().map((l) => l.message)).toEqual(['p1', 'p2']);
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

/**
 * `handleSupervise` used to consult only `strategy.decider`, so `maxRetries`
 * and `withinTimeRangeMs` were inert in the typed path and a behavior that
 * always threw restarted for ever inside one `TypedActor` — invisibly, because
 * swallowing the error also kept the cell's own budget from ever engaging
 * (#638).
 *
 * Past the budget the typed supervisor *escalates* rather than stopping: it is
 * a wrapper inside the failing actor, not a separate supervisor that would
 * stay around to observe a `Terminated`, so stopping here would discard the
 * error with nobody upstream any the wiser.  Every test below therefore reads
 * "budget exhausted" off the cell's strategy, which is where the escalation
 * lands.
 */
describe('Behaviors.supervise — the strategy restart budget (#638)', () => {
  /** Records each failure the typed level gave up on, and stops the actor. */
  const escalationsInto = (escalated: string[]): ActorOptions<string> =>
    ActorOptions.create<string>().withSupervisorStrategy(
      new OneForOneStrategy((error) => { escalated.push(error.message); return Directive.Stop; }),
    );

  /** Blows up on every message; one `init#n` entry per fresh resolve. */
  const alwaysThrows = (initializations: string[]): Behavior<string> =>
    Behaviors.setup<string>(() => {
      initializations.push(`init#${initializations.length + 1}`);
      return Behaviors.receiveMessage<string>(() => { throw new Error('always'); });
    });

  test('stops restarting in place once maxRetries is spent, and escalates instead', async () => {
    const sys = newSys('typed-supervise-budget');
    const initializations: string[] = [];
    const escalated: string[] = [];

    const behavior = Behaviors.supervise(alwaysThrows(initializations)).onFailure(
      new OneForOneStrategy(() => Directive.Restart, { maxRetries: 2, withinTimeRangeMs: 60_000 }),
    );
    const ref = sys.spawn(typedActor(behavior), 'budgeted', escalationsInto(escalated));

    ref.tell('a'); ref.tell('b'); ref.tell('c');
    await awaitCondition(() => escalated.length === 1, {
      timeoutMs: 4_000,
      label: 'the failure past the budget reached the cell',
    });

    // One initial resolve plus exactly two restarts.  Two rather than one is
    // the load-bearing number: the tally has to survive the restarts it counts,
    // or every failure would look like the first and nothing would ever bite.
    expect(initializations).toEqual(['init#1', 'init#2', 'init#3']);
    // The original error travels, not a budget-shaped substitute.
    expect(escalated).toEqual(['always']);

    // And it stays stopped — nothing revives it behind the assertion.
    ref.tell('d');
    // An absence: after the budget is spent the actor stays stopped, so this is
    // the window in which a revived one would have logged a fourth init.
    await sleep(60);
    expect(initializations).toEqual(['init#1', 'init#2', 'init#3']);
    await sys.terminate();
  });

  test('an ordinary transition inside the supervised child does not refill the budget', async () => {
    // Every message that does *not* fail still runs a resolve.  If that resolve
    // reset the allowance, a behavior that alternates work and crashes — the
    // shape a real crash-loop actually takes — would restart for ever.
    const sys = newSys('typed-supervise-budget-transitions');
    const initializations: string[] = [];
    const escalated: string[] = [];

    const workingThenCrashing = Behaviors.setup<string>(() => {
      initializations.push(`init#${initializations.length + 1}`);
      const step = (handled: number): Behavior<string> =>
        Behaviors.receiveMessage<string>((message) => {
          if (message === 'boom') throw new Error('crashed');
          return step(handled + 1); // a real transition, not `Behaviors.same`
        });
      return step(0);
    });

    const behavior = Behaviors.supervise(workingThenCrashing).onFailure(
      new OneForOneStrategy(() => Directive.Restart, { maxRetries: 2, withinTimeRangeMs: 60_000 }),
    );
    const ref = sys.spawn(typedActor(behavior), 'budget-transitions', escalationsInto(escalated));

    for (const message of ['work', 'boom', 'work', 'boom', 'work', 'boom']) ref.tell(message);
    await awaitCondition(() => escalated.length === 1, {
      timeoutMs: 4_000,
      label: 'the third crash escalated despite the transitions in between',
    });

    expect(initializations).toEqual(['init#1', 'init#2', 'init#3']);
    expect(escalated).toEqual(['crashed']);
    await sys.terminate();
  });

  test('maxRetries: 0 escalates the very first failure without restarting', async () => {
    const sys = newSys('typed-supervise-budget-zero');
    const initializations: string[] = [];
    const escalated: string[] = [];

    const behavior = Behaviors.supervise(alwaysThrows(initializations)).onFailure(
      new OneForOneStrategy(() => Directive.Restart, { maxRetries: 0, withinTimeRangeMs: 60_000 }),
    );
    const ref = sys.spawn(typedActor(behavior), 'budget-zero', escalationsInto(escalated));

    ref.tell('a');
    await awaitCondition(() => escalated.length === 1, {
      timeoutMs: 4_000,
      label: 'the first failure escalated',
    });
    expect(initializations).toEqual(['init#1']);
    await sys.terminate();
  });

  test('the unlimited default keeps restarting without bound', async () => {
    // `maxRetries: -1` is what a hand-built `OneForOneStrategy` defaults to and
    // what every other typed supervise test in this file relies on, so the
    // budget must stay entirely out of the way for it.
    const sys = newSys('typed-supervise-unlimited');
    const initializations: string[] = [];
    const escalated: string[] = [];

    const behavior = Behaviors.supervise(alwaysThrows(initializations)).onFailure(
      new OneForOneStrategy(() => Directive.Restart),
    );
    const ref = sys.spawn(typedActor(behavior), 'unbounded', escalationsInto(escalated));

    // Well past `defaultStrategy`'s 10, so a bound leaking in from anywhere
    // would surface as an escalation.
    for (let i = 0; i < 25; i++) ref.tell(`m${i}`);
    await awaitCondition(() => initializations.length === 26, {
      timeoutMs: 4_000,
      label: 'all 25 failures restarted in place',
    });
    expect(escalated).toEqual([]);
    await sys.terminate();
  });
});

/**
 * Two `supervise` wrappers used to collapse into one.  `resolve` held a single
 * slot for the active scope and overwrote it on every hop of the wrapper walk,
 * so after resolving `supervise(supervise(inner, sInner), sOuter)` the slot
 * held the *inner* node and `sOuter` was unreachable on every path — an inner
 * `Directive.Escalate` and an exhausted inner budget both jumped straight past
 * it to the cell (#638, #928).
 *
 * The scopes are a stack now: the innermost decides, a directive it declines
 * (`Escalate`, or a spent restart budget) hands the same error one scope out,
 * and only falling off the outermost leaves the actor.  A non-nested actor has
 * a one-entry stack and sees no change, which is what the budget block above
 * keeps honest.
 */
describe('Behaviors.supervise — nested scopes (#638, #928)', () => {
  /**
   * Records each failure that left the actor entirely, and stops it — the same
   * shape the budget block above uses, because "did this reach the cell" is the
   * question every test here asks in one direction or the other.
   */
  const cellRecordsAndStops = (escalated: string[]): ActorOptions<string> =>
    ActorOptions.create<string>().withSupervisorStrategy(
      new OneForOneStrategy((error) => { escalated.push(error.message); return Directive.Stop; }),
    );

  /** Blows up on every message; one `init#n` entry per fresh resolve. */
  const alwaysThrows = (initializations: string[]): Behavior<string> =>
    Behaviors.setup<string>(() => {
      initializations.push(`init#${initializations.length + 1}`);
      return Behaviors.receiveMessage<string>(() => { throw new Error('always'); });
    });

  /** Throws on `'boom'`, records everything else — "is the actor still alive". */
  const crashesOnBoom = (handled: string[], reason: string): Behavior<string> =>
    Behaviors.receiveMessage<string>((message) => {
      if (message === 'boom') throw new Error(reason);
      handled.push(message);
      return Behaviors.same;
    });

  /** A strategy that names itself in `consulted` when its decider runs. */
  const records = (consulted: string[], name: string, directive: Directive): OneForOneStrategy =>
    new OneForOneStrategy(() => { consulted.push(name); return directive; });

  test('an inner Escalate hands the failure to the enclosing supervise, not to the cell', async () => {
    const sys = newSys('typed-supervise-nested-escalate');
    const consulted: string[] = [];
    const handled: string[] = [];
    const escalated: string[] = [];

    const behavior = Behaviors.supervise(
      Behaviors.supervise(crashesOnBoom(handled, 'nested')).onFailure(
        records(consulted, 'inner', Directive.Escalate),
      ),
    ).onFailure(records(consulted, 'outer', Directive.Resume));
    const ref = sys.spawn(typedActor(behavior), 'nested-escalate', cellRecordsAndStops(escalated));

    ref.tell('boom');
    ref.tell('after');
    // Handling a message *after* the failure is the strongest available proof
    // that the outer `Resume` ran: had the error reached the cell, its `Stop`
    // would have killed the actor and nothing would follow.
    await awaitCondition(() => handled.length === 1, {
      timeoutMs: 4_000,
      label: 'the outer Resume swallowed the failure and the actor kept going',
    });

    expect(consulted).toEqual(['inner', 'outer']);
    expect(escalated).toEqual([]);
    expect(handled).toEqual(['after']);
    await sys.terminate();
  });

  test('the innermost scope decides — an outer Stop never runs when the inner Resumes', async () => {
    const sys = newSys('typed-supervise-nested-innermost');
    const consulted: string[] = [];
    const handled: string[] = [];
    const escalated: string[] = [];

    const behavior = Behaviors.supervise(
      Behaviors.supervise(crashesOnBoom(handled, 'nested')).onFailure(
        records(consulted, 'inner', Directive.Resume),
      ),
    ).onFailure(records(consulted, 'outer', Directive.Stop));
    const ref = sys.spawn(typedActor(behavior), 'nested-innermost', cellRecordsAndStops(escalated));

    ref.tell('boom');
    ref.tell('after');
    await awaitCondition(() => handled.length === 1, {
      timeoutMs: 4_000,
      label: 'the inner Resume swallowed the failure',
    });

    // A stack, not a chain of votes: the outer decider is not asked at all
    // once the inner one answers with something other than Escalate.
    expect(consulted).toEqual(['inner']);
    expect(escalated).toEqual([]);
    await sys.terminate();
  });

  test('an exhausted inner budget escalates to the enclosing scope, not to the cell', async () => {
    const sys = newSys('typed-supervise-nested-budget');
    const initializations: string[] = [];
    const outerDecisions: string[] = [];
    const escalated: string[] = [];

    const inner = Behaviors.supervise(alwaysThrows(initializations)).onFailure(
      new OneForOneStrategy(() => Directive.Restart, { maxRetries: 1, withinTimeRangeMs: 60_000 }),
    );
    const behavior = Behaviors.supervise(inner).onFailure(
      new OneForOneStrategy((error) => { outerDecisions.push(error.message); return Directive.Stop; }),
    );
    const ref = sys.spawn(typedActor(behavior), 'nested-budget', cellRecordsAndStops(escalated));

    ref.tell('a');
    ref.tell('b');
    await awaitCondition(() => outerDecisions.length === 1, {
      timeoutMs: 4_000,
      label: 'the failure past the inner budget reached the outer strategy',
    });

    // One initial resolve plus the single restart the inner budget granted.
    expect(initializations).toEqual(['init#1', 'init#2']);
    expect(outerDecisions).toEqual(['always']);
    expect(escalated).toEqual([]);
    await sys.terminate();
  });

  test('only falling off the outermost scope reaches the cell', async () => {
    const sys = newSys('typed-supervise-nested-off-the-end');
    const consulted: string[] = [];
    const handled: string[] = [];
    const escalated: string[] = [];

    const behavior = Behaviors.supervise(
      Behaviors.supervise(crashesOnBoom(handled, 'nested')).onFailure(
        records(consulted, 'inner', Directive.Escalate),
      ),
    ).onFailure(records(consulted, 'outer', Directive.Escalate));
    const ref = sys.spawn(typedActor(behavior), 'nested-off-the-end', cellRecordsAndStops(escalated));

    ref.tell('boom');
    await awaitCondition(() => escalated.length === 1, {
      timeoutMs: 4_000,
      label: 'the failure left the actor once no scope was left to try',
    });

    // Both wrappers get their say first — the cell is the end of the stack,
    // not a shortcut past the outer one.
    expect(consulted).toEqual(['inner', 'outer']);
    expect(escalated).toEqual(['nested']);
    await sys.terminate();
  });

  test('a restart the outer scope decided gives the inner scope a fresh budget', async () => {
    // Re-resolving the outer wrapper's child rebuilds the inner wrapper, so the
    // inner tally goes with it — the same reasoning that makes an interceptor
    // *inside* a `supervise` part of what restarts.  Two full inner budgets in
    // a row is what separates "reset" from "kept and immediately spent".
    const sys = newSys('typed-supervise-nested-restart');
    const initializations: string[] = [];
    const escalated: string[] = [];

    const inner = Behaviors.supervise(alwaysThrows(initializations)).onFailure(
      new OneForOneStrategy(() => Directive.Restart, { maxRetries: 1, withinTimeRangeMs: 60_000 }),
    );
    const behavior = Behaviors.supervise(inner).onFailure(
      new OneForOneStrategy(() => Directive.Restart, { maxRetries: 5, withinTimeRangeMs: 60_000 }),
    );
    const ref = sys.spawn(typedActor(behavior), 'nested-restart', cellRecordsAndStops(escalated));

    for (const message of ['a', 'b', 'c', 'd']) ref.tell(message);
    // Four failures: inner restart, outer restart, inner restart, outer restart
    // — five resolves in total, and none of them escalated out of the actor.
    await awaitCondition(() => initializations.length === 5, {
      timeoutMs: 4_000,
      label: 'the inner budget was refilled by each restart the outer scope granted',
    });

    expect(escalated).toEqual([]);
    await sys.terminate();
  });

  test('a supervise a running behavior returns nests inside the active scope', async () => {
    // The dynamic case, and the one where the old single slot was unambiguously
    // a bug rather than a documented design choice: the freshly installed
    // wrapper replaced the one the actor was already running under.
    const sys = newSys('typed-supervise-nested-dynamic');
    const consulted: string[] = [];
    const handled: string[] = [];
    const escalated: string[] = [];

    const installed = Behaviors.supervise(crashesOnBoom(handled, 'installed')).onFailure(
      records(consulted, 'inner', Directive.Escalate),
    );
    const behavior = Behaviors.supervise(
      Behaviors.receiveMessage<string>((message) => (message === 'install' ? installed : Behaviors.same)),
    ).onFailure(records(consulted, 'outer', Directive.Resume));
    const ref = sys.spawn(typedActor(behavior), 'nested-dynamic', cellRecordsAndStops(escalated));

    ref.tell('install');
    ref.tell('boom');
    ref.tell('after');
    await awaitCondition(() => handled.length === 1, {
      timeoutMs: 4_000,
      label: 'the scope installed at start-up still covered the failure',
    });

    expect(consulted).toEqual(['inner', 'outer']);
    expect(escalated).toEqual([]);
    await sys.terminate();
  });

  test('the scope still applies after the behavior transitions out of the wrapped subtree', async () => {
    // Deliberately pins the shipped contract rather than #928's literal wording
    // ("stops applying when the actor transitions out of it").  A `supervise`
    // wrapper contributes its side effect once and the framework remembers the
    // strategy for the actor's lifetime — the same rule `Behaviors.intercept`
    // documents, and the rule the budget test above depends on, since every
    // non-failing message it sends is a transition.  `Behaviors.stopped` is the
    // way out of a supervision scope; a transition is not.
    const sys = newSys('typed-supervise-outside-subtree');
    const consulted: string[] = [];
    const handled: string[] = [];
    const escalated: string[] = [];

    const behavior = Behaviors.supervise(
      Behaviors.receiveMessage<string>((message) =>
        (message === 'leave' ? crashesOnBoom(handled, 'after-leaving') : Behaviors.same)),
    ).onFailure(records(consulted, 'outer', Directive.Resume));
    const ref = sys.spawn(typedActor(behavior), 'outside-subtree', cellRecordsAndStops(escalated));

    ref.tell('leave');
    ref.tell('boom');
    ref.tell('after');
    await awaitCondition(() => handled.length === 1, {
      timeoutMs: 4_000,
      label: 'the strategy still covered a behavior reached by transition',
    });

    expect(consulted).toEqual(['outer']);
    expect(escalated).toEqual([]);
    await sys.terminate();
  });
});

describe('Behaviors.empty / Behaviors.ignore', () => {
  test('ignore silently drops all messages', async () => {
    const sys = newSys();
    const ref = sys.spawnTypedAnonymous(Behaviors.ignore);
    ref.tell('a' as never); ref.tell('b' as never);
    // An absence: `Behaviors.ignore` must drop both messages without failing the
    // actor, so the window is what would give a crash time to surface.
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

  test('and are counted, which routing to dead letters alone never did (#1178)', async () => {
    // `deadLetters.tell(...)` moves `actor_dead_letters_total` only from
    // inside `DeadLetterQueue._capture`, which returns immediately while the
    // store is `off` — and `off` is the shipped default.  So until the typed
    // path shared `recordUnhandled` with `Actor.unhandled`, a behavior
    // answering `unhandled` was invisible to metrics on every system nobody
    // had configured, which is most of them.
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('typed-unhandled-count', kitOptions);
    const registry = kit.system.extension(MetricsExtensionId).enable();
    const unhandledCount = (): number => registry.collect()
      .filter((s) => s.name === 'actor_unhandled_total' && s.labels['class'] === 'TypedActor')
      .reduce((total, s) => total + s.value, 0);

    const behavior = Behaviors.receiveMessage<string>((m) => m === 'yes' ? Behaviors.same : Behaviors.unhandled);
    const ref = kit.system.spawnTypedAnonymous(behavior);
    ref.tell('yes');
    ref.tell('no');

    await awaitCondition(() => unhandledCount() === 1, {
      timeoutMs: 4_000,
      label: 'the declined message was counted once',
    });
    // The handled one is not counted — the sentinel is the statement, not the
    // delivery.
    expect(unhandledCount()).toBe(1);
    expect(registry.collect().some((s) => s.name === 'actor_dead_letters_total')).toBe(false);
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
    // An absence: the parent stopped itself, so the message must be dropped and
    // `seen` must not grow.  Already true at t = 0, so only a window can show it.
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

/**
 * `signalHandler` was a one-way latch: `resolve` only ever *installed* one
 * (`if (n.onSignal) this.signalHandler = n.onSignal`), never cleared it.  So a
 * state machine written as `receiveWithSignal` → plain `receive` per state kept
 * the first state's handler for the rest of the actor's life, and every
 * `Terminated` went on being taken away from the receive handler (#928).
 *
 * The handler belongs to the `receive` node that declared it now, so adopting a
 * `receive` that declares none unregisters it.  The sentinels are deliberately
 * exempt: `Behaviors.stopped` declares no signals, and a `post-stop` handler
 * that stopped working the moment the actor stopped itself would be useless.
 */
describe('Behaviors.receiveWithSignal — the handler follows the behavior that declared it (#928)', () => {
  test('transitioning to a receive without onSignal unregisters the handler', async () => {
    const sys = newSys('typed-signal-scope');
    const seen: string[] = [];
    let child: ActorRef<string> | null = null;

    const parent: Behavior<unknown> = Behaviors.setup<unknown>((context) => {
      child = context.spawn(Behaviors.receiveMessage<string>(() => Behaviors.same), 'kid');
      context.watch(child);
      const signalFree = Behaviors.receiveMessage<unknown>((message) => {
        seen.push(message instanceof Terminated ? `terminated-as-message:${message.actor.path.name}` : 'plain');
        return Behaviors.same;
      });
      return Behaviors.receiveWithSignal<unknown>(
        (_context, message) => (message === 'drop-signals' ? signalFree : Behaviors.same),
        (_context, signal) => { seen.push(`signal:${signal.kind}`); return Behaviors.same; },
      );
    });

    const ref = sys.spawn(typedActor(parent), 'parent');
    await awaitCondition(() => child !== null, {
      timeoutMs: 4_000,
      label: 'the parent behavior spawned its child',
    });

    ref.tell('drop-signals');
    ref.tell('probe');
    // The probe is what makes the rest deterministic: the death must not race
    // the transition, and `'plain'` is only ever recorded by the behavior the
    // transition adopted.
    await awaitCondition(() => seen.includes('plain'), {
      timeoutMs: 4_000,
      label: 'the signal-free behavior became current',
    });

    child!.stop();
    await awaitCondition(() => seen.length === 2, {
      timeoutMs: 4_000,
      label: 'the death of the watched child arrived somewhere',
    });

    // `terminate()` stops the parent and awaits it, so a `post-stop` the stale
    // handler would have fired has already had its chance by the next line —
    // which makes the absence below an assertion rather than a hope.
    await sys.terminate();
    expect(seen).toEqual(['plain', 'terminated-as-message:kid']);
  });

  test('re-declaring onSignal in the next state keeps the signals coming', async () => {
    // The migration path for the change above, and the reason it is safe to
    // make: a state that wants signals says so, exactly as `Behaviors.receive`
    // has always advertised.
    const sys = newSys('typed-signal-scope-redeclared');
    const seen: string[] = [];
    let child: ActorRef<string> | null = null;

    const parent: Behavior<string> = Behaviors.setup<string>((context) => {
      child = context.spawn(Behaviors.receiveMessage<string>(() => Behaviors.same), 'kid');
      context.watch(child);
      const second = Behaviors.receiveWithSignal<string>(
        () => Behaviors.same,
        (_context, signal) => { seen.push(`second:${signal.kind}`); return Behaviors.same; },
      );
      return Behaviors.receiveWithSignal<string>(
        (_context, message) => (message === 'advance' ? second : Behaviors.same),
        (_context, signal) => { seen.push(`first:${signal.kind}`); return Behaviors.same; },
      );
    });

    const ref = sys.spawn(typedActor(parent), 'parent');
    await awaitCondition(() => child !== null, {
      timeoutMs: 4_000,
      label: 'the parent behavior spawned its child',
    });

    ref.tell('advance');
    child!.stop();
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the terminated signal reached one of the two handlers',
    });

    expect(seen).toEqual(['second:terminated']);
    await sys.terminate();
  });

  test('a transition to Behaviors.stopped keeps the handler, so post-stop still fires', async () => {
    // The counterpart a blanket "clear it on every resolve" would break: the
    // `stopped` sentinel is not a `receive` node, so it never reaches the arm
    // that owns the field, and the handler it was adopted from is still the one
    // that asked to hear about the stop.
    const sys = newSys('typed-signal-scope-stopped');
    const seen: string[] = [];

    const behavior = Behaviors.receiveWithSignal<string>(
      (_context, message) => (message === 'die' ? Behaviors.stopped : Behaviors.same),
      (_context, signal) => { seen.push(signal.kind); return Behaviors.same; },
    );
    const ref = sys.spawn(typedActor(behavior), 'stopper');

    ref.tell('die');
    await awaitCondition(() => seen.includes('post-stop'), {
      timeoutMs: 4_000,
      label: 'post-stop reached the handler the stopped behavior came from',
    });

    expect(seen).toEqual(['post-stop']);
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
