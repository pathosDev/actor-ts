import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorPath } from '../../src/ActorPath.js';
import { ActorRef } from '../../src/ActorRef.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { EventKey } from '../../src/EventKey.js';
import { MAX_EVENT_STREAM_CALLBACK_DEPTH } from '../../src/Constants.js';
import { EventStream } from '../../src/EventStream.js';
import type { EventStream as RootEventStream } from '../../src/index.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ActorStarted, ActorStopped, DeadLetter } from '../../src/SystemMessages.js';
import { gracefulStop } from '../../src/pattern/GracefulStop.js';
import { assertCompletesWithin } from '../util/AsyncAssertions.js';
import { awaitCondition } from '../util/AwaitCondition.js';

/*
 * `EventStream.subscribeFunction` (#1433): a callback on the bus, with no actor
 * behind it.  Every subscriber used to be an actor somebody had to spawn, name
 * and stop, and the one helper that looked like a callback API spawned one
 * behind the caller's back.  The callback runs inside `publish`, on the
 * publisher's stack — which is what makes it cheap, and what every rule below
 * exists to keep safe.
 */

class EventA { constructor(public readonly payload: string) {} }
class EventB { constructor(public readonly payload: number) {} }

type UserLoggedInEvent = { readonly kind: 'user-logged-in'; readonly userId: string };
const UserLoggedInEvent = EventKey.of<UserLoggedInEvent>('user-logged-in');

/** Minimal ref that records what it receives. */
class RecordingRef extends ActorRef<unknown> {
  readonly path: ActorPath;
  readonly received: unknown[] = [];
  constructor(pathName: string) {
    super();
    this.path = new ActorPath('', null, 'test-sys').child(pathName);
  }
  tell(message: unknown): void { this.received.push(message); }
}

/** A ref that writes into a log it shares with the callbacks, so the delivery order is observable. */
class OrderRecordingRef extends ActorRef<unknown> {
  readonly path: ActorPath;
  constructor(pathName: string, private readonly order: string[]) {
    super();
    this.path = new ActorPath('', null, 'test-sys').child(pathName);
  }
  tell(message: unknown): void {
    this.order.push(`ref:${(message as object).constructor.name}`);
  }
}

/** The bus's warnings and debug lines, so a test can tell "reported" from "swallowed". */
function recordLog(bus: EventStream): { warnings: string[]; debugLines: string[] } {
  const warnings: string[] = [];
  const debugLines: string[] = [];
  bus.log = {
    warn: (message: string) => { warnings.push(message); },
    debug: (message: string) => { debugLines.push(message); },
  };
  return { warnings, debugLines };
}

function quietSystemOptions() {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
}

/** True only when `A` and `B` are the same type — assignability in one direction is not enough. */
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

