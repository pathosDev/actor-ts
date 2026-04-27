import { describe, expect, test } from 'bun:test';
import {
  ActorInitializationError,
  AllForOneStrategy,
  DeathPactError,
  decideBy,
  defaultStrategy,
  Directive,
  escalatingStrategy,
  OneForOneStrategy,
  stoppingStrategy,
} from '../../src/Supervision.js';

class FooError extends Error { constructor() { super('foo'); this.name = 'FooError'; } }
class BarError extends Error { constructor() { super('bar'); this.name = 'BarError'; } }

describe('Directive enum', () => {
  test('has the four standard directives', () => {
    expect(Directive.Resume).toBe('resume');
    expect(Directive.Restart).toBe('restart');
    expect(Directive.Stop).toBe('stop');
    expect(Directive.Escalate).toBe('escalate');
  });
});

describe('OneForOneStrategy', () => {
  test('scope is one-for-one', () => {
    const s = new OneForOneStrategy(() => Directive.Restart);
    expect(s.scope).toBe('one-for-one');
  });
  test('captures decider', () => {
    const decider = () => Directive.Stop;
    const s = new OneForOneStrategy(decider);
    expect(s.decider).toBe(decider);
  });
  test('defaults maxRetries=-1, withinTimeRangeMs=0', () => {
    const s = new OneForOneStrategy(() => Directive.Restart);
    expect(s.maxRetries).toBe(-1);
    expect(s.withinTimeRangeMs).toBe(0);
  });
  test('accepts overrides', () => {
    const s = new OneForOneStrategy(() => Directive.Restart, { maxRetries: 3, withinTimeRangeMs: 1000 });
    expect(s.maxRetries).toBe(3);
    expect(s.withinTimeRangeMs).toBe(1000);
  });
});

describe('AllForOneStrategy', () => {
  test('scope is all-for-one', () => {
    expect(new AllForOneStrategy(() => Directive.Restart).scope).toBe('all-for-one');
  });
  test('accepts options identical to OneForOne', () => {
    const s = new AllForOneStrategy(() => Directive.Stop, { maxRetries: 5, withinTimeRangeMs: 500 });
    expect(s.maxRetries).toBe(5);
    expect(s.withinTimeRangeMs).toBe(500);
  });
});

describe('pre-built strategies', () => {
  test('defaultStrategy restarts with limits', () => {
    expect(defaultStrategy.decider(new Error())).toBe(Directive.Restart);
    expect(defaultStrategy.maxRetries).toBe(10);
    expect(defaultStrategy.withinTimeRangeMs).toBe(60_000);
  });
  test('stoppingStrategy stops on any error', () => {
    expect(stoppingStrategy.decider(new Error())).toBe(Directive.Stop);
  });
  test('escalatingStrategy escalates on any error', () => {
    expect(escalatingStrategy.decider(new Error())).toBe(Directive.Escalate);
  });
});

describe('decideBy helper', () => {
  test('returns matched directive for known error types', () => {
    const decider = decideBy([
      { match: FooError, then: Directive.Resume },
      { match: BarError, then: Directive.Stop },
    ]);
    expect(decider(new FooError())).toBe(Directive.Resume);
    expect(decider(new BarError())).toBe(Directive.Stop);
  });

  test('returns default Restart for unmatched errors', () => {
    const decider = decideBy([{ match: FooError, then: Directive.Stop }]);
    expect(decider(new Error('anything'))).toBe(Directive.Restart);
  });

  test('accepts a custom fallback', () => {
    const decider = decideBy([{ match: FooError, then: Directive.Resume }], Directive.Escalate);
    expect(decider(new Error('anything'))).toBe(Directive.Escalate);
  });

  test('first match wins when multiple cases could apply', () => {
    class ChildOfFoo extends FooError {}
    const decider = decideBy([
      { match: FooError, then: Directive.Resume },
      { match: ChildOfFoo, then: Directive.Stop },
    ]);
    expect(decider(new ChildOfFoo())).toBe(Directive.Resume);
  });
});

describe('ActorInitializationError', () => {
  test('is an Error with the right name, message, and cause', () => {
    const cause = new Error('root cause');
    const e = new ActorInitializationError('failed to init Foo', cause);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ActorInitializationError');
    expect(e.message).toBe('failed to init Foo');
    expect(e.cause).toBe(cause);
  });
});

describe('DeathPactError', () => {
  test('carries the actor path and descriptive message', () => {
    const e = new DeathPactError('actor-ts://sys/user/foo');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('DeathPactError');
    expect(e.actorPath).toBe('actor-ts://sys/user/foo');
    expect(e.message).toContain('actor-ts://sys/user/foo');
  });
});
