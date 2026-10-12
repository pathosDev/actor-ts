import { describe, expect, test } from 'bun:test';
import { ActorPath } from '../../src/ActorPath.js';
import { ActorRef } from '../../src/ActorRef.js';
import { EventStream } from '../../src/EventStream.js';
import { EventKey } from '../../src/EventKey.js';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ActorStarted, ActorStopped } from '../../src/SystemMessages.js';
import { gracefulStop } from '../../src/pattern/GracefulStop.js';
import { assertCompletesWithin } from '../util/AsyncAssertions.js';
import { awaitCondition, sleep } from '../util/AwaitCondition.js';

/** Minimal ref that records received events and identifies by a given path. */
class RecordingRef extends ActorRef<unknown> {
  readonly path: ActorPath;
  readonly received: unknown[] = [];
  constructor(pathName: string) {
    super();
    // Root paths render identically, so build a child path to keep identities distinct.
    this.path = new ActorPath('', null, 'test-sys').child(pathName);
  }
  tell(message: unknown): void { this.received.push(message); }
}

class EventA { constructor(public readonly payload: string) {} }
class EventB { constructor(public readonly payload: number) {} }
class ChildOfA extends EventA {}

// The style the project's own message convention prescribes: a named variant
// type discriminated on `kind`, plus a same-named const so the call site reads
// exactly like the class form.
type UserLoggedInEvent = { readonly kind: 'user-logged-in'; readonly userId: string };
const UserLoggedInEvent = EventKey.of<UserLoggedInEvent>('user-logged-in');

type UserLoggedOutEvent = { readonly kind: 'user-logged-out'; readonly userId: string };
const UserLoggedOutEvent = EventKey.of<UserLoggedOutEvent>('user-logged-out');

/** A class whose instances ALSO carry a `kind` — the two channels overlap. */
class TaggedEvent {
  readonly kind = 'tagged';
  constructor(public readonly payload: string) {}
}

describe('EventStream', () => {
  test('publishes to subscribers of the matching channel', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('sub');
    bus.subscribe(ref, EventA);
    const evt = new EventA('hello');
    bus.publish(evt);
    expect(ref.received).toEqual([evt]);
  });

  test('does not publish events of a different channel', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('sub');
    bus.subscribe(ref, EventA);
    bus.publish(new EventB(42));
    expect(ref.received).toEqual([]);
  });

  test('subscribe twice to the same channel returns false and does not duplicate delivery', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('sub');
    expect(bus.subscribe(ref, EventA)).toBe(true);
    expect(bus.subscribe(ref, EventA)).toBe(false);
    bus.publish(new EventA('x'));
    expect(ref.received.length).toBe(1);
  });

  test('unsubscribe by channel stops delivery for that channel only', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('sub');
    bus.subscribe(ref, EventA);
    bus.subscribe(ref, EventB);
    bus.unsubscribe(ref, EventA);
    bus.publish(new EventA('x'));
    bus.publish(new EventB(1));
    expect(ref.received).toEqual([new EventB(1)]);
  });

  test('unsubscribe without channel clears all subscriptions for the ref', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('sub');
    bus.subscribe(ref, EventA);
    bus.subscribe(ref, EventB);
    expect(bus.unsubscribe(ref)).toBe(true);
    bus.publish(new EventA('x'));
    bus.publish(new EventB(1));
    expect(ref.received.length).toBe(0);
  });

  test('unsubscribe returns false when nothing matched', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('sub');
    expect(bus.unsubscribe(ref)).toBe(false);
    expect(bus.unsubscribe(ref, EventA)).toBe(false);
  });

  test('multiple distinct subscribers all receive matching events', () => {
    const bus = new EventStream();
    const first = new RecordingRef('a');
    const second = new RecordingRef('b');
    bus.subscribe(first, EventA);
    bus.subscribe(second, EventA);
    bus.publish(new EventA('shared'));
    expect(first.received.length).toBe(1);
    expect(second.received.length).toBe(1);
  });

  test('matching uses instanceof — subclasses of the channel are delivered too', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('sub');
    bus.subscribe(ref, EventA);
    bus.publish(new ChildOfA('sub')); // ChildOfA extends EventA
    expect(ref.received.length).toBe(1);
  });

  test('different refs with the same path are treated as equal for dedup', () => {
    const bus = new EventStream();
    const a1 = new RecordingRef('shared');
    const a2 = new RecordingRef('shared'); // identical path
    bus.subscribe(a1, EventA);
    // Second subscribe must be a no-op because `equals` uses path.
    expect(bus.subscribe(a2, EventA)).toBe(false);
    bus.publish(new EventA('x'));
    // Delivery goes to the originally-subscribed ref only.
    expect(a1.received.length).toBe(1);
    expect(a2.received.length).toBe(0);
  });
});

/* ============================================================== */
/* Predicate-filtered subscriptions (#85)                         */
/* ============================================================== */