describe('EventStream.subscribeFunction delivers to a plain callback', () => {
  test('a matching event reaches the callback before publish returns', () => {
    const bus = new EventStream();
    const seen: EventA[] = [];
    bus.subscribeFunction(EventA, (event) => { seen.push(event); });

    const event = new EventA('hello');
    bus.publish(event);
    expect(seen).toEqual([event]);
    bus.publish(new EventB(1));
    expect(seen).toEqual([event]);
  });

  test('a kind channel works in both spellings, and the key types the callback', () => {
    const bus = new EventStream();
    const byKey: string[] = [];
    const byString: unknown[] = [];
    bus.subscribeFunction(UserLoggedInEvent, (event) => { byKey.push(event.userId); });
    bus.subscribeFunction('user-logged-in', (event) => { byString.push(event); });

    bus.publish({ kind: 'user-logged-in', userId: 'user-42' });
    expect(byKey).toEqual(['user-42']);
    expect(byString).toEqual([{ kind: 'user-logged-in', userId: 'user-42' }]);
  });

  test('every call is a subscription of its own, even for the same function', () => {
    // No dedup: the handle is the only way to name a subscription, so two
    // calls are two handles, and each removes its own.
    const bus = new EventStream();
    let calls = 0;
    const count = (): void => { calls++; };
    const removeFirst = bus.subscribeFunction(EventA, count);
    bus.subscribeFunction(EventA, count);

    bus.publish(new EventA('x'));
    expect(calls).toBe(2);
    removeFirst();
    bus.publish(new EventA('y'));
    expect(calls).toBe(3);
  });

  test('the handle removes exactly its own subscription, and a second call does nothing', () => {
    const bus = new EventStream();
    const seen: string[] = [];
    const removeFirst = bus.subscribeFunction(EventA, (event) => { seen.push(`first:${event.payload}`); });
    bus.subscribeFunction(EventA, (event) => { seen.push(`second:${event.payload}`); });

    removeFirst();
    removeFirst();
    bus.publish(new EventA('x'));
    expect(seen).toEqual(['second:x']);
  });

  test('callbacks run after the actor subscribers, so an event a callback causes reaches actors second', () => {
    const bus = new EventStream();
    const order: string[] = [];
    const listener = new OrderRecordingRef('listener', order);
    bus.subscribe(listener, EventA);
    bus.subscribe(listener, EventB);
    bus.subscribeFunction(EventA, (event) => {
      order.push(`callback:${event.payload}`);
      bus.publish(new EventB(1));
    });

    bus.publish(new EventA('x'));
    expect(order).toEqual(['ref:EventA', 'callback:x', 'ref:EventB']);
  });

  test('unsubscribe, which every actor stop calls, leaves callbacks alone', () => {
    const bus = new EventStream();
    const seen: string[] = [];
    bus.subscribeFunction(EventA, (event) => { seen.push(event.payload); });
    const listener = new RecordingRef('listener');
    bus.subscribe(listener, EventA);

    expect(bus.unsubscribe(listener)).toBe(true);
    expect(bus.unsubscribe(listener)).toBe(false);
    bus.publish(new EventA('x'));
    expect(seen).toEqual(['x']);
  });

  test('hasSubscribers counts a callback, in and out', () => {
    const bus = new EventStream();
    expect(bus.hasSubscribers).toBe(false);
    const remove = bus.subscribeFunction(EventA, () => {});
    expect(bus.hasSubscribers).toBe(true);
    remove();
    expect(bus.hasSubscribers).toBe(false);
  });

  test('a callback alone is enough for actor starts and stops to be published', async () => {
    // `ActorCell` builds ActorStarted and ActorStopped only when
    // `hasSubscribers` says somebody listens; a callback has to count.
    const system = ActorSystem.create('es-callback-lifecycle', quietSystemOptions());
    const started: ActorStarted[] = [];
    const stopped: ActorStopped[] = [];
    system.eventStream.subscribeFunction(ActorStarted, (event) => { started.push(event); });
    system.eventStream.subscribeFunction(ActorStopped, (event) => { stopped.push(event); });

    class Quiet extends Actor<string> {
      override onReceive(): void {}
    }
    const ref = system.spawn(Quiet, 'observed');
    await awaitCondition(() => started.some((event) => event.actor.equals(ref)), {
      timeoutMs: 2_000,
      label: 'the callback saw the actor start',
    });
    expect(await gracefulStop(ref, 1_000)).toBe(true);
    // ActorStopped is published before the watchers are told, and the callback
    // runs inside that publish.
    expect(stopped.filter((event) => event.actor.equals(ref))).toHaveLength(1);
    await system.terminate();
  });
});

// The recipient rule is `Cluster.subscribe`'s (#1294): an event goes to the
// callbacks subscribed when it was published and still subscribed when their
// turn comes.  The second half is where a callback differs from a ref, whose
// one last event lands in dead letters: a callback has no mailbox, so a late
// call would run code its owner has already torn down.
describe('EventStream.subscribeFunction while an event is being delivered', () => {
  test('a callback subscribed during delivery starts with the next event', () => {
    const bus = new EventStream();
    const late: string[] = [];
    let subscribedLate = false;
    bus.subscribeFunction(EventA, () => {
      if (subscribedLate) return;
      subscribedLate = true;
      bus.subscribeFunction(EventA, (event) => { late.push(event.payload); });
    });

    bus.publish(new EventA('in flight'));
    expect(late).toEqual([]);
    bus.publish(new EventA('next'));
    expect(late).toEqual(['next']);
  });

  test('a callback whose handle ran during delivery is not called with the event in flight', () => {
    const bus = new EventStream();
    const seen: string[] = [];
    let removeSecond = (): void => {};
    bus.subscribeFunction(EventA, () => { removeSecond(); });
    removeSecond = bus.subscribeFunction(EventA, (event) => { seen.push(event.payload); });

    bus.publish(new EventA('x'));
    expect(seen).toEqual([]);
  });

  test('a callback that removes itself sees that event once and no later one', () => {
    const bus = new EventStream();
    const seen: string[] = [];
    const remove = bus.subscribeFunction(EventA, (event) => {
      seen.push(event.payload);
      remove();
    });

    bus.publish(new EventA('first'));
    bus.publish(new EventA('second'));
    expect(seen).toEqual(['first']);
  });
});

