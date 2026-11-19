import { afterEach, describe, expect, test } from 'bun:test';
import { match, P } from 'ts-pattern';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import type { ActorRef } from '../../src/ActorRef.js';

/**
 * `ask()` must not change what the receiver observes about a message's
 * identity (#925).
 *
 * It used to rebuild every object-typed message as `{ ...message, replyTo }`,
 * and `typeof x === 'object'` is true for a `Map`, a `Set`, a `Date`, every
 * typed array and every class instance — so each of them arrived as a plain
 * object with its prototype gone and, for the built-in collections, its
 * contents too.  Only a genuine plain object is still rebuilt, because that
 * is the shape whose receivers read `msg.replyTo`; everything else is handed
 * over as the very object the caller passed, and its reply ref travels in
 * the `sender` slot, where it always also was.
 */

class DomainCommand {
  constructor(readonly amount: number) {}
  doubled(): number { return this.amount * 2; }
}

/** Keeps whatever arrived and answers through the sender slot. */
class Recorder extends Actor<unknown> {
  constructor(private readonly received: unknown[]) { super(); }
  override onReceive(message: unknown): void {
    this.received.push(message);
    this.sender.forEach((sender) => sender.tell('ok'));
  }
}

let system: ActorSystem | undefined;
afterEach(async () => {
  await system?.terminate();
  system = undefined;
});

/** One recorder, asked once with `message`; resolves to what it received. */
async function deliveredThroughAsk(message: unknown): Promise<unknown> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  system = ActorSystem.create('ask-identity', systemOptions);
  const received: unknown[] = [];
  const recorder = system.spawn(() => new Recorder(received), 'recorder') as ActorRef<unknown>;
  expect(await recorder.ask<string>(message as never, 2_000)).toBe('ok');
  expect(received).toHaveLength(1);
  return received[0];
}

describe('ask() delivers the message it was given (#925)', () => {
  test('a Map arrives as that Map, with its entries', async () => {
    const sent = new Map([['a', 1], ['b', 2]]);
    const delivered = await deliveredThroughAsk(sent);
    expect(delivered).toBe(sent);
    expect(delivered).toBeInstanceOf(Map);
    expect([...(delivered as Map<string, number>).entries()]).toEqual([['a', 1], ['b', 2]]);
  });

  test('a Set, a Date and a typed array keep their prototypes and contents', async () => {
    const set = new Set([1, 2, 3]);
    expect(await deliveredThroughAsk(set)).toBe(set);
    await system?.terminate();

    const date = new Date(1_700_000_000_000);
    const deliveredDate = await deliveredThroughAsk(date);
    expect(deliveredDate).toBeInstanceOf(Date);
    expect((deliveredDate as Date).getTime()).toBe(1_700_000_000_000);
    await system?.terminate();

    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const deliveredBytes = await deliveredThroughAsk(bytes);
    expect(deliveredBytes).toBeInstanceOf(Uint8Array);
    expect((deliveredBytes as Uint8Array).byteLength).toBe(8);
  });

  test('an array arrives as an array, not as an index-keyed object', async () => {
    const sent = [1, 2, 3];
    const delivered = await deliveredThroughAsk(sent);
    expect(Array.isArray(delivered)).toBe(true);
    expect(delivered).toEqual([1, 2, 3]);
  });

  test('a class instance keeps instanceof and its methods, and P.instanceOf matches it', async () => {
    const delivered = await deliveredThroughAsk(new DomainCommand(21));
    expect(delivered).toBeInstanceOf(DomainCommand);
    expect((delivered as DomainCommand).doubled()).toBe(42);
    const matched = match(delivered)
      .with(P.instanceOf(DomainCommand), (command) => command.amount)
      .otherwise(() => -1);
    expect(matched).toBe(21);
  });

  test('a plain object still carries replyTo, and the caller\'s object is left untouched', async () => {
    const sent = { kind: 'get' };
    const delivered = await deliveredThroughAsk(sent) as { kind: string; replyTo?: unknown };
    expect(delivered.kind).toBe('get');
    expect(delivered.replyTo).toBeDefined();
    expect(delivered).not.toBe(sent);
    expect('replyTo' in sent).toBe(false);
  });

  test('a null-prototype object counts as plain and carries replyTo', async () => {
    const sent = Object.assign(Object.create(null) as Record<string, unknown>, { kind: 'get' });
    const delivered = await deliveredThroughAsk(sent) as { kind: string; replyTo?: unknown };
    expect(delivered.kind).toBe('get');
    expect(delivered.replyTo).toBeDefined();
  });
});