describe('EventStream — predicates (#85)', () => {
  test('predicate filters events before delivery', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('sub');
    // Only large payloads.
    bus.subscribe(ref, EventA, (e) => e.payload.length > 3);
    bus.publish(new EventA('hi'));      // 2 chars — rejected
    bus.publish(new EventA('hello'));   // 5 chars — accepted
    bus.publish(new EventA('a'));       // 1 char  — rejected
    expect(ref.received.map((e) => (e as EventA).payload)).toEqual(['hello']);
  });

  test('multiple predicate-bearing subscriptions on the same channel coexist', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('multi-pred');
    // Two different filters from the same actor — without the
    // predicate-aware dedup these would silently merge.
    bus.subscribe(ref, EventA, (e) => e.payload === 'left');
    bus.subscribe(ref, EventA, (e) => e.payload === 'right');
    bus.publish(new EventA('left'));
    bus.publish(new EventA('middle'));  // matches neither
    bus.publish(new EventA('right'));
    expect(ref.received.map((e) => (e as EventA).payload).sort())
      .toEqual(['left', 'right']);
  });

  test('no-predicate sub coexists with a predicate-bearing one (no dedup across them)', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('hybrid');
    expect(bus.subscribe(ref, EventA)).toBe(true);
    expect(bus.subscribe(ref, EventA, (e) => e.payload === 'special')).toBe(true);
    bus.publish(new EventA('plain'));     // only the no-pred sub matches → 1 delivery
    bus.publish(new EventA('special'));   // both match → 2 deliveries
    // Total: 3 deliveries (1 + 2).
    expect(ref.received).toHaveLength(3);
  });

  test('a re-subscribe with no predicate is still dedup\'d (existing contract)', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('dedup');
    expect(bus.subscribe(ref, EventA)).toBe(true);
    expect(bus.subscribe(ref, EventA)).toBe(false);   // dedup
    bus.publish(new EventA('once'));
    expect(ref.received).toHaveLength(1);
  });

  test('throwing predicate is treated as no-match; bus stays alive for other subs', () => {
    const bus = new EventStream();
    bus.log = { warn: () => { /* swallow during tests */ } };
    const broken = new RecordingRef('broken');
    const healthy = new RecordingRef('healthy');
    bus.subscribe(broken, EventA, () => { throw new Error('predicate boom'); });
    bus.subscribe(healthy, EventA);
    bus.publish(new EventA('x'));
    // Broken predicate threw → no delivery to that subscriber, but
    // the unfiltered subscriber on the same channel still gets it.
    expect(broken.received).toEqual([]);
    expect(healthy.received).toHaveLength(1);
  });

  test('subclass events still reach a base-class predicate subscription', () => {
    // Existing instanceof-based matching must keep working with a predicate
    // — predicates filter ON TOP OF the channel match, not instead of it.
    const bus = new EventStream();
    const ref = new RecordingRef('subclass-pred');
    bus.subscribe(ref, EventA, (e) => e.payload.startsWith('keep'));
    bus.publish(new ChildOfA('keep-me'));
    bus.publish(new ChildOfA('drop-me'));
    expect(ref.received.map((e) => (e as EventA).payload)).toEqual(['keep-me']);
  });

  test('unsubscribe removes every subscription including predicate-bearing ones', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('unsub-all');
    bus.subscribe(ref, EventA);
    bus.subscribe(ref, EventA, () => true);
    bus.subscribe(ref, EventA, (e) => e.payload === 'k');
    expect(bus.unsubscribe(ref, EventA)).toBe(true);
    bus.publish(new EventA('any'));
    expect(ref.received).toEqual([]);
  });
});

// #645 / #763 — `publish` walked the live subscription array while
// `subscriber.tell` can run synchronously, so a handler that (un)subscribed
// mid-delivery mutated the list being iterated.
describe('EventStream.publish is reentrancy-safe', () => {
  test('a subscription removed during delivery still gets the current event', () => {
    // The recipient set is decided when publish starts, so a removal that
    // lands mid-delivery takes effect from the *next* event.  This half was
    // already true before the fix — `unsubscribe` reassigns the array — and
    // it is the defensible half: one extra event to a departing subscriber
    // goes to dead letters like any other message to a stopped actor.
    const stream = new EventStream();
    const late = new RecordingRef('late');

    class UnsubscribingRef extends ActorRef<unknown> {
      readonly path = new ActorPath('', null, 'test-sys').child('early');
      readonly received: unknown[] = [];
      tell(message: unknown): void {
        this.received.push(message);
        stream.unsubscribe(late);
      }
    }
    const early = new UnsubscribingRef();

    stream.subscribe(early, EventA);
    stream.subscribe(late, EventA);
    stream.publish(new EventA('x'));
    expect(late.received).toHaveLength(1);

    // And it really is gone from the next publish on.
    stream.publish(new EventA('y'));
    expect(early.received).toHaveLength(2);
    expect(late.received).toHaveLength(1);
  });

  test('a subscription added during delivery does not receive the in-flight event', () => {
    const stream = new EventStream();
    const newcomer = new RecordingRef('newcomer');

    class SubscribingRef extends ActorRef<unknown> {
      readonly path = new ActorPath('', null, 'test-sys').child('first');
      readonly received: unknown[] = [];
      tell(message: unknown): void {
        this.received.push(message);
        stream.subscribe(newcomer, EventA);
      }
    }
    const first = new SubscribingRef();

    stream.subscribe(first, EventA);
    stream.publish(new EventA('x'));
    expect(newcomer.received).toEqual([]);

    // But it is subscribed from the next event on.
    stream.publish(new EventA('y'));
    expect(newcomer.received).toHaveLength(1);
  });

  test('a subscriber that unsubscribes itself still gets the current event', () => {
    // The snapshot cuts both ways, and this is the correct half: delivery
    // was already decided when publish started.
    const stream = new EventStream();
    class SelfRemoving extends ActorRef<unknown> {
      readonly path = new ActorPath('', null, 'test-sys').child('self');
      readonly received: unknown[] = [];
      tell(message: unknown): void {
        this.received.push(message);
        stream.unsubscribe(this);
      }
    }
    const ref = new SelfRemoving();
    stream.subscribe(ref, EventA);

    stream.publish(new EventA('x'));
    stream.publish(new EventA('y'));

    expect(ref.received).toHaveLength(1);
  });
});