// A ref subscription ends when its actor stops.  A callback has no actor, so
// the end of the system is what ends it: after the shutdown's own events,
// before `terminate()` resolves.  Without that, a callback went on being
// called — by a late publish, by a dead letter — after the system was gone.
describe('EventStream.subscribeFunction and the end of the system', () => {
  class Quiet extends Actor<string> {
    override onReceive(): void {}
  }

  /** Spawn a `Quiet` actor and wait until its start has been published. */
  async function spawnStarted(system: ActorSystem, name: string): Promise<ActorRef<string>> {
    const started: ActorStarted[] = [];
    const remove = system.eventStream.subscribeFunction(ActorStarted, (event) => { started.push(event); });
    const ref = system.spawn(Quiet, name);
    await awaitCondition(() => started.some((event) => event.actor.equals(ref)), {
      timeoutMs: 2_000,
      label: `${name} started`,
    });
    remove();
    return ref;
  }

  test('a callback sees the shutdown, and nothing once terminate() has resolved', async () => {
    const system = ActorSystem.create('es-callback-terminate', quietSystemOptions());
    const stopped: ActorStopped[] = [];
    const late: string[] = [];
    system.eventStream.subscribeFunction(ActorStopped, (event) => { stopped.push(event); });
    const remove = system.eventStream.subscribeFunction(EventA, (event) => {
      late.push(`EventA ${event.payload}`);
    });
    system.eventStream.subscribeFunction(DeadLetter, (event) => {
      late.push(`DeadLetter to ${event.recipient.path.toString()}`);
    });
    const ref = await spawnStarted(system, 'stopped-by-the-shutdown');

    await assertCompletesWithin(system.terminate(), 2_000, 'terminate() with callbacks subscribed');
    expect(stopped.some((event) => event.actor.equals(ref))).toBe(true);

    // Whatever the shutdown itself dead-lettered was its own business.
    late.length = 0;
    system.eventStream.publish(new EventA('after the end'));
    ref.tell('to an actor the shutdown stopped');
    expect(late).toEqual([]);
    expect(system.eventStream.hasSubscribers).toBe(false);
    // The handle outlives the subscription it named, and does nothing.
    expect(() => remove()).not.toThrow();
  });

  test('a callback subscribed while the system terminates still sees the shutdown', async () => {
    // The actor-free form needs no spawn, so it is not refused here the way
    // an actor spawned to listen would be.
    const system = ActorSystem.create('es-callback-terminating', quietSystemOptions());
    const ref = await spawnStarted(system, 'stopped-while-listened-to');
    const terminated = system.terminate();
    const stopped: ActorStopped[] = [];
    system.eventStream.subscribeFunction(ActorStopped, (event) => { stopped.push(event); });

    await assertCompletesWithin(terminated, 2_000, 'terminate() with a callback subscribed during it');
    expect(stopped.some((event) => event.actor.equals(ref))).toBe(true);
    const seenByTheEnd = stopped.length;
    system.eventStream.publish(new ActorStopped(ref));
    expect(stopped).toHaveLength(seenByTheEnd);
  });

  test('no callback runs once the system reports itself terminated', async () => {
    // `terminate()` resolves only after the system has flushed its logger (and
    // its dead-letter queue, when it keeps one), and whatever is still running
    // may publish during that flush.  `isTerminated` is already true there, so
    // the end has to have come first, not with the promise.
    const seen: string[] = [];
    const terminatedWhileClosing: boolean[] = [];
    let system: ActorSystem | undefined;
    class PublishingOnCloseLogger extends NoopLogger {
      async close(): Promise<void> {
        if (system === undefined) return;
        terminatedWhileClosing.push(system.isTerminated);
        system.eventStream.publish(new EventA('while the logger closes'));
      }
    }
    const options = ActorSystemOptions.create()
      .withLogger(new PublishingOnCloseLogger())
      .withLogLevel(LogLevel.Off);
    system = ActorSystem.create('es-callback-logger-close', options);
    system.eventStream.subscribeFunction(EventA, (event) => { seen.push(event.payload); });

    await assertCompletesWithin(system.terminate(), 2_000, 'terminate() with a closing logger');
    expect(terminatedWhileClosing).toEqual([true]);
    expect(seen).toEqual([]);
  });

  test('a terminated system refuses a new callback subscription', async () => {
    // Nothing would ever end it: the end it waits for has happened.
    const system = ActorSystem.create('es-callback-refused', quietSystemOptions());
    await assertCompletesWithin(system.terminate(), 2_000, 'terminate() of an idle system');
    expect(() => system.eventStream.subscribeFunction(EventA, () => {}))
      .toThrow(/^EventStream\.subscribeFunction: .*terminated/);
    expect(system.eventStream.hasSubscribers).toBe(false);
  });

  test('the end reaches a delivery already in flight', () => {
    const bus = new EventStream();
    const seen: string[] = [];
    bus.subscribeFunction(EventA, () => { bus._endCallbackSubscriptions(); });
    bus.subscribeFunction(EventA, (event) => { seen.push(event.payload); });

    bus.publish(new EventA('x'));
    expect(seen).toEqual([]);
    expect(bus.hasSubscribers).toBe(false);
  });

  test('the end leaves the actor subscriptions alone', () => {
    // A ref subscription ends with its actor, which is not the bus's call.
    const bus = new EventStream();
    const listener = new RecordingRef('listener');
    bus.subscribe(listener, EventA);
    bus.subscribeFunction(EventA, () => {});

    bus._endCallbackSubscriptions();
    bus.publish(new EventA('x'));
    expect(listener.received).toHaveLength(1);
    expect(bus.hasSubscribers).toBe(true);
  });
});

