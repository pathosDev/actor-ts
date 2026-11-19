import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorPath } from '../../src/ActorPath.js';
import { ActorRef } from '../../src/ActorRef.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { EventStream } from '../../src/EventStream.js';
import { JsonLogger, LogLevel } from '../../src/Logger.js';
import { ActorStarted } from '../../src/SystemMessages.js';
import { assertCompletesWithin } from '../util/AsyncAssertions.js';
import { awaitCondition } from '../util/AwaitCondition.js';

/*
 * A failure the logger cannot render stays contained (found while #1230).
 *
 * Every guard on the bus — around a delivery, a predicate, a channel match, a
 * comparison and a callback — ends in a warning that carries what was thrown,
 * and rendering that value runs code the subscriber chose.  The stock loggers
 * throw on some of it: `JsonLogger` reads `message` and `stack` off an `Error`
 * and asks `instanceof` of anything.  The warnings were unguarded, so such a
 * value left the guard through its own report.  From the delivery,
 * channel-match and callback guards `publish` threw and every subscription
 * after the faulty one missed the event — on a running system the warning for
 * a callback that threw on an actor start failed the system's own guardians;
 * from the comparison guard `subscribe` and `unsubscribe` threw; from the
 * predicate guard the throw reached the delivery guard, which logged a failed
 * delivery instead of the predicate's failure.
 *
 * The stock loggers have since been made total (#1749), so they no longer
 * throw on these values.  The bus's guards stay pinned against a caller-supplied
 * logger that still does — `Logger` is an extension point — through
 * {@link fragileLogger}, which renders its arguments with `String()` and so
 * throws exactly where `JsonLogger` used to.
 */

class EventA { constructor(public readonly payload: string) {} }

/** An error whose `message` cannot be read — so its `toString` throws, and so does a fragile logger. */
class UnrenderableError extends Error {
  override get message(): string { throw new Error('the message of this error cannot be read'); }
}

/** A revoked proxy: every operation on it throws, `toString` and `instanceof` included. */
function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

const unrenderableValues: ReadonlyArray<readonly [string, () => unknown]> = [
  ['an error whose message getter throws', () => new UnrenderableError()],
  ['a revoked proxy', revokedProxy],
];

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

/** The stock JSON logger, writing into memory instead of stdout. */
function jsonLogger(): { readonly logger: JsonLogger; readonly messages: () => string[] } {
  const lines: string[] = [];
  const logger = new JsonLogger(LogLevel.Warn, '', {}, { write: (line) => { lines.push(line); } });
  return { logger, messages: () => lines.map((line) => (JSON.parse(line) as { msg: string }).msg) };
}

/**
 * A caller-supplied logger that renders its arguments with `String()`, and so
 * throws on both fixture values — the shape the stock `JsonLogger` had before
 * #1749.  A line it can render is recorded.
 */
function fragileLogger(): { readonly logger: { warn(message: string, ...args: unknown[]): void }; readonly messages: () => string[] } {
  const lines: string[] = [];
  const logger = {
    warn(message: string, ...args: unknown[]): void {
      lines.push([message, ...args.map((arg) => String(arg))].join(' '));
    },
  };
  return { logger, messages: () => lines };
}

/** A bus whose log is a fragile caller-supplied logger. */
function busWithFragileLogger(): { readonly bus: EventStream; readonly messages: () => string[] } {
  const { logger, messages } = fragileLogger();
  const bus = new EventStream();
  bus.log = logger;
  return { bus, messages };
}

const NOT_RENDERED = 'could not be rendered by the logger';

