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
    const p = Props.create(factory);
    expect(p.config.factory).toBe(factory);
    expect(p.config.supervisorStrategy).toBeUndefined();
    expect(p.config.dispatcher).toBeUndefined();
    expect(p.config.mailboxCapacity).toBeUndefined();
  });

  test('create factory is called to materialise an actor instance', () => {
    let calls = 0;
    const p = Props.create(() => { calls++; return new MyActor(); });
    const a = p.config.factory();
    const b = p.config.factory();
    expect(calls).toBe(2);
    expect(a).toBeInstanceOf(MyActor);
    expect(b).toBeInstanceOf(MyActor);
    expect(a).not.toBe(b); // fresh instance per call
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
    const d = new ImmediateDispatcher();
    const next = base.withDispatcher(d);
    expect(next.config.dispatcher).toBe(d);
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
    const d = new MicrotaskDispatcher();
    const final = base.withDispatcher(d).withMailboxCapacity(42).withSupervisorStrategy(strat);
    expect(final.config.dispatcher).toBe(d);
    expect(final.config.mailboxCapacity).toBe(42);
    expect(final.config.supervisorStrategy).toBe(strat);
    expect(base.config.dispatcher).toBeUndefined();
  });
});