// #645 / #763 — `unsubscribe` had exactly one caller in the whole framework
// (a DevTools probe), so an actor that subscribed and then stopped stayed on
// the list forever: the list grew without bound, and every publish paid an
// O(N) walk that ended in a dead letter per departed subscriber.
describe('EventStream releases stopped subscribers', () => {
  test('a stopped actor is removed from the stream', async () => {
    // `unsubscribe` reports whether it removed anything, which is the probe:
    // after the actor stops there must be nothing left for it to remove.
    const system = ActorSystem.create(
      'es-leak',
      ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
    );

    const subscribed = { value: false };
    class Listener extends Actor<EventA> {
      override preStart(): void {
        this.context.system.eventStream.subscribe(this.context.self, EventA);
        subscribed.value = true;
      }
      override onReceive(): void {}
    }

    // The cell drops its subscriptions *before* publishing `ActorStopped`, so
    // that event is the exact point after which the probe below is meaningful.
    // Polling `unsubscribe` itself would be wrong: a poll that returned true
    // would be the thing doing the cleanup the assertion is checking for.
    const stopped: ActorStopped[] = [];
    class StopWatcher extends Actor<ActorStopped> {
      override preStart(): void { this.system.eventStream.subscribe(this.self, ActorStopped); }
      override onReceive(event: ActorStopped): void { stopped.push(event); }
    }
    system.spawn(StopWatcher, 'stops');

    const ref = system.spawn(Listener, 'listener');
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the listener subscribed in preStart',
    });
    // While alive, there is a subscription to remove — so re-subscribe and
    // carry on, otherwise the probe would be the thing doing the cleanup.
    expect(system.eventStream.unsubscribe(ref, EventA)).toBe(true);
    system.eventStream.subscribe(ref, EventA);

    ref.stop();
    await awaitCondition(() => stopped.some((event) => event.actor.equals(ref)), {
      timeoutMs: 4_000,
      label: 'the listener reached the terminated state',
    });

    expect(system.eventStream.unsubscribe(ref, EventA)).toBe(false);
    await system.terminate();
  });

  test('a stopped subscriber stops receiving events', async () => {
    const system = ActorSystem.create(
      'es-leak-2',
      ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
    );
    const seen: string[] = [];
    const subscribed = { value: false };
    const stopped = { value: false };

    class Listener extends Actor<EventA> {
      override preStart(): void {
        this.context.system.eventStream.subscribe(this.context.self, EventA);
        subscribed.value = true;
      }
      override onReceive(event: EventA): void { seen.push(event.payload); }
      override postStop(): void { stopped.value = true; }
    }

    const ref = system.spawn(Listener, 'listener');
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 4_000,
      label: 'the listener subscribed in preStart',
    });
    system.eventStream.publish(new EventA('before'));
    await awaitCondition(() => seen.includes('before'), {
      timeoutMs: 4_000,
      label: 'the live subscriber received the first event',
    });

    ref.stop();
    await awaitCondition(() => stopped.value, {
      timeoutMs: 4_000,
      label: 'the subscriber stopped',
    });
    system.eventStream.publish(new EventA('after'));
    // Nothing to poll for: the property is that `after` never arrives, so this
    // one stays a plain sleep.
    await sleep(40);

    expect(seen).toEqual(['before']);
    await system.terminate();
  });
});

