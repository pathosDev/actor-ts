import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { EventStreamTap } from '../../../src/devtools/taps/EventStreamTap.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import type {
  BusEventBatchPayload,
  DevToolsStreamPayload,
  PubSubTopicsResult,
} from '../../../src/devtools/protocol/index.js';
import type { DevToolsRequestHandler, DevToolsServer } from '../../../src/devtools/DevToolsServer.js';

class QuietActor extends Actor<string> {
  override onReceive(): void {}
}

class OrderPlaced {
  constructor(readonly orderId: string) {}
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

/** Collects what the tap emits, and lets a test drive its lifecycle. */
function harness(system: ActorSystem, capacity = 500, flushMs = 20) {
  const batches: BusEventBatchPayload[] = [];
  const methods = new Map<string, DevToolsRequestHandler>();
  const tap = new EventStreamTap(system, capacity, flushMs);
  tap.install((payload: DevToolsStreamPayload) => {
    batches.push(payload as BusEventBatchPayload);
  });
  tap.installMethods({
    registerMethod(method: string, handler: DevToolsRequestHandler): void {
      methods.set(method, handler);
    },
  } as unknown as DevToolsServer);
  return {
    tap,
    batches,
    events: () => batches.flatMap((batch) => batch.events),
    topics: () => methods.get('pubsub.topics')!(undefined) as Promise<PubSubTopicsResult>,
  };
}

describe('EventStreamTap', () => {
  test('observes nothing until a panel subscribes', async () => {
    const system = newSystem('bus-idle');
    const h = harness(system);

    // The whole reason this tap differs from SpanTap: the bus publishes on
    // every actor start and stop, so an observer installed at attach would
    // run for a panel nobody opened.
    system.spawn(QuietActor, 'before');
    system.eventStream.publish(new OrderPlaced('a'));
    // A fixed wait because the assertion IS an absence: nothing is
    // recorded, so there is no state to poll for.
    await Bun.sleep(40);

    expect(h.batches).toEqual([]);
    h.tap.uninstall();
  });

  test('tails published events once a panel is watching', async () => {
    const system = newSystem('bus-tail');
    const h = harness(system);
    h.tap.subscribersChanged(1);

    system.eventStream.publish(new OrderPlaced('a-1'));

    await awaitCondition(() => h.events().length >= 1, { label: 'the event was tailed' });
    const [event] = h.events();
    expect(event!.eventType).toBe('OrderPlaced');
    expect(event!.payload).toEqual({ orderId: 'a-1' });
    expect(event!.truncated).toBe(false);
    h.tap.uninstall();
  });

  test('sees an event even when nothing else subscribes to the bus', async () => {
    const system = newSystem('bus-alone');
    const h = harness(system);
    h.tap.subscribersChanged(1);

    // `publish` returns early when `subs` is empty, so an observer checked
    // after that return would see nothing on an unobserved system — which is
    // exactly the system a developer opens this panel on.
    expect(system.eventStream.hasSubscribers).toBe(false);
    system.eventStream.publish(new OrderPlaced('alone'));

    await awaitCondition(() => h.events().length >= 1, { label: 'the lone event was tailed' });
    h.tap.uninstall();
  });

  test('numbers events monotonically, so the panel can see a gap', async () => {
    const system = newSystem('bus-sequence');
    const h = harness(system);
    h.tap.subscribersChanged(1);

    for (let index = 0; index < 5; index++) {
      system.eventStream.publish(new OrderPlaced(`seq-${index}`));
    }

    await awaitCondition(() => h.events().length >= 5, { label: 'five events were tailed' });
    const numbers = h.events().map((event) => event.sequenceNumber);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    h.tap.uninstall();
  });

  test('drops the oldest past the cap and says how many', async () => {
    const system = newSystem('bus-cap');
    // A flush long enough that the whole volley lands in one buffer.
    const h = harness(system, 3, 10_000);
    h.tap.subscribersChanged(1);

    for (let index = 0; index < 8; index++) {
      system.eventStream.publish(new OrderPlaced(`over-${index}`));
    }

    // Reach into the flush directly rather than waiting out the tick: what
    // is being asserted is the buffer's arithmetic, not the scheduler's.
    (h.tap as unknown as { flush(): void }).flush();
    const batch = h.batches[0]!;
    expect(batch.events).toHaveLength(3);
    expect(batch.dropped).toBe(5);
    // The newest survive: a tail that falls behind should keep the recent
    // past, which is what the reader is looking at.
    expect(batch.events.map((event) => event.payload))
      .toEqual([{ orderId: 'over-5' }, { orderId: 'over-6' }, { orderId: 'over-7' }]);
    h.tap.uninstall();
  });

  test('stops observing when the last panel goes away', async () => {
    const system = newSystem('bus-detach');
    const h = harness(system);
    h.tap.subscribersChanged(1);
    system.eventStream.publish(new OrderPlaced('watched'));
    await awaitCondition(() => h.events().length >= 1, { label: 'the first event was tailed' });

    h.tap.subscribersChanged(0);
    const seen = h.events().length;
    system.eventStream.publish(new OrderPlaced('unwatched'));
    // A fixed wait because the assertion IS an absence: nothing arrives, so
    // there is no state to poll for.
    await Bun.sleep(40);

    expect(h.events()).toHaveLength(seen);
    h.tap.uninstall();
  });

  test('leaves the bus as it found it', async () => {
    const system = newSystem('bus-restore');
    const h = harness(system);
    h.tap.subscribersChanged(1);
    h.tap.uninstall();

    // An observer left behind because a browser tab closed would run for the
    // life of the system.  Proven by publishing after teardown: the tap must
    // not be reached at all.
    system.eventStream.publish(new OrderPlaced('after'));
    // A fixed wait because the assertion IS an absence: the tap must not
    // be reached at all, so nothing will ever arrive to poll for.
    await Bun.sleep(30);
    expect(h.events()).toEqual([]);
  });

  test('sanitises a payload the wire cannot carry', async () => {
    const system = newSystem('bus-cycle');
    const h = harness(system);
    h.tap.subscribersChanged(1);

    const cyclic: { kind: string; self?: unknown } = { kind: 'loop' };
    cyclic.self = cyclic;
    system.eventStream.publish(cyclic);

    await awaitCondition(() => h.events().length >= 1, { label: 'the cycle was tailed' });
    // Unsanitised, this throws in the frame encoder — on the socket, where
    // the failure is a dropped connection rather than a bad cell.
    expect(() => JSON.stringify(h.events()[0]!.payload)).not.toThrow();
    h.tap.uninstall();
  });

  test('a throwing observer cannot break publish', async () => {
    const system = newSystem('bus-guard');
    const h = harness(system);
    h.tap.subscribersChanged(1);
    // Force the tap's own handler to throw on the next event.
    system.eventStream._observe(() => { throw new Error('diagnostic exploded'); });

    // `publish` runs on every actor start and every dead-lettered tell, so an
    // observer that throws would turn `tell` into an API that throws.
    expect(() => system.eventStream.publish(new OrderPlaced('boom'))).not.toThrow();
    h.tap.uninstall();
  });

  test('reports that PubSub was never started, rather than no topics', async () => {
    const system = newSystem('bus-nopubsub');
    const h = harness(system);

    // "not started" and "started with nothing subscribed" are different
    // answers, and an empty list gives them identically.
    const result = await h.topics();
    expect(result.started).toBe(false);
    expect(result.topics).toEqual([]);
    h.tap.uninstall();
  });
});