describe('EventStream.subscribeFunction contains a failing callback', () => {
  test('a throwing callback is reported and skipped; everyone else still gets the event', () => {
    const bus = new EventStream();
    const { warnings } = recordLog(bus);
    const listener = new RecordingRef('listener');
    bus.subscribe(listener, EventA);
    let thrown = 0;
    bus.subscribeFunction(EventA, function exploding() {
      thrown++;
      throw new Error('callback boom');
    });
    const seen: string[] = [];
    bus.subscribeFunction(EventA, (event) => { seen.push(event.payload); });

    expect(() => bus.publish(new EventA('x'))).not.toThrow();
    expect(seen).toEqual(['x']);
    expect(listener.received).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('callback exploding');
    expect(warnings[0]).toContain('EventA');

    // A throw is that delivery's failure, not the subscription's end.
    bus.publish(new EventA('y'));
    expect(thrown).toBe(2);
  });

  test('a callback that returns a rejected promise is reported rather than left unhandled', async () => {
    // The bus does not await a callback.  It only keeps the rejection from
    // becoming an unhandled one, which Node turns into a process exit.
    const bus = new EventStream();
    const { warnings } = recordLog(bus);
    bus.subscribeFunction(EventA, async function storing() {
      throw new Error('async boom');
    });

    expect(() => bus.publish(new EventA('x'))).not.toThrow();
    await awaitCondition(() => warnings.length > 0, {
      timeoutMs: 1_000,
      label: 'the rejection was reported',
    });
    expect(warnings[0]).toContain('callback storing');
  });

  test('a channel whose instanceof throws at delivery reaches no spawn, stop or terminate()', async () => {
    // Subscribing checks a channel's shape, not its behaviour: `instanceof`
    // runs the channel's own `Symbol.hasInstance`, so this one passes the
    // subscribe and throws on every event after it.  On a running system the
    // first such event is an actor start, and the hardest one is the stop,
    // published from inside the actor's termination.  Contained, each throw is
    // one skipped callback and one warning.  Uncontained, it left `publish` out
    // of that termination — `terminate()` never settled — and the callbacks
    // behind this one in the list missed the event.
    const system = ActorSystem.create('es-callback-throwing-channel', quietSystemOptions());
    const { warnings } = recordLog(system.eventStream);
    const throwingChannel = {
      [Symbol.hasInstance](_candidate: unknown): boolean { throw new Error('hasInstance boom'); },
    };
    let throwingChannelCalls = 0;
    system.eventStream.subscribeFunction(throwingChannel as never, () => { throwingChannelCalls++; });
    // Subscribed second, so it is reached only if the throw stayed contained.
    const started: ActorStarted[] = [];
    system.eventStream.subscribeFunction(ActorStarted, (event) => { started.push(event); });

    class Quiet extends Actor<string> {
      override onReceive(): void {}
    }
    const first = system.spawn(Quiet, 'first');
    await awaitCondition(() => started.some((event) => event.actor.equals(first)), {
      timeoutMs: 2_000,
      label: 'the start reached the callback behind the throwing channel',
    });
    expect(await gracefulStop(first, 1_000)).toBe(true);
    const second = system.spawn(Quiet, 'second');
    await awaitCondition(() => started.some((event) => event.actor.equals(second)), {
      timeoutMs: 2_000,
      label: 'a start after the stop still reached it',
    });
    expect(() => system.eventStream.publish(new EventA('direct'))).not.toThrow();
    await assertCompletesWithin(system.terminate(), 2_000, 'terminate() with a channel whose instanceof throws');

    expect(throwingChannelCalls).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.filter((warning) => !warning.includes('matching an event against an unnamed channel threw')))
      .toEqual([]);
  });
});