// #1010 — the `instanceof` test sat one line above the `try` and
// `subscriber.tell` ran unguarded below it, so of the three things that can
// throw per subscription only the predicate was covered.  A single faulty
// entry therefore raised into `publish`'s caller and, because the throw
// escaped the loop, silently cut off every subscription registered after it.
describe('EventStream survives a faulty subscription', () => {
  /** A ref whose `tell` always throws — the third, previously unguarded, site. */
  class ExplodingRef extends ActorRef<unknown> {
    readonly path: ActorPath;
    constructor(pathName: string) {
      super();
      this.path = new ActorPath('', null, 'test-sys').child(pathName);
    }
    tell(): void { throw new Error('tell boom'); }
  }

  /** Silences the warnings the guards emit; the bus is fine without a logger. */
  function quiet(bus: EventStream): EventStream {
    bus.log = { warn: () => { /* swallow during tests */ } };
    return bus;
  }

  test('subscribe rejects a channel that cannot sit on the right of instanceof', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('bad-channel');
    // The realistic route is an ESM import cycle handing over an
    // uninitialised binding, which types cannot catch.
    expect(() => bus.subscribe(ref, undefined as never)).toThrow(TypeError);
    expect(() => bus.subscribe(ref, null as never)).toThrow(TypeError);
    expect(() => bus.subscribe(ref, 42 as never)).toThrow(TypeError);
    expect(() => bus.subscribe(ref, {} as never)).toThrow(TypeError);
    expect(() => bus.subscribe(ref, [] as never)).toThrow(TypeError);
  });

  test('a rejected subscribe leaves the bus untouched', () => {
    const bus = new EventStream();
    const healthy = new RecordingRef('healthy');
    bus.subscribe(healthy, EventA);
    expect(() => bus.subscribe(new RecordingRef('bad'), undefined as never)).toThrow(TypeError);
    bus.publish(new EventA('x'));
    expect(healthy.received).toHaveLength(1);
  });

  test('an object with Symbol.hasInstance is a legal channel', () => {
    // No construct signature can describe it, so the check is deliberately
    // wider than the declared channel type rather than narrower.
    const bus = new EventStream();
    const ref = new RecordingRef('has-instance');
    const evenNumbers = {
      [Symbol.hasInstance]: (value: unknown) => (value as EventB).payload % 2 === 0,
    };
    expect(bus.subscribe(ref, evenNumbers as never)).toBe(true);
    bus.publish(new EventB(2));
    bus.publish(new EventB(3));
    expect(ref.received.map((e) => (e as EventB).payload)).toEqual([2]);
  });

  test('a channel that throws on instanceof does not break publish for others', () => {
    // Subscribe-time validation cannot be total: this one passes every
    // structural check and still throws at delivery.
    const bus = quiet(new EventStream());
    const broken = new RecordingRef('broken-channel');
    const healthy = new RecordingRef('healthy');
    const hostile = {
      [Symbol.hasInstance]: () => { throw new Error('hasInstance boom'); },
    };
    bus.subscribe(broken, hostile as never);
    bus.subscribe(healthy, EventA);

    expect(() => bus.publish(new EventA('x'))).not.toThrow();
    expect(broken.received).toEqual([]);
    expect(healthy.received).toHaveLength(1);
  });

  test('a throwing tell does not break publish for others', () => {
    const bus = quiet(new EventStream());
    const exploding = new ExplodingRef('exploding');
    const healthy = new RecordingRef('healthy');
    bus.subscribe(exploding, EventA);
    bus.subscribe(healthy, EventA);

    expect(() => bus.publish(new EventA('x'))).not.toThrow();
    expect(healthy.received).toHaveLength(1);
  });

  test('subscriptions registered after a faulty one still receive events', () => {
    // The ordering that decided who was cut off was subscription order, which
    // no caller controls — so the faulty entry goes first on purpose.
    const bus = quiet(new EventStream());
    const hostile = { [Symbol.hasInstance]: () => { throw new Error('boom'); } };
    bus.subscribe(new RecordingRef('first-and-broken'), hostile as never);
    const second = new RecordingRef('second');
    const third = new RecordingRef('third');
    bus.subscribe(second, EventA);
    bus.subscribe(third, EventA);

    bus.publish(new EventA('x'));
    expect(second.received).toHaveLength(1);
    expect(third.received).toHaveLength(1);
  });

  test('tell to a stopped actor never throws, even with a faulty subscription', async () => {
    // The path that made this a production problem rather than a curiosity:
    // a dead-lettered `tell` ends in `publish`, so the TypeError surfaced
    // inside the caller's stack on an API that does not throw by contract.
    const system = ActorSystem.create(
      'es-faulty',
      ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
    );
    const hostile = { [Symbol.hasInstance]: () => { throw new Error('boom'); } };
    system.eventStream.subscribe(new RecordingRef('broken'), hostile as never);

    class Sink extends Actor<string> { override onReceive(): void {} }
    const ref = system.spawn(Sink, 'sink');
    ref.stop();
    await awaitCondition(() => system.eventStream.unsubscribe(ref) === false, {
      timeoutMs: 4_000,
      label: 'the sink finished terminating',
    });

    expect(() => ref.tell('hello')).not.toThrow();
    await system.terminate();
  });
});

