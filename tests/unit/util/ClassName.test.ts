/**
 * `classNameOf` says what class a value is without saying anything *from* the
 * value — and that has to hold for a value a peer built, not only for one this
 * process constructed (#1442).
 *
 * It used to read `value.constructor.name`.  For anything code constructed that
 * is the class; for anything a codec decoded it is peer data, because
 * `JsonSerializer` keeps a body's `constructor` key as an own property.  So the
 * "class name" of `{"constructor": {"name": …}}` was whatever the peer wrote,
 * and it reached the two sinks that print the helper's answer — the dead-letter
 * record, which is on by default, and the `debug-unhandled` line:
 *
 *   - a name carrying CR/LF forged a second log record;
 *   - a name that is not a string came back as an object, and interpolating it
 *     threw out of `deadLetters.tell`.  An actor declining that body through
 *     `Actor.unhandled` then failed and restarted — for the receptionist, with
 *     every registration it held.  One peer body failing a framework actor is
 *     the outcome #713 closed; the #1178 sink had reopened it;
 *   - a getter or a Proxy trap that throws escaped the helper itself.
 *
 * The answer is now read off the prototype chain.  A decoded body has nothing
 * there but `Object.prototype` — both decoders keep a `__proto__` key as data
 * rather than re-parenting the object (#581) — so the own key is never
 * consulted, and nothing about the payload needs escaping or clipping because
 * nothing about the payload is read.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import {
  Find,
  Listing,
  ReceptionistId,
  Register,
  ServiceKey,
} from '../../../src/discovery/index.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { classNameOf } from '../../../src/util/ClassName.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

const serializer = new JsonSerializer();

/** A body exactly as a peer's JSON frame decodes on this node. */
function decoded(body: Record<string, unknown>): unknown {
  return serializer.fromBinary(new TextEncoder().encode(JSON.stringify(body)), '');
}

/** A `constructor.name` that would forge a second record wherever it is printed. */
const forgedName = (): unknown => decoded({
  kind: 'receptionist.FromTheFuture',
  constructor: { name: 'Evil\r\nINFO forged record' },
});

/** A `constructor.name` that is not a string, and that no template literal can render. */
const unprintableName = (): unknown => decoded({
  kind: 'receptionist.FromTheFuture',
  constructor: { name: { toString: 0 } },
});

const quietKit = (name: string): TestKit => TestKit.create(name, TestKitOptions.create()
  .withLogger(new NoopLogger())
  .withLogLevel(LogLevel.Off));

class Service extends Actor<string> {
  override onReceive(_message: string): void { /* only ever registered */ }
}

/** Declines everything it is told, and counts how often it had to start. */
class Decliner extends Actor<unknown> {
  constructor(private readonly starts: { count: number }) {
    super();
  }

  override preStart(): void {
    this.starts.count += 1;
  }

  override onReceive(message: unknown): void {
    this.unhandled(message);
  }
}

describe('classNameOf — what code constructed', () => {
  test('names a class instance by its class', () => {
    class Order {}
    expect(classNameOf(new Order())).toBe('Order');
    expect(classNameOf(new Map())).toBe('Map');
    expect(classNameOf([])).toBe('Array');
    expect(classNameOf({})).toBe('Object');
    expect(classNameOf(new TypeError('x'))).toBe('TypeError');
  });

  test('answers null and the primitives with what they are, never a boxed class', () => {
    expect(classNameOf(null)).toBe('null');
    expect(classNameOf(undefined)).toBe('undefined');
    expect(classNameOf(5)).toBe('number');
    expect(classNameOf('text')).toBe('string');
    expect(classNameOf(true)).toBe('boolean');
    expect(classNameOf(5n)).toBe('bigint');
    expect(classNameOf(Symbol('s'))).toBe('symbol');
    expect(classNameOf(() => 1)).toBe('function');
  });

  test('a prototype-less object is an Object, not a crash', () => {
    expect(classNameOf(Object.create(null))).toBe('Object');
  });
});