describe('EventStream.subscribeFunction bounds a callback that publishes', () => {
  test('a callback publishing on its own channel is cut at the bound, with one warning', () => {
    const bus = new EventStream();
    const { warnings } = recordLog(bus);
    let calls = 0;
    bus.subscribeFunction(EventA, (event) => {
      calls++;
      bus.publish(new EventA(event.payload));
    });

    expect(() => bus.publish(new EventA('loop'))).not.toThrow();
    expect(calls).toBe(MAX_EVENT_STREAM_CALLBACK_DEPTH);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('EventA');
  });

  test('a chain exactly as deep as the bound is delivered in full, and one level more is not', () => {
    const chain = (levels: number): { reached: number; warnings: string[] } => {
      const bus = new EventStream();
      const { warnings } = recordLog(bus);
      let reached = 0;
      for (let level = 1; level <= levels; level++) {
        bus.subscribeFunction(`level-${level}`, () => {
          reached = level;
          if (level < levels) bus.publish({ kind: `level-${level + 1}` });
        });
      }
      bus.publish({ kind: 'level-1' });
      return { reached, warnings };
    };

    expect(chain(MAX_EVENT_STREAM_CALLBACK_DEPTH))
      .toEqual({ reached: MAX_EVENT_STREAM_CALLBACK_DEPTH, warnings: [] });
    const deeper = chain(MAX_EVENT_STREAM_CALLBACK_DEPTH + 1);
    expect(deeper.reached).toBe(MAX_EVENT_STREAM_CALLBACK_DEPTH);
    expect(deeper.warnings).toHaveLength(1);
  });

  test('past the bound the bus warns once, however many callbacks it skips', () => {
    const bus = new EventStream();
    const { warnings } = recordLog(bus);
    let echoes = 0;
    let bystanders = 0;
    bus.subscribeFunction(EventA, (event) => {
      echoes++;
      bus.publish(new EventA(event.payload));
    });
    bus.subscribeFunction(EventA, () => { bystanders++; });

    bus.publish(new EventA('loop'));
    expect(warnings).toHaveLength(1);
    // Every level below the bound still reached both of them.
    expect(echoes).toBe(MAX_EVENT_STREAM_CALLBACK_DEPTH);
    expect(bystanders).toBe(MAX_EVENT_STREAM_CALLBACK_DEPTH);
  });

  test('past the bound the actor subscribers still receive every event', () => {
    // The bound protects the publisher's stack from callbacks.  An actor is
    // reached through its mailbox and adds no depth, so it is not cut off.
    const bus = new EventStream();
    recordLog(bus);
    const listener = new RecordingRef('listener');
    bus.subscribe(listener, EventA);
    bus.subscribeFunction(EventA, (event) => { bus.publish(new EventA(event.payload)); });

    bus.publish(new EventA('loop'));
    // The outermost publish, plus one per callback call.
    expect(listener.received).toHaveLength(MAX_EVENT_STREAM_CALLBACK_DEPTH + 1);
  });

  /**
   * `callbackCount` callbacks on one channel, each publishing on it
   * `publishesPerCall` times per call, plus an actor subscriber counting what
   * reaches it.  The fixture stops publishing after `CALL_CAP` calls: the loop
   * is synchronous, so a bus that does not bound it would hold the runner far
   * past any per-test timeout, which cannot interrupt it — capped, it fails on
   * the count instead.
   */
  function loopOf(callbackCount: number, publishesPerCall: number): {
    calls: number; warnings: number; actorReceived: number;
  } {
    const CALL_CAP = 10_000;
    const bus = new EventStream();
    const { warnings } = recordLog(bus);
    const listener = new RecordingRef('listener');
    bus.subscribe(listener, EventA);
    let calls = 0;
    for (let callback = 0; callback < callbackCount; callback++) {
      bus.subscribeFunction(EventA, (event) => {
        calls++;
        if (calls >= CALL_CAP) return;
        for (let publish = 0; publish < publishesPerCall; publish++) bus.publish(new EventA(event.payload));
      });
    }
    bus.publish(new EventA('loop'));
    return { calls, warnings: warnings.length, actorReceived: listener.received.length };
  }

  // A bound on depth alone is a bound on one path through the loop, and the
  // loop has as many paths as callbacks or publishes per call allow: two
  // callbacks made 131 070 calls and 65 536 warnings of one publish, three made
  // 64 570 080 calls.  The bound now cuts the cascade it is reached in, so the
  // count follows from two rules.  Everything published below the bound
  // reaches every callback that wants it: the first descent is sixteen calls,
  // and on the way back up each of the 15 nested levels calls the other
  // k - 1 callbacks once.  Nothing the cascade publishes after the cut reaches
  // a callback, which is why the publishes per call stop mattering.  The
  // outermost publish gives each of its k callbacks a cascade of its own:
  // k * (16 + 15 * (k - 1)) calls and k warnings.  The actor subscriber still
  // receives everything — the outermost event, and every publish of every call.
  const loopShapes: ReadonlyArray<readonly [string, number, number, { calls: number; warnings: number; actorReceived: number }]> = [
    ['one callback publishing twice per call', 1, 2, { calls: 16, warnings: 1, actorReceived: 33 }],
    ['two callbacks publishing once per call', 2, 1, { calls: 62, warnings: 2, actorReceived: 63 }],
    ['three callbacks publishing once per call', 3, 1, { calls: 138, warnings: 3, actorReceived: 139 }],
  ];

  test.each(loopShapes)('the bound limits the work of %s, not only its depth', (_label, callbackCount, publishesPerCall, expected) => {
    expect(loopOf(callbackCount, publishesPerCall)).toEqual(expected);
  });

  test('a cut cascade leaves the cascades of the other callbacks alone', () => {
    // The outermost event reaches every callback, and what each of them
    // publishes in turn is its own cascade.  The looping callback's cut ends
    // its own cascade only: the callback behind it still publishes for the
    // outermost event, and that publish still reaches its callback.  What it
    // published for the looping cascade's echoes did not.
    const bus = new EventStream();
    const { warnings } = recordLog(bus);
    bus.subscribeFunction(EventA, () => { bus.publish(new EventA('echo')); });
    bus.subscribeFunction(EventA, (event) => { bus.publish(new EventB(event.payload.length)); });
    const forwarded: number[] = [];
    bus.subscribeFunction(EventB, (event) => { forwarded.push(event.payload); });

    bus.publish(new EventA('outermost'));
    expect(forwarded).toEqual(['outermost'.length]);
    expect(warnings).toHaveLength(1);
  });

  test('a cut does not carry over into the next cascade, not even into its channel match', () => {
    // Matching runs the channel's own code, before the callback is called, and
    // that code can publish.  It runs for the next callback of the outermost
    // publish, so it belongs to that callback's cascade, not to the cut one.
    const bus = new EventStream();
    recordLog(bus);
    bus.subscribeFunction(EventA, () => { bus.publish(new EventA('echo')); });
    const publishingChannel = {
      [Symbol.hasInstance](candidate: unknown): boolean {
        if (candidate instanceof EventA && candidate.payload === 'outermost') bus.publish(new EventB(1));
        return false;
      },
    };
    bus.subscribeFunction(publishingChannel as never, () => {});
    const announced: number[] = [];
    bus.subscribeFunction(EventB, (event) => { announced.push(event.payload); });

    bus.publish(new EventA('outermost'));
    expect(announced).toEqual([1]);
  });

  test('the bound starts again with every outermost publish', () => {
    const bus = new EventStream();
    const { warnings } = recordLog(bus);
    let calls = 0;
    bus.subscribeFunction(EventA, (event) => {
      calls++;
      bus.publish(new EventA(event.payload));
    });

    bus.publish(new EventA('first loop'));
    bus.publish(new EventA('second loop'));
    expect(calls).toBe(2 * MAX_EVENT_STREAM_CALLBACK_DEPTH);
    expect(warnings).toHaveLength(2);
  });

  test('a logger that throws does not leave the depth raised', () => {
    // The warning for a throwing callback used to run outside any guard, so a
    // logger that threw left the delivery loop through it.  The warning is
    // guarded now and nothing escapes, but the depth is the thing that must
    // never stay raised: every later publish would find the bound reached.
    const bus = new EventStream();
    bus.log = { warn: () => { throw new Error('logger boom'); } };
    const remove = bus.subscribeFunction(EventA, () => { throw new Error('callback boom'); });
    for (let attempt = 0; attempt < MAX_EVENT_STREAM_CALLBACK_DEPTH; attempt++) {
      expect(() => bus.publish(new EventA('x'))).not.toThrow();
    }
    remove();

    let calls = 0;
    bus.subscribeFunction(EventA, () => { calls++; });
    bus.publish(new EventA('y'));
    expect(calls).toBe(1);
  });
});