// #1010 checked the channel and left the subscriber to the type system, which
// a JavaScript caller does not have.  The bus calls `equals` on every stored
// subscriber in `unsubscribe`, and `ActorCell` makes that call on every actor
// stop, so a single entry that was not a ref broke every stop after it: the
// TypeError escaped `finalizeTermination` before the watchers were told, the
// name stayed taken, and `terminate()` never settled.  The likeliest such entry
// is a plain function, from a caller guessing at a callback API (#1433).
describe('EventStream refuses a subscriber that is not an ActorRef', () => {
  class Sink extends Actor<string> {
    override onReceive(): void {}
  }

  /** What realistically arrives where a ref belongs. */
  const notActorRefs: ReadonlyArray<readonly [string, unknown]> = [
    ['a plain function', (_event: unknown) => {}],
    // An import cycle, or a ref field read before it was assigned.
    ['undefined', undefined],
    ['null', null],
    // `subscribe(this, …)` inside an actor, where `this.self` was meant.
    ['the actor itself', new Sink()],
    ['an object that can tell but not compare', { tell: () => {} }],
    // `ActorRef.equals` compares paths, so every ref on the bus reads this one's.
    ['an object without a path', { tell: () => {}, equals: () => false }],
  ];

  test.each(notActorRefs)('subscribe refuses %s with a TypeError', (_label, candidate) => {
    const bus = new EventStream();
    expect(() => bus.subscribe(candidate as never, EventA)).toThrow(TypeError);
    expect(() => bus.subscribe(candidate as never, EventA))
      .toThrow(/^EventStream\.subscribe: subscriber must be an ActorRef/);
  });

  test.each(notActorRefs)(
    'unsubscribe refuses %s with a TypeError, even on an empty stream',
    (_label, candidate) => {
      // The empty stream is the case that used to say nothing: with no stored
      // ref to compare against, `unsubscribe` returned `false`, and a cleanup
      // holding the wrong value looked like one that found nothing to remove.
      const bus = new EventStream();
      expect(() => bus.unsubscribe(candidate as never)).toThrow(TypeError);
      expect(() => bus.unsubscribe(candidate as never, EventA))
        .toThrow(/^EventStream\.unsubscribe: subscriber must be an ActorRef/);
    },
  );

  test('a refused subscriber leaves nothing behind', () => {
    // Refused on an empty bus on purpose.  With a ref already stored, its
    // `equals` read the function's missing path during the dedup check and
    // threw by accident; on an empty bus nothing stood in the way, and the
    // function was stored for the next `unsubscribe` to trip over.
    const bus = new EventStream();
    expect(() => bus.subscribe((() => {}) as never, EventA)).toThrow(TypeError);
    const healthy = new RecordingRef('healthy');
    bus.subscribe(healthy, EventA);

    bus.publish(new EventA('x'));
    expect(healthy.received).toHaveLength(1);
    // The call every actor stop makes, and the one a stored function broke.
    expect(bus.unsubscribe(healthy)).toBe(true);
    expect(bus.hasSubscribers).toBe(false);
  });

  test('a ref that does not extend this copy of ActorRef is still accepted', () => {
    // Structural on purpose, like the channel check: the bus asks for the three
    // members it uses.  `instanceof` would refuse a working ref minted by
    // another copy of the module — a second install of the package, or one
    // file loaded under two specifiers.
    const bus = new EventStream();
    const received: unknown[] = [];
    const path = new ActorPath('', null, 'test-sys').child('foreign');
    const foreign = {
      path,
      tell: (event: unknown) => { received.push(event); },
      equals: (other: ActorRef) => other.path.toString() === path.toString(),
    };
    expect(bus.subscribe(foreign as never, EventA)).toBe(true);
    bus.publish(new EventA('x'));
    expect(received).toHaveLength(1);
    expect(bus.unsubscribe(foreign as never)).toBe(true);
  });

  test('a function handed to subscribe cannot stall a stop or terminate()', async () => {
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('es-function-subscriber', options);
    // Refused at the call site, as the tests above pin.  This one is about what
    // the attempt must not do to everything after it, so the refusal is caught.
    try {
      system.eventStream.subscribe(((_event: ActorStopped) => {}) as never, ActorStopped);
    } catch {
      /* refused */
    }

    const sink = system.spawn(Sink, 'sink');
    // Resolves once the stopped actor's watchers were told: the step of the
    // termination that a stored function used to break off before.
    expect(await gracefulStop(sink, 1_000)).toBe(true);
    await assertCompletesWithin(
      system.terminate(),
      1_000,
      'terminate() after a function was handed to subscribe',
    );
  });
});

