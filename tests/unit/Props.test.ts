import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ImmediateDispatcher, MicrotaskDispatcher } from '../../src/Dispatcher.js';
import { Props } from '../../src/Props.js';
import { OneForOneStrategy, Directive } from '../../src/Supervision.js';

class MyActor extends Actor<string> {
  override onReceive(_: string): void {}
}

describe('Props', () => {
  test('create stores the factory', () => {
    const factory = () => new MyActor();
    const props = Props.create(factory);
    expect(props.config.factory).toBe(factory);
    expect(props.config.supervisorStrategy).toBeUndefined();
    expect(props.config.dispatcher).toBeUndefined();
    expect(props.config.mailboxCapacity).toBeUndefined();
  });

  test('create factory is called to materialise an actor instance', () => {
    let calls = 0;
    const props = Props.create(() => { calls++; return new MyActor(); });
    const actorA = props.config.factory();
    const actorB = props.config.factory();
    expect(calls).toBe(2);
    expect(actorA).toBeInstanceOf(MyActor);
    expect(actorB).toBeInstanceOf(MyActor);
    expect(actorA).not.toBe(actorB); // fresh instance per call
  });

  test('withSupervisorStrategy returns a new Props with the strategy set', () => {
    const base = Props.create(() => new MyActor());
    const strat = new OneForOneStrategy(() => Directive.Restart);
    const next = base.withSupervisorStrategy(strat);
    expect(next).not.toBe(base);
    expect(next.config.supervisorStrategy).toBe(strat);
    expect(base.config.supervisorStrategy).toBeUndefined(); // base is immutable
  });

  test('withDispatcher returns a new Props with the dispatcher set', () => {
    const base = Props.create(() => new MyActor());
    const dispatcher = new ImmediateDispatcher();
    const next = base.withDispatcher(dispatcher);
    expect(next.config.dispatcher).toBe(dispatcher);
    expect(base.config.dispatcher).toBeUndefined();
  });

  test('withMailboxCapacity returns a new Props with the capacity set', () => {
    const base = Props.create(() => new MyActor());
    const next = base.withMailboxCapacity(128);
    expect(next.config.mailboxCapacity).toBe(128);
    expect(base.config.mailboxCapacity).toBeUndefined();
  });

  test('chained with* calls accumulate without mutating earlier props', () => {
    const base = Props.create(() => new MyActor());
    const strat = new OneForOneStrategy(() => Directive.Stop);
    const dispatcher = new MicrotaskDispatcher();
    const final = base.withDispatcher(dispatcher).withMailboxCapacity(42).withSupervisorStrategy(strat);
    expect(final.config.dispatcher).toBe(dispatcher);
    expect(final.config.mailboxCapacity).toBe(42);
    expect(final.config.supervisorStrategy).toBe(strat);
    expect(base.config.dispatcher).toBeUndefined();
  });
});