describe('EventStream reports a failure the logger cannot render, and contains it all the same', () => {
  test('the fixture values cannot be rendered — `String()` itself throws on them', () => {
    for (const [, value] of unrenderableValues) expect(() => String(value())).toThrow();
  });

  test.each(unrenderableValues)('a callback that throws %s', (_label, value) => {
    const { bus, messages } = busWithFragileLogger();
    bus.subscribeFunction(EventA, () => { throw value(); });
    const seen: string[] = [];
    bus.subscribeFunction(EventA, (event) => { seen.push(event.payload); });

    expect(() => bus.publish(new EventA('x'))).not.toThrow();
    expect(seen).toEqual(['x']);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain('threw — skipping it for this event');
    expect(messages()[0]).toContain(NOT_RENDERED);
  });

  test.each(unrenderableValues)('a channel whose instanceof throws %s', (_label, value) => {
    const { bus, messages } = busWithFragileLogger();
    const throwingChannel = { [Symbol.hasInstance](): boolean { throw value(); } };
    bus.subscribeFunction(throwingChannel as never, () => {});
    const seen: string[] = [];
    bus.subscribeFunction(EventA, (event) => { seen.push(event.payload); });

    expect(() => bus.publish(new EventA('x'))).not.toThrow();
    expect(seen).toEqual(['x']);
    expect(messages()[0]).toContain('matching an event against an unnamed channel threw');
    expect(messages()[0]).toContain(NOT_RENDERED);
  });

  test.each(unrenderableValues)('an actor subscriber whose tell throws %s', (_label, value) => {
    const { bus, messages } = busWithFragileLogger();
    const exploding = new RecordingRef('exploding');
    exploding.tell = () => { throw value(); };
    bus.subscribe(exploding, EventA);
    const healthy = new RecordingRef('healthy');
    bus.subscribe(healthy, EventA);

    expect(() => bus.publish(new EventA('x'))).not.toThrow();
    expect(healthy.received).toHaveLength(1);
    expect(messages()[0]).toContain('delivering to EventA failed');
    expect(messages()[0]).toContain(NOT_RENDERED);
  });

  test.each(unrenderableValues)('a predicate that throws %s', (_label, value) => {
    const { bus, messages } = busWithFragileLogger();
    bus.subscribe(new RecordingRef('filtered'), EventA, () => { throw value(); });
    const healthy = new RecordingRef('healthy');
    bus.subscribe(healthy, EventA);

    expect(() => bus.publish(new EventA('x'))).not.toThrow();
    expect(healthy.received).toHaveLength(1);
    expect(messages()[0]).toContain('predicate threw on EventA delivery');
    expect(messages()[0]).toContain(NOT_RENDERED);
  });

  test.each(unrenderableValues)('a stored subscriber whose equals throws %s', (_label, value) => {
    // `unsubscribe` compares against every stored subscriber, and every actor
    // stop calls it.
    const { bus, messages } = busWithFragileLogger();
    const hostile = {
      path: new ActorPath('', null, 'test-sys').child('hostile'),
      tell: () => {},
      equals: () => { throw value(); },
    } as unknown as ActorRef;
    bus.subscribe(hostile, EventA);
    const healthy = new RecordingRef('healthy');

    expect(() => bus.subscribe(healthy, EventA)).not.toThrow();
    expect(() => bus.unsubscribe(healthy)).not.toThrow();
    // One comparison on the subscribe's dedup check, one on the unsubscribe.
    expect(messages()).toHaveLength(2);
    expect(messages().every((message) => message.includes('comparing against a subscriber of EventA threw')))
      .toBe(true);
    expect(messages().every((message) => message.includes(NOT_RENDERED))).toBe(true);
  });

  test.each(unrenderableValues)('a callback whose promise rejects with %s', async (_label, value) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { bus, messages } = busWithFragileLogger();
      const rejected = value();
      bus.subscribeFunction(EventA, async () => { throw rejected; });

      expect(() => bus.publish(new EventA('x'))).not.toThrow();
      await awaitCondition(() => messages().length === 1, {
        timeoutMs: 1_000,
        label: 'the rejection was reported',
      });
      // One macrotask turn, because the rejection tracker reports once the
      // microtask queue has drained — not a wait for anything to happen.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(messages()[0]).toContain('returned a promise that rejected');
      expect(messages()[0]).toContain(NOT_RENDERED);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  test('a logger that throws on every line never makes publish throw', () => {
    // Nothing is left to report with, so nothing is reported — but the guard
    // still holds: everyone else receives the event.
    const bus = new EventStream();
    bus.log = { warn: () => { throw new Error('logger boom'); } };
    bus.subscribeFunction(EventA, () => { throw new Error('callback boom'); });
    const seen: string[] = [];
    bus.subscribeFunction(EventA, (event) => { seen.push(event.payload); });

    expect(() => bus.publish(new EventA('x'))).not.toThrow();
    expect(seen).toEqual(['x']);
  });

  test('a logger that throws does not make a nested publish throw at the depth bound either', () => {
    // The bound's warning is reached inside a callback's own `publish`, so a
    // throw from it would surface there, in the callback that published.
    const bus = new EventStream();
    bus.log = { warn: () => { throw new Error('logger boom'); } };
    let calls = 0;
    let publishThrew = 0;
    bus.subscribeFunction(EventA, (event) => {
      calls++;
      try {
        bus.publish(new EventA(event.payload));
      } catch {
        publishThrew++;
      }
    });

    expect(() => bus.publish(new EventA('loop'))).not.toThrow();
    expect(calls).toBe(16);
    expect(publishThrew).toBe(0);
  });
});

describe('EventStream on a running system, with the stock JSON logger', () => {
  test('a callback that throws an unrenderable value on every start costs no actor its start', async () => {
    // The guardians start after the system is created, so a callback
    // subscribed straight away sees their starts too — and the warning for
    // its throw used to fail them, which took the whole system down.
    const { logger, messages } = jsonLogger();
    const system = ActorSystem.create('es-unrenderable-start', ActorSystemOptions.create().withLogger(logger));
    system.eventStream.subscribeFunction(ActorStarted, () => { throw new UnrenderableError(); });
    const started: ActorStarted[] = [];
    system.eventStream.subscribeFunction(ActorStarted, (event) => { started.push(event); });

    class Quiet extends Actor<string> {
      override onReceive(): void {}
    }
    const ref = system.spawn(Quiet, 'quiet');
    await awaitCondition(() => started.some((event) => event.actor.equals(ref)), {
      timeoutMs: 2_000,
      label: 'the actor started, and its start reached the callback behind the throwing one',
    });
    await assertCompletesWithin(system.terminate(), 2_000, 'terminate() after unrenderable callback throws');

    expect(messages().some((message) => message.includes('initialization failed'))).toBe(false);
    // The stock logger renders the value itself now (#1749): the warning is
    // written in full, with the placeholder where the unreadable message was.
    expect(messages().some((message) => message.includes('threw — skipping it for this event'))).toBe(true);
    expect(messages().some((message) => message.includes(NOT_RENDERED))).toBe(false);
  });
});