// The structural check above cannot see behaviour.  A ref with a callable
// `equals` and a path, whose `equals` throws, passes it and is stored; every
// `unsubscribe` then threw from comparing against it, and `ActorCell` makes
// that call on every actor stop — so one such entry stalled every stop after
// it and `terminate()` with them, the shutdown #1010 promised a faulty
// subscription could not reach.  With anything else on the bus, the dedup check
// made every later predicate-free `subscribe` throw too, so an unrelated
// actor's `preStart` failed.
describe('EventStream isolates a subscriber whose equals throws', () => {
  class Sink extends Actor<string> {
    override onReceive(): void {}
  }

  /** Passes every structural check, and throws from the first comparison it is part of. */
  function hostileRef(name: string): ActorRef {
    return {
      path: new ActorPath('', null, 'test-sys').child(name),
      tell: () => {},
      equals: () => { throw new Error('equals boom'); },
    } as unknown as ActorRef;
  }

  /** Collects the bus's warnings, so a test can tell "reported" from "swallowed". */
  function recordWarnings(bus: EventStream): string[] {
    const warnings: string[] = [];
    bus.log = { warn: (message: string) => { warnings.push(message); } };
    return warnings;
  }

  test('an unrelated subscribe is not refused by the dedup check', () => {
    const bus = new EventStream();
    recordWarnings(bus);
    bus.subscribe(hostileRef('hostile'), EventA);
    const healthy = new RecordingRef('healthy');

    expect(bus.subscribe(healthy, EventA)).toBe(true);
    bus.publish(new EventA('x'));
    expect(healthy.received).toHaveLength(1);
  });

  test('a duplicate is still recognised beside the faulty entry', () => {
    const bus = new EventStream();
    recordWarnings(bus);
    const healthy = new RecordingRef('healthy');
    bus.subscribe(hostileRef('hostile'), EventA);
    bus.subscribe(healthy, EventA);

    expect(bus.subscribe(healthy, EventA)).toBe(false);
    bus.publish(new EventA('x'));
    expect(healthy.received).toHaveLength(1);
  });

  test('a faulty entry on another channel is never asked', () => {
    // Dedup only ever concerns one channel, so comparing subscribers on any
    // other is work — two path renders per stored entry — that can only fail.
    const bus = new EventStream();
    const warnings = recordWarnings(bus);
    bus.subscribe(hostileRef('hostile'), EventB);

    expect(bus.subscribe(new RecordingRef('healthy'), EventA)).toBe(true);
    expect(bus.unsubscribe(new RecordingRef('healthy'), EventA)).toBe(true);
    expect(warnings).toEqual([]);
  });

  test('unsubscribe removes the entries beside it, and reports the comparison', () => {
    const bus = new EventStream();
    const warnings = recordWarnings(bus);
    const healthy = new RecordingRef('healthy');
    bus.subscribe(hostileRef('hostile'), EventA);
    // Same channel, so this dedup check compared against it too.
    bus.subscribe(healthy, EventA);
    warnings.length = 0;

    expect(bus.unsubscribe(healthy)).toBe(true);
    bus.publish(new EventA('x'));
    expect(healthy.received).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^EventStream\.unsubscribe: .*EventA/);
  });

  test('the faulty entry is removed by the object that subscribed it', () => {
    // Its own `equals` throws even against itself, so only identity can
    // name it — and a subscription its owner cannot remove is a leak.
    const bus = new EventStream();
    recordWarnings(bus);
    const hostile = hostileRef('hostile');
    bus.subscribe(hostile, EventA);

    expect(bus.unsubscribe(hostile)).toBe(true);
    expect(bus.hasSubscribers).toBe(false);
  });

  test('a candidate whose path cannot be rendered does not break unsubscribe', () => {
    // `ActorRef.equals` renders the *other* side's path, so the throw can come
    // from the argument just as well as from a stored entry.
    const bus = new EventStream();
    recordWarnings(bus);
    const healthy = new RecordingRef('healthy');
    bus.subscribe(healthy, EventA);
    const unrenderable = {
      path: { toString: () => { throw new Error('path boom'); } },
      tell: () => {},
      equals: () => false,
    } as unknown as ActorRef;

    expect(bus.unsubscribe(unrenderable)).toBe(false);
    bus.publish(new EventA('x'));
    expect(healthy.received).toHaveLength(1);
  });

  test('a stop and terminate() complete with such a subscriber on the bus', async () => {
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('es-throwing-equals', options);
    // Stored on the empty bus of a fresh system, where nothing compares it.
    expect(system.eventStream.subscribe(hostileRef('hostile'), ActorStopped)).toBe(true);

    const sink = system.spawn(Sink, 'sink');
    expect(await gracefulStop(sink, 1_000)).toBe(true);
    await assertCompletesWithin(
      system.terminate(),
      1_000,
      'terminate() with a subscriber whose equals throws',
    );
  });

  test("an unrelated actor's preStart subscription goes through", async () => {
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('es-throwing-equals-prestart', options);
    system.eventStream.subscribe(hostileRef('hostile'), EventA);
    const subscribed = { value: false };
    const seen: string[] = [];
    class Listener extends Actor<EventA> {
      override preStart(): void {
        subscribed.value = this.system.eventStream.subscribe(this.self, EventA);
      }
      override onReceive(event: EventA): void { seen.push(event.payload); }
    }

    system.spawn(Listener, 'listener');
    // No `finally` around these: a terminate() that hangs for the same reason
    // would replace the failure that names the step.
    await awaitCondition(() => subscribed.value, {
      timeoutMs: 2_000,
      label: "the listener's preStart subscription went through",
    });
    system.eventStream.publish(new EventA('after'));
    await awaitCondition(() => seen.includes('after'), {
      timeoutMs: 2_000,
      label: 'the listener received the event',
    });
    await assertCompletesWithin(
      system.terminate(),
      1_000,
      'terminate() after the preStart subscription',
    );
  });
});

// The DevTools observer was promised every published event "even when nothing
// else is listening" (#553), but `ActorCell` builds ActorStarted and
// ActorStopped only when `hasSubscribers` is true, and that counted actor
// subscriptions alone.  An observer on an otherwise quiet system saw no
// lifecycle event at all; DevTools hid it by always subscribing a probe too.
describe('EventStream counts the DevTools observer as a listener', () => {
  test('hasSubscribers follows the observer in and out', () => {
    const bus = new EventStream();
    expect(bus.hasSubscribers).toBe(false);
    bus._observe(() => {});
    expect(bus.hasSubscribers).toBe(true);
    bus._observe(null);
    expect(bus.hasSubscribers).toBe(false);
  });

  test('an observer alone is enough for an actor start to be published', async () => {
    const options = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('es-observer-only', options);
    try {
      const seen: object[] = [];
      system.eventStream._observe((event) => { seen.push(event); });

      class Quiet extends Actor<string> {
        override onReceive(): void {}
      }
      const ref = system.spawn(Quiet, 'observed');
      const startsOf = () =>
        seen.filter((event) => event instanceof ActorStarted && event.actor.equals(ref));
      await awaitCondition(() => startsOf().length > 0, {
        timeoutMs: 2_000,
        label: 'the observer saw the actor start',
      });
      expect(startsOf()).toHaveLength(1);
    } finally {
      system.eventStream._observe(null);
      await system.terminate();
    }
  });
});

/* ============================================================== */
/* Kind-discriminated channels (#1143)                            */
/* ============================================================== */

