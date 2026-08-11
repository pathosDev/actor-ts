import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorOptions } from '../../../src/ActorOptions.js';
import { actorBlueprintOf, actorFactoryOf } from '../../../src/internal/ActorBlueprint.js';
import { ImmediateDispatcher } from '../../../src/Dispatcher.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

class ZeroArgumentActor extends Actor<string> {
  override onReceive(_m: string): void {}
}

class DependencyActor extends Actor<string> {
  constructor(readonly database: string) { super(); }
  override onReceive(_m: string): void {}
}

class DefaultedActor extends Actor<string> {
  constructor(readonly database = 'default') { super(); }
  override onReceive(_m: string): void {}
}

describe('actorFactoryOf', () => {
  test('a zero-argument class is constructed fresh on every call', () => {
    const factory = actorFactoryOf(ZeroArgumentActor);
    const first = factory();
    const second = factory();
    expect(first).toBeInstanceOf(ZeroArgumentActor);
    expect(second).toBeInstanceOf(ZeroArgumentActor);
    expect(first).not.toBe(second);
  });

  test('an arrow factory is passed through by identity', () => {
    const factory = () => new DependencyActor('postgres');
    expect(actorFactoryOf(factory)).toBe(factory);
  });

  test('a classic function factory still yields the actor it returns', () => {
    // `function` has a `prototype.constructor === itself`, so it takes the
    // class branch — harmless, because a constructor returning an object wins
    // over `this`.
    function makeActor(): DependencyActor { return new DependencyActor('redis'); }
    const actor = actorFactoryOf(makeActor)();
    expect(actor).toBeInstanceOf(DependencyActor);
    expect((actor as DependencyActor).database).toBe('redis');
  });

  test('a class with a required constructor argument is rejected by name', () => {
    expect(() => actorFactoryOf(DependencyActor as never))
      .toThrow(/DependencyActor needs 1 constructor argument/);
    // The message has to point at the way out, not just the problem.
    expect(() => actorFactoryOf(DependencyActor as never))
      .toThrow(/\(\) => new DependencyActor/);
  });

  test('a defaulted constructor argument is accepted — Function.length is 0', () => {
    const actor = actorFactoryOf(DefaultedActor)();
    expect((actor as DefaultedActor).database).toBe('default');
  });
});

describe('actorBlueprintOf', () => {
  test('without options the blueprint carries only the factory', () => {
    const blueprint = actorBlueprintOf(ZeroArgumentActor);
    expect(typeof blueprint.factory).toBe('function');
    expect(blueprint.dispatcher).toBeUndefined();
    expect(blueprint.mailboxCapacity).toBeUndefined();
    expect(blueprint.mailboxOverflow).toBeUndefined();
    expect(blueprint.internal).toBeUndefined();
  });

  test('a builder and a plain object produce the same blueprint', () => {
    const dispatcher = new ImmediateDispatcher();
    const factory = () => new ZeroArgumentActor();
    const fromBuilder = actorBlueprintOf(
      factory,
      ActorOptions.create<string>()
        .withDispatcher(dispatcher)
        .withMailboxCapacity(64)
        .withMailboxOverflow('drop-new'),
    );
    const fromPlain = actorBlueprintOf(factory, {
      dispatcher,
      mailboxCapacity: 64,
      mailboxOverflow: 'drop-new',
    });
    expect(fromBuilder).toEqual(fromPlain);
    // The blueprint is `ActorOptionsType & { factory }`, so a new option field
    // reaches the cell without anything being added here.  Asserted anyway:
    // the day someone picks fields explicitly, this is what notices.
    expect(fromBuilder.mailboxOverflow).toBe('drop-new');
  });

  test('the options are snapshotted — mutating the builder afterwards is inert', () => {
    // A running cell keeps its blueprint for life; a builder reused and
    // re-chained after the spawn must not reconfigure it retroactively.
    const options = ActorOptions.create<string>().withMailboxCapacity(10);
    const blueprint = actorBlueprintOf(ZeroArgumentActor, options);
    options.withMailboxCapacity(999);
    expect(blueprint.mailboxCapacity).toBe(10);
  });

  test('invalid options are rejected here, at the spawn call', () => {
    expect(() => actorBlueprintOf(ZeroArgumentActor, { mailboxCapacity: -1 }))
      .toThrow(OptionsError);
  });
});