describe('classNameOf — what a peer built (#1442)', () => {
  test('an own constructor key is data, so a CR/LF in it never reaches the answer', () => {
    const body = forgedName();
    // The control: the decoder really did keep the peer's key, so the case is
    // the one a frame produces and not one this test made up.
    expect(Object.hasOwn(body as object, 'constructor')).toBe(true);
    expect(classNameOf(body)).toBe('Object');
  });

  test('a non-string constructor name never comes back, so rendering the answer cannot throw', () => {
    const body = unprintableName();
    expect(Object.hasOwn(body as object, 'constructor')).toBe(true);
    const name = classNameOf(body);
    expect(typeof name).toBe('string');
    expect(name).toBe('Object');
    expect(() => `${name}`).not.toThrow();
  });

  test('a class whose own name is not a string is answered with the floor', () => {
    // Nothing a peer can produce — no decoder builds class instances from
    // wire data — but the `typeof` check is what refuses it, and it is the
    // same check that keeps a non-string out of every template downstream.
    class Odd {}
    Object.defineProperty(Odd, 'name', { value: 42 });
    expect(classNameOf(new Odd())).toBe('Object');
  });

  test('a throwing getter or Proxy trap falls back to the floor instead of escaping', () => {
    const trappedPrototype = {};
    Object.defineProperty(trappedPrototype, 'constructor', {
      get(): never { throw new Error('constructor getter'); },
    });
    expect(classNameOf(Object.create(trappedPrototype))).toBe('Object');

    class Loud {}
    Object.defineProperty(Loud, 'name', { get(): never { throw new Error('name getter'); } });
    expect(classNameOf(new Loud())).toBe('Object');

    const trap = (): never => { throw new Error('proxy trap'); };
    const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap });
    expect(classNameOf(proxy)).toBe('Object');
  });
});

describe('the sinks that print it (#1442, #713)', () => {
  test('the dead-letter record names Object, on one line, and telling it does not throw', async () => {
    const log = new RecordingLogger();
    const kit = TestKit.create('class-name-record', TestKitOptions.create().withLogger(log));
    try {
      const recipient = kit.system.spawn(Service, 'recipient');
      expect(() => kit.system.deadLetters.tell(new DeadLetter(unprintableName(), null, recipient))).not.toThrow();
      kit.system.deadLetters.tell(new DeadLetter(forgedName(), null, recipient));

      // The record is written on the teller's stack, so both are here already.
      const records = log.records
        .filter((record) => record.message.includes('dead letter to '))
        .map((record) => record.message);
      expect(records).toEqual([
        `dead letter to ${recipient.path.toString()}: Object`,
        `dead letter to ${recipient.path.toString()}: Object`,
      ]);
    } finally {
      await kit.system.terminate();
    }
  });

  test('an actor declining such a body through Actor.unhandled keeps running', async () => {
    const kit = quietKit('class-name-decliner');
    try {
      const probe = kit.createTestProbe();
      kit.system.eventStream.subscribe(probe, DeadLetter);
      const starts = { count: 0 };
      const decliner = kit.system.spawn(() => new Decliner(starts), 'decliner');

      decliner.tell(unprintableName());
      decliner.tell({ kind: 'marker' });

      // Both letters are published before the record that used to throw, so
      // both arrive either way; what the marker's letter proves is that the
      // hostile body has been fully processed by the time it is read.
      const first = await probe.receiveOne(1_000) as DeadLetter;
      const second = await probe.receiveOne(1_000) as DeadLetter;
      expect(first.recipient.path.toString()).toBe(decliner.path.toString());
      expect(second.message).toEqual({ kind: 'marker' });
      expect(starts.count).toBe(1);
    } finally {
      await kit.system.terminate();
    }
  });

  test('the receptionist keeps its registrations through such a body', async () => {
    const kit = quietKit('class-name-receptionist');
    try {
      const probe = kit.createTestProbe();
      const receptionist = kit.system.extension(ReceptionistId).start(null);
      const service = kit.system.spawn(Service, 'service');
      const key = ServiceKey.of<string>('kept');
      receptionist.tell(new Register(key, service));

      // An unknown kind, which the receptionist declines through
      // `Actor.unhandled`, carrying the constructor key that used to restart it.
      receptionist.tell(unprintableName() as never);
      receptionist.tell(new Find(key, probe));

      const listing = await probe.expectMessageType(Listing, 1_000) as Listing<string>;
      expect(listing.refs.map((ref) => ref.path.toString())).toEqual([service.path.toString()]);
    } finally {
      await kit.system.terminate();
    }
  });
});