// The project's own convention is `kind`-discriminated plain types, and
// `publish(event: object)` has always accepted one — but `subscribe` took only
// a class, so the dominant message style could be published and never heard.
describe('EventStream — kind channels', () => {
  test('delivers a plain kind-discriminated event to an EventKey subscriber', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('by-key');
    bus.subscribe(ref, UserLoggedInEvent);
    bus.publish({ kind: 'user-logged-in', userId: 'user-42' });
    expect(ref.received).toEqual([{ kind: 'user-logged-in', userId: 'user-42' }]);
  });

  test('delivers to a bare-string subscriber', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('by-string');
    bus.subscribe(ref, 'user-logged-in');
    bus.publish({ kind: 'user-logged-in', userId: 'user-42' });
    expect(ref.received).toHaveLength(1);
  });

  test('a different kind is not delivered', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('one-kind');
    bus.subscribe(ref, UserLoggedInEvent);
    bus.publish({ kind: 'user-logged-out', userId: 'user-42' });
    expect(ref.received).toEqual([]);
  });

  test('an event with no kind matches nothing and throws nothing', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('no-kind');
    bus.subscribe(ref, UserLoggedInEvent);
    expect(() => bus.publish({ userId: 'user-42' })).not.toThrow();
    expect(ref.received).toEqual([]);
  });

  test('a non-string kind never matches a kind channel', () => {
    // Strict `===` against a string constant already implies the type, so no
    // extra guard is paid on the hot path for this.
    const bus = new EventStream();
    const ref = new RecordingRef('numeric-kind');
    bus.subscribe(ref, '42');
    expect(() => bus.publish({ kind: 42 })).not.toThrow();
    expect(ref.received).toEqual([]);
  });

  test('a class instance does not match an unrelated kind channel', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('class-vs-kind');
    bus.subscribe(ref, 'user-logged-in');
    bus.publish(new EventA('x'));
    expect(ref.received).toEqual([]);
  });

  test('a predicate filters on top of a kind match, and sees the typed event', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('kind-pred');
    // No annotation on `event` — this only compiles if the phantom type on the
    // key round-trips through `subscribe`.
    bus.subscribe(ref, UserLoggedInEvent, (event) => event.userId !== 'system');
    bus.publish({ kind: 'user-logged-in', userId: 'system' });
    bus.publish({ kind: 'user-logged-in', userId: 'user-42' });
    expect(ref.received).toHaveLength(1);
  });

  test('a throwing predicate on a kind channel is a no-match, and the warning names the kind', () => {
    // Regression: the warning used to interpolate `channel.name`, which is
    // `undefined` for a channel that is not a class.
    const bus = new EventStream();
    const warnings: string[] = [];
    bus.log = { warn: (message) => { warnings.push(message); } };
    const broken = new RecordingRef('broken');
    const healthy = new RecordingRef('healthy');
    bus.subscribe(broken, UserLoggedInEvent, () => { throw new Error('predicate boom'); });
    bus.subscribe(healthy, UserLoggedInEvent);

    bus.publish({ kind: 'user-logged-in', userId: 'user-42' });
    expect(broken.received).toEqual([]);
    expect(healthy.received).toHaveLength(1);
    expect(warnings[0]).toContain("kind 'user-logged-in'");
  });

  test('unsubscribe by EventKey stops that kind only', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('two-kinds');
    bus.subscribe(ref, UserLoggedInEvent);
    bus.subscribe(ref, UserLoggedOutEvent);

    expect(bus.unsubscribe(ref, UserLoggedInEvent)).toBe(true);
    bus.publish({ kind: 'user-logged-in', userId: 'a' });
    bus.publish({ kind: 'user-logged-out', userId: 'a' });
    expect(ref.received).toEqual([{ kind: 'user-logged-out', userId: 'a' }]);
  });

  test('unsubscribe without a channel clears kind subscriptions too', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('clear-all');
    bus.subscribe(ref, UserLoggedInEvent);
    bus.subscribe(ref, EventA);

    expect(bus.unsubscribe(ref)).toBe(true);
    bus.publish({ kind: 'user-logged-in', userId: 'a' });
    bus.publish(new EventA('x'));
    expect(ref.received).toEqual([]);
  });

  test('class and kind subscriptions coexist without interfering', () => {
    const bus = new EventStream();
    const onClass = new RecordingRef('on-class');
    const onKind = new RecordingRef('on-kind');
    bus.subscribe(onClass, EventA);
    bus.subscribe(onKind, UserLoggedInEvent);

    bus.publish(new EventA('x'));
    bus.publish({ kind: 'user-logged-in', userId: 'a' });
    expect(onClass.received).toHaveLength(1);
    expect(onKind.received).toHaveLength(1);
  });

  test('subclass instances still reach a base-class subscriber', () => {
    // The class contract is untouched by the widening.
    const bus = new EventStream();
    const ref = new RecordingRef('base');
    bus.subscribe(ref, EventA);
    bus.publish(new ChildOfA('from-subclass'));
    expect(ref.received).toHaveLength(1);
  });
});