describe('EventStream.subscribeFunction refuses what it cannot deliver to', () => {
  const notCallbacks: ReadonlyArray<readonly [string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'onEvent'],
    ['a plain object', {}],
    ['an ActorRef', new RecordingRef('a-ref')],
  ];

  test.each(notCallbacks)('refuses %s as the callback with a TypeError', (_label, candidate) => {
    const bus = new EventStream();
    expect(() => bus.subscribeFunction(EventA, candidate as never))
      .toThrow(/^EventStream\.subscribeFunction: callback must be a function/);
    expect(bus.hasSubscribers).toBe(false);
  });

  test('an ActorRef in the callback slot is pointed at subscribe', () => {
    const bus = new EventStream();
    expect(() => bus.subscribeFunction(EventA, new RecordingRef('a-ref') as never))
      .toThrow(/subscribe\(ref, channel\)/);
  });

  // `subscribe` takes the subscriber first and `subscribeFunction` the channel
  // first, so the likeliest slip is the callback in front.  With a class as the
  // channel it used to pass both checks — a class is a function, and every
  // function is a usable `instanceof` target — and was stored: an arrow callback
  // in the channel slot warned on every publish of every event for the life of
  // the system, and a function expression matched nothing and said nothing.
  const swappedCalls: ReadonlyArray<readonly [string, (bus: EventStream) => unknown]> = [
    ['an arrow callback in front of a class', (bus) => bus.subscribeFunction(
      ((_event: EventA) => {}) as never, EventA as never)],
    ['a function expression in front of a class', (bus) => bus.subscribeFunction(
      function onEvent(_event: EventA) {} as never, EventA as never)],
    ['a callback in front of a key', (bus) => bus.subscribeFunction(
      ((_event: UserLoggedInEvent) => {}) as never, UserLoggedInEvent as never)],
    ['a callback in front of a kind string', (bus) => bus.subscribeFunction(
      ((_event: UserLoggedInEvent) => {}) as never, 'user-logged-in' as never)],
  ];

  test.each(swappedCalls)('refuses %s, naming the order', (_label, subscribeSwapped) => {
    const bus = new EventStream();
    expect(() => subscribeSwapped(bus))
      .toThrow(/^EventStream\.subscribeFunction: callback must be a function — got .*subscribeFunction\(channel, callback\)/);
    expect(bus.hasSubscribers).toBe(false);
  });

  test('a class is refused as the callback wherever it comes from, by name', () => {
    const bus = new EventStream();
    expect(() => bus.subscribeFunction(EventA, EventB as never)).toThrow(/got the class EventB/);
    expect(() => bus.subscribeFunction(EventA, class {} as never)).toThrow(/got an anonymous class/);
    expect(bus.hasSubscribers).toBe(false);
  });

  test('every other function is still a callback, and is called', () => {
    // The class check reads the function's source.  A method that happens to be
    // called `class` starts with the same five letters and is still a method.
    const bus = new EventStream();
    const seen: string[] = [];
    const handlers = {
      class(event: EventA): void { seen.push(`method named class:${event.payload}`); },
    };
    bus.subscribeFunction(EventA, (event) => { seen.push(`arrow:${event.payload}`); });
    bus.subscribeFunction(EventA, function named(event) { seen.push(`function:${event.payload}`); });
    bus.subscribeFunction(EventA, async (event) => { seen.push(`async:${event.payload}`); });
    bus.subscribeFunction(EventA, handlers.class);
    bus.subscribeFunction(EventA, ((event: EventA) => { seen.push(`bound:${event.payload}`); }).bind(null));

    bus.publish(new EventA('x'));
    expect(seen).toEqual(['arrow:x', 'function:x', 'async:x', 'method named class:x', 'bound:x']);
  });

  test('refuses an unusable channel, as subscribe does', () => {
    const bus = new EventStream();
    for (const channel of [undefined, null, 42, {}, '']) {
      expect(() => bus.subscribeFunction(channel as never, () => {}))
        .toThrow(/^EventStream\.subscribeFunction: /);
    }
    expect(bus.hasSubscribers).toBe(false);
  });

  test("subscribe's refusal of a function names subscribeFunction", () => {
    // The likeliest wrong value in the ref slot is a callback, and the method
    // that takes one now exists.
    const bus = new EventStream();
    expect(() => bus.subscribe((() => {}) as never, EventA)).toThrow(/subscribeFunction/);
  });
});

