import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorRestarted, ActorStopped } from '../../src/SystemMessages.js';
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
  type SupervisorStrategy,
} from '../../src/Supervision.js';
import { awaitCondition } from '../util/AwaitCondition.js';
import { systemFixture } from './__shared__/system-fixture.js';

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
    const strategy = new OneForOneStrategy(() => Directive.Restart);
    expect(strategy.scope).toBe('one-for-one');
  });
  test('captures decider', () => {
    const decider = () => Directive.Stop;
    const strategy = new OneForOneStrategy(decider);
    expect(strategy.decider).toBe(decider);
  });
  test('defaults maxRetries=-1, withinTimeRangeMs=0', () => {
    const strategy = new OneForOneStrategy(() => Directive.Restart);
    expect(strategy.maxRetries).toBe(-1);
    expect(strategy.withinTimeRangeMs).toBe(0);
  });
  test('accepts overrides', () => {
    const strategy = new OneForOneStrategy(() => Directive.Restart, { maxRetries: 3, withinTimeRangeMs: 1000 });
    expect(strategy.maxRetries).toBe(3);
    expect(strategy.withinTimeRangeMs).toBe(1000);
  });
});

describe('AllForOneStrategy', () => {
  test('scope is all-for-one', () => {
    expect(new AllForOneStrategy(() => Directive.Restart).scope).toBe('all-for-one');
  });
  test('accepts options identical to OneForOne', () => {
    const strategy = new AllForOneStrategy(() => Directive.Stop, { maxRetries: 5, withinTimeRangeMs: 500 });
    expect(strategy.maxRetries).toBe(5);
    expect(strategy.withinTimeRangeMs).toBe(500);
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
    const error = new ActorInitializationError('failed to init Foo', cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ActorInitializationError');
    expect(error.message).toBe('failed to init Foo');
    expect(error.cause).toBe(cause);
  });
});

describe('DeathPactError', () => {
  test('carries the actor path and descriptive message', () => {
    const error = new DeathPactError('actor-ts://sys/user/foo');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DeathPactError');
    expect(error.actorPath).toBe('actor-ts://sys/user/foo');
    expect(error.message).toContain('actor-ts://sys/user/foo');
  });
});

/**
 * `ActorStopped` and `ActorRestarted` are the discriminators these tests
 * need: the cell publishes the first only from `finalizeTermination` and the
 * second only from `onRecreate`, so exactly one of them follows a failure.
 * Waiting for the one that should arrive is a positive signal — no test has
 * to assert the absence of a restart that simply had not happened yet.
 */
class Boom extends Actor<string> {
  override onReceive(_message: string): void { throw new Error('boom'); }
}

/** Records lifecycle events as `EventName:actorName` for easy assertions. */
class LifecycleCollector extends Actor<ActorStopped | ActorRestarted> {
  constructor(private readonly seen: string[]) { super(); }
  override onReceive(event: ActorStopped | ActorRestarted): void {
    this.seen.push(`${event.constructor.name}:${event.actor.path.name}`);
  }
}

describe('supervisor strategy in the spawn options', () => {
  const sys = systemFixture('supervision-options');

  /** Subscribe a fresh collector to both outcomes and hand back its log. */
  function collectOutcomes(probeName: string): string[] {
    const seen: string[] = [];
    const probe = sys().spawn(() => new LifecycleCollector(seen), probeName);
    sys().eventStream.subscribe(probe, ActorStopped);
    sys().eventStream.subscribe(probe, ActorRestarted);
    return seen;
  }

  test('overrides the guardian that would otherwise restart the child', async () => {
    const seen = collectOutcomes('collector-stop');
    const ref = sys().spawn(Boom, 'stops-by-options', { supervisorStrategy: stoppingStrategy });

    ref.tell('fail');

    await awaitCondition(() => seen.includes('ActorStopped:stops-by-options'), {
      label: 'the per-child strategy stopped the actor',
    });
    // The user guardian restarts by default.  Since exactly one outcome
    // follows a failure, seeing the stop proves the restart never happened.
    expect(seen).not.toContain('ActorRestarted:stops-by-options');
  });

  test('falls through to the guardian when the options carry no strategy', async () => {
    const seen = collectOutcomes('collector-restart');
    const ref = sys().spawn(Boom, 'restarts-by-guardian');

    ref.tell('fail');

    await awaitCondition(() => seen.includes('ActorRestarted:restarts-by-guardian'), {
      label: 'the user guardian restarted the actor',
    });
  });

  test('beats an explicit parent strategy, and leaves siblings alone', async () => {
    const seen = collectOutcomes('collector-siblings');

    class Parent extends Actor<string> {
      override preStart(): void {
        this.context.spawn(Boom, 'fragile', { supervisorStrategy: stoppingStrategy });
        this.context.spawn(Boom, 'resilient');
      }
      override supervisorStrategy(): SupervisorStrategy {
        return new OneForOneStrategy(() => Directive.Restart, { maxRetries: -1 });
      }
      override onReceive(childName: string): void {
        this.context.child(childName).forEach((child) => child.tell('fail' as never));
      }
    }

    const parent = sys().spawn(Parent, 'sibling-parent');
    parent.tell('fragile');
    parent.tell('resilient');

    await awaitCondition(
      () => seen.includes('ActorStopped:fragile') && seen.includes('ActorRestarted:resilient'),
      { label: 'the fragile child stopped while its sibling restarted' },
    );
    expect(seen).not.toContain('ActorRestarted:fragile');
  });
});

/**
 * `Actor.preRestart`'s JSDoc and the `onRecreate` call site both used to claim
 * the default stops children.  It never did — it only calls `postStop()` — and
 * the docs said otherwise for long enough that these pin the real behaviour.
 * If someone makes `preRestart` stop children, both of these fail and force the
 * documentation to move with the code (#899).
 */
describe('restart and children', () => {
  const sys = systemFixture('restart-children-tests');

  test('children survive their parent restarting', async () => {
    const events: string[] = [];
    class Child extends Actor<string> {
      override postStop(): void { events.push('child:postStop'); }
      override onReceive(m: string): void { events.push(`child:${m}`); }
    }
    class Parent extends Actor<string> {
      private child: import('../../src/ActorRef.js').ActorRef<string> | null = null;
      override preStart(): void {
        events.push('parent:preStart');
        // Anonymous, so the second preStart cannot collide — see the named
        // case below for what happens when it can.
        this.child ??= this.context.spawnAnonymous(Child);
      }
      override onReceive(m: string): void {
        if (m === 'boom') throw new FooError();
        this.child?.tell(m);
      }
    }

    const parent = sys().spawn(Parent, 'keeps-children');
    parent.tell('boom');
    await awaitCondition(
      () => events.filter((e) => e === 'parent:preStart').length >= 2,
      { label: 'the parent restarted' },
    );

    // The child was never stopped, and the same instance still answers.
    expect(events).not.toContain('child:postStop');
    parent.tell('still-here');
    await awaitCondition(
      () => events.includes('child:still-here'),
      { label: 'the surviving child received a message after the restart' },
    );
  });

  test('a named child spawned in preStart collides on the restart', async () => {
    // The sharp edge the supervision docs now call out: preStart runs again
    // while the previous incarnation's children are still in the child map, so
    // the second spawn hits the uniqueness check and the restart fails.
    const failures: string[] = [];
    class Child extends Actor<string> { override onReceive(_: string): void {} }
    class Parent extends Actor<string> {
      override preStart(): void {
        this.context.spawn(Child, 'fixed-name');
      }
      override onReceive(m: string): void { if (m === 'boom') throw new FooError(); }
    }
    class Guardian extends Actor<string> {
      override supervisorStrategy(): SupervisorStrategy {
        // Restart on the original failure — that is what re-runs preStart and
        // triggers the collision.  The collision then arrives as a *second*
        // failure, wrapped in ActorInitializationError, which we stop on so the
        // test does not loop.
        return new OneForOneStrategy((error) => {
          if (!(error instanceof ActorInitializationError)) return Directive.Restart;
          const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
          failures.push(cause);
          return Directive.Stop;
        });
      }
      override preStart(): void {
        this.context.spawn(Parent, 'collides').tell('boom');
      }
      override onReceive(_: string): void {}
    }

    sys().spawn(Guardian, 'collision-guardian');
    await awaitCondition(
      () => failures.length > 0,
      { label: 'the restart failed on the duplicate child name' },
    );
    expect(failures[0]).toContain('is not unique');
  });
});