// A key is a typed NAME for a kind, not a second channel — so the identity a
// subscription is filed under is the kind string, never the key object.
describe('EventStream — channel identity', () => {
  test('a string and a key naming the same kind dedup, in either order', () => {
    const first = new EventStream();
    const refA = new RecordingRef('string-then-key');
    expect(first.subscribe(refA, 'user-logged-in')).toBe(true);
    expect(first.subscribe(refA, UserLoggedInEvent)).toBe(false);
    first.publish({ kind: 'user-logged-in', userId: 'a' });
    expect(refA.received).toHaveLength(1);

    const second = new EventStream();
    const refB = new RecordingRef('key-then-string');
    expect(second.subscribe(refB, UserLoggedInEvent)).toBe(true);
    expect(second.subscribe(refB, 'user-logged-in')).toBe(false);
    second.publish({ kind: 'user-logged-in', userId: 'a' });
    expect(refB.received).toHaveLength(1);
  });

  test('unsubscribe by string removes a key-registered subscription', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('unsub-by-string');
    bus.subscribe(ref, UserLoggedInEvent);
    expect(bus.unsubscribe(ref, 'user-logged-in')).toBe(true);
    bus.publish({ kind: 'user-logged-in', userId: 'a' });
    expect(ref.received).toEqual([]);
  });

  test('unsubscribe by a FRESH key removes a string-registered subscription', () => {
    // `EventKey.of` mints a new instance per call, so filing subscriptions
    // under the key object would make this obvious call a silent no-op.
    const bus = new EventStream();
    const ref = new RecordingRef('unsub-by-fresh-key');
    bus.subscribe(ref, 'user-logged-in');
    expect(bus.unsubscribe(ref, EventKey.of<UserLoggedInEvent>('user-logged-in'))).toBe(true);
    bus.publish({ kind: 'user-logged-in', userId: 'a' });
    expect(ref.received).toEqual([]);
  });

  test('a class and a kind are two channels even when the instances carry that kind', () => {
    // Two channels selecting overlapping events — exactly like a base class
    // and its subclass, and an actor holding both gets both deliveries.
    const bus = new EventStream();
    const ref = new RecordingRef('both-channels');
    expect(bus.subscribe(ref, TaggedEvent)).toBe(true);
    expect(bus.subscribe(ref, 'tagged')).toBe(true);
    bus.publish(new TaggedEvent('x'));
    expect(ref.received).toHaveLength(2);
  });

  test('unsubscribing the class leaves the kind subscription alive', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('drop-class-only');
    bus.subscribe(ref, TaggedEvent);
    bus.subscribe(ref, 'tagged');
    expect(bus.unsubscribe(ref, TaggedEvent)).toBe(true);
    bus.publish(new TaggedEvent('x'));
    expect(ref.received).toHaveLength(1);
  });
});

describe('EventStream — kind-channel validation', () => {
  test('the empty string is rejected by subscribe', () => {
    const bus = new EventStream();
    expect(() => bus.subscribe(new RecordingRef('empty'), '')).toThrow(TypeError);
  });

  test('unsubscribe with the empty string throws and clears nothing', () => {
    // `''` is falsy, so a truthiness check would take the omitted-channel
    // branch and drop every subscription the actor held.
    const bus = new EventStream();
    const ref = new RecordingRef('empty-unsub');
    bus.subscribe(ref, EventA);
    bus.subscribe(ref, UserLoggedInEvent);

    expect(() => bus.unsubscribe(ref, '')).toThrow(TypeError);
    bus.publish(new EventA('x'));
    bus.publish({ kind: 'user-logged-in', userId: 'a' });
    expect(ref.received).toHaveLength(2);
  });

  test('unsubscribe with an explicit undefined still clears everything', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('explicit-undefined');
    bus.subscribe(ref, EventA);
    expect(bus.unsubscribe(ref, undefined)).toBe(true);
    bus.publish(new EventA('x'));
    expect(ref.received).toEqual([]);
  });

  test('unsubscribe rejects a structurally invalid channel', () => {
    const bus = new EventStream();
    const ref = new RecordingRef('bad-unsub');
    bus.subscribe(ref, EventA);
    expect(() => bus.unsubscribe(ref, 42 as never)).toThrow(TypeError);
    // Removing nothing quietly is how a subscription survives a cleanup that
    // believed it had done its job.
    bus.publish(new EventA('x'));
    expect(ref.received).toHaveLength(1);
  });
});

describe('EventKey', () => {
  test('equality is by kind, not by instance', () => {
    expect(EventKey.of<UserLoggedInEvent>('user-logged-in')
      .equals(EventKey.of<UserLoggedInEvent>('user-logged-in'))).toBe(true);
    expect(UserLoggedInEvent.equals(UserLoggedOutEvent)).toBe(false);
  });

  test('kind round-trips and toString names it', () => {
    expect(UserLoggedInEvent.kind).toBe('user-logged-in');
    expect(UserLoggedInEvent.toString()).toBe('EventKey(user-logged-in)');
  });

  test('a kind the event type does not declare is a compile error', () => {
    // @ts-expect-error — 'user-logged-out' is not UserLoggedInEvent['kind'].
    EventKey.of<UserLoggedInEvent>('user-logged-out');
    // Same protection on the bare-string shorthand when the type is supplied.
    const bus = new EventStream();
    // @ts-expect-error — the string is checked against UserLoggedInEvent['kind'].
    bus.subscribe<UserLoggedInEvent>(new RecordingRef('typo'), 'user-logged-out');
  });
});
