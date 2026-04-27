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
    const a = new RecordingRef('a');
    const b = new RecordingRef('b');
    bus.subscribe(a, EventA);
    bus.subscribe(b, EventA);
    bus.publish(new EventA('shared'));
    expect(a.received.length).toBe(1);
    expect(b.received.length).toBe(1);
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
