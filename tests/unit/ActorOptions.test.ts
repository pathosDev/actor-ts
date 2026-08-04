import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorOptions, ActorOptionsValidator, type ActorOptionsType } from '../../src/ActorOptions.js';
import { ImmediateDispatcher, MicrotaskDispatcher } from '../../src/Dispatcher.js';
import { Mailbox } from '../../src/internal/Mailbox.js';
import { OneForOneStrategy, Directive } from '../../src/Supervision.js';
import { OptionsError } from '../../src/util/OptionsValidator.js';

class MyActor extends Actor<string> {
  override onReceive(_m: string): void {}
}

const IDENTITY = { entityId: 'cart-7', typeName: 'cart', shardId: 3 };

/**
 * Read a builder the way every consumer does — a builder IS its settings, but
 * the fields live on the instance, not in the builder's declared type.
 */
const read = (options: ActorOptions<string>): Partial<ActorOptionsType<string>> =>
  ({ ...(options as Partial<ActorOptionsType<string>>) });

describe('ActorOptions', () => {
  test('a fresh builder sets nothing — every field falls through to the defaults', () => {
    const options = ActorOptions.create<string>();
    expect(Object.keys(options)).toEqual([]);
    expect(options.build()).toEqual({});
  });

  test('withSupervisorStrategy records the strategy', () => {
    const strategy = new OneForOneStrategy(() => Directive.Restart);
    expect(read(ActorOptions.create<string>().withSupervisorStrategy(strategy)).supervisorStrategy)
      .toBe(strategy);
  });

  test('withDispatcher records the dispatcher', () => {
    const dispatcher = new ImmediateDispatcher();
    expect(read(ActorOptions.create<string>().withDispatcher(dispatcher)).dispatcher).toBe(dispatcher);
  });

  test('withMailboxCapacity records the capacity', () => {
    expect(read(ActorOptions.create<string>().withMailboxCapacity(128)).mailboxCapacity).toBe(128);
  });

  test('withMailbox records the factory', () => {
    const mailbox = (): Mailbox<string> => new Mailbox<string>();
    expect(read(ActorOptions.create<string>().withMailbox(mailbox)).mailbox).toBe(mailbox);
  });

  test('withInternal defaults to true and can be set explicitly', () => {
    expect(read(ActorOptions.create<string>().withInternal()).internal).toBe(true);
    expect(read(ActorOptions.create<string>().withInternal(false)).internal).toBe(false);
  });

  test('withEntity records the sharding identity', () => {
    expect(read(ActorOptions.create<string>().withEntity(IDENTITY)).entity).toBe(IDENTITY);
  });

  test('a builder IS its settings — spreading yields the fields, not the methods', () => {
    const dispatcher = new MicrotaskDispatcher();
    const options = ActorOptions.create<string>()
      .withDispatcher(dispatcher)
      .withMailboxCapacity(42);
    // The `withX` / `build` methods live on the prototype, so a spread — which
    // is how every consumer reads these — sees only what was set.
    expect({ ...options }).toEqual({ dispatcher, mailboxCapacity: 42 });
  });

  test('the builder mutates in place and returns itself', () => {
    const options = ActorOptions.create<string>();
    const chained = options.withMailboxCapacity(7);
    expect(chained).toBe(options);
    expect(read(options).mailboxCapacity).toBe(7);
  });

  test('a plain object is interchangeable with a builder', () => {
    const plain: ActorOptionsType<string> = { mailboxCapacity: 99, internal: true };
    expect({ ...ActorOptions.create<string>().withMailboxCapacity(99).withInternal() })
      .toEqual(plain);
  });
});

describe('ActorOptionsValidator', () => {
  const validate = (settings: Partial<ActorOptionsType<string>>): void =>
    new ActorOptionsValidator<string>().validate(settings);

  test('an unset mailboxCapacity passes — every field is optional', () => {
    expect(() => validate({})).not.toThrow();
  });

  test('a positive integer capacity passes', () => {
    expect(() => validate({ mailboxCapacity: 1 })).not.toThrow();
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'mailboxCapacity %p is rejected as OptionsError',
    (mailboxCapacity) => {
      expect(() => validate({ mailboxCapacity })).toThrow(OptionsError);
      expect(() => validate({ mailboxCapacity })).toThrow(/ActorOptions.*mailboxCapacity/s);
    },
  );

  test('a bad capacity is caught at the spawn call, not inside the mailbox', () => {
    // The point of validating here: the message names the options family the
    // caller wrote, not `BoundedMailbox`, which is several frames deeper.
    expect(() => validate({ mailboxCapacity: 0 })).toThrow(/ActorOptions/);
  });
});
