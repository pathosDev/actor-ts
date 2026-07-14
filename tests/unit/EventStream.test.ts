import { describe, expect, test } from 'bun:test';
import { ActorPath } from '../../src/ActorPath.js';
import { ActorRef } from '../../src/ActorRef.js';
import { EventStream } from '../../src/EventStream.js';

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