describe('EventStream.subscribeFunction in the subscription trace', () => {
  test('a callback is traced by its name, and an anonymous one as such', () => {
    const bus = new EventStream();
    const { debugLines } = recordLog(bus);
    bus.traceSubscriptions = true;

    const remove = bus.subscribeFunction(EventA, function onEventA() {});
    bus.subscribeFunction(UserLoggedInEvent, () => {});
    remove();
    expect(debugLines).toEqual([
      'EventStream: subscribed callback onEventA to EventA',
      "EventStream: subscribed an anonymous callback to kind 'user-logged-in'",
      'EventStream: unsubscribed callback onEventA from EventA',
    ]);
  });

  test('with the trace off, a callback subscription says nothing', () => {
    const bus = new EventStream();
    const { debugLines } = recordLog(bus);
    const remove = bus.subscribeFunction(EventA, function onEventA() {});
    remove();
    expect(debugLines).toEqual([]);
  });
});

describe('EventStream.subscribeFunction on the public surface', () => {
  test('the handle is a plain () => void, typed through the root barrel', () => {
    // `ExportSurface.test.ts` reads module namespaces, which hold values only,
    // so it cannot see a method or the type it returns.  The annotation below
    // is what makes the compiler check both through the door a consumer uses:
    // change the handle's type and `bun run typecheck:dev` fails on this line.
    type Handle = ReturnType<RootEventStream['subscribeFunction']>;
    const handleIsExactlyAThunk: Exactly<Handle, () => void> = true;
    expect(handleIsExactlyAThunk).toBe(true);

    const bus: RootEventStream = new EventStream();
    const remove: Handle = bus.subscribeFunction(EventA, () => {});
    expect(typeof remove).toBe('function');
    expect(remove()).toBeUndefined();
  });
});
