import { describe, expect, test } from 'bun:test';
import { ActorPath } from '../../src/ActorPath.js';
import { ActorRef } from '../../src/ActorRef.js';
import { EventStream } from '../../src/EventStream.js';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';

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

    class Listener extends Actor<EventA> {
      override preStart(): void { this.context.system.eventStream.subscribe(this.context.self, EventA); }
      override onReceive(): void {}
    }

    const ref = system.spawn(Listener, 'listener');
    await Bun.sleep(60);
    // While alive, there is a subscription to remove — so re-subscribe and
    // carry on, otherwise the probe would be the thing doing the cleanup.
    expect(system.eventStream.unsubscribe(ref, EventA)).toBe(true);
    system.eventStream.subscribe(ref, EventA);

    ref.stop();
    await Bun.sleep(120);

    expect(system.eventStream.unsubscribe(ref, EventA)).toBe(false);
    await system.terminate();
  });

  test('a stopped subscriber stops receiving events', async () => {
    const system = ActorSystem.create(
      'es-leak-2',
      ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
    );
    const seen: string[] = [];

    class Listener extends Actor<EventA> {
      override preStart(): void { this.context.system.eventStream.subscribe(this.context.self, EventA); }
      override onReceive(event: EventA): void { seen.push(event.payload); }
    }

    const ref = system.spawn(Listener, 'listener');
    await Bun.sleep(40);
    system.eventStream.publish(new EventA('before'));
    await Bun.sleep(40);

    ref.stop();
    await Bun.sleep(80);
    system.eventStream.publish(new EventA('after'));
    await Bun.sleep(40);

    expect(seen).toEqual(['before']);
    await system.terminate();
  });
});
