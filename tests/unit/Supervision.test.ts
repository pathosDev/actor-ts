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
  RestartBudget,
  stoppingStrategy,
  type SupervisorStrategy,
} from '../../src/Supervision.js';
import { awaitCondition } from '../util/AwaitCondition.js';
import { systemFixture } from './__shared__/SystemFixture.js';

class FooError extends Error { constructor() { super('foo'); this.name = 'FooError'; } }
class BarError extends Error { constructor() { super('bar'); this.name = 'BarError'; } }

describe('Directive enum', () => {
  test('has the four standard directives', () => {
    // `expect<string>`: this is the one place that pins the *wire* values of
    // the enum, so the literals stay on the right-hand side.
    expect<string>(Directive.Resume).toBe('resume');
    expect<string>(Directive.Restart).toBe('restart');
    expect<string>(Directive.Stop).toBe('stop');
    expect<string>(Directive.Escalate).toBe('escalate');
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
 * `Actor.preRestart`'s default stops this actor's children and then calls
 * `postStop()` (#634).  It used to call `postStop()` alone, which meant a
 * restarted instance inherited the previous incarnation's children — and an
 * actor that spawned a *named* child in `preStart` could not survive a restart
 * at all, because the second `preStart` hit the uniqueness check.
 *
 * An override that does not call `super.preRestart(...)` keeps the children,
 * which is the escape hatch for a parent whose children are expensive to
 * rebuild.  Both directions are pinned below.
 */
describe('restart and children', () => {
  const sys = systemFixture('restart-children-tests');

  test('children are stopped when their parent restarts', async () => {
    const events: string[] = [];
    class Child extends Actor<string> {
      override postStop(): void { events.push('child:postStop'); }
      override onReceive(m: string): void { events.push(`child:${m}`); }
    }
    class Parent extends Actor<string> {
      private child: import('../../src/ActorRef.js').ActorRef<string> | null = null;
      override preStart(): void {
        events.push('parent:preStart');
        this.child = this.context.spawnAnonymous(Child);
      }
      override onReceive(m: string): void {
        if (m === 'boom') throw new FooError();
        this.child?.tell(m);
      }
    }

    const parent = sys().spawn(Parent, 'stops-children');
    parent.tell('boom');
    await awaitCondition(
      () => events.filter((e) => e === 'parent:preStart').length >= 2,
      { label: 'the parent restarted' },
    );

    // The outgoing instance's child was stopped, and the restart waited for
    // it before running preStart again — otherwise a named child could not
    // reclaim its name.
    expect(events).toContain('child:postStop');
    expect(events.indexOf('child:postStop'))
      .toBeLessThan(events.lastIndexOf('parent:preStart'));

    // The fresh instance's own child answers.
    parent.tell('still-here');
    await awaitCondition(
      () => events.includes('child:still-here'),
      { label: "the new incarnation's child received a message" },
    );
  });

  test('stopChildrenOnRestart() === false keeps the children', async () => {
    // The escape hatch: a parent whose children are expensive to rebuild, or
    // which are supervised independently, opts out.
    const events: string[] = [];
    class Child extends Actor<string> {
      override postStop(): void { events.push('child:postStop'); }
      override onReceive(m: string): void { events.push(`child:${m}`); }
    }
    class Parent extends Actor<string> {
      private child: import('../../src/ActorRef.js').ActorRef<string> | null = null;
      override preStart(): void {
        events.push('parent:preStart');
        this.child ??= this.context.spawnAnonymous(Child);
      }
      override stopChildrenOnRestart(): boolean { return false; }
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

    expect(events).not.toContain('child:postStop');
    parent.tell('still-here');
    await awaitCondition(
      () => events.includes('child:still-here'),
      { label: 'the surviving child received a message after the restart' },
    );
  });

  test('a named child spawned in preStart survives a restart', async () => {
    // The defect this replaces: preStart ran again while the previous
    // incarnation's children were still in the child map, so the second spawn
    // hit the uniqueness check and the restart failed with
    // ActorInitializationError.  Now the restart waits for the old children
    // to go before rebuilding, so the name is free (#634).
    const events: string[] = [];
    class Child extends Actor<string> {
      override onReceive(m: string): void { events.push(`child:${m}`); }
    }
    class Parent extends Actor<string> {
      private child: import('../../src/ActorRef.js').ActorRef<string> | null = null;
      override preStart(): void {
        events.push('parent:preStart');
        this.child = this.context.spawn(Child, 'fixed-name');
      }
      override onReceive(m: string): void {
        if (m === 'boom') throw new FooError();
        this.child?.tell(m);
      }
    }

    const parent = sys().spawn(Parent, 'named-child-restart');
    parent.tell('boom');
    await awaitCondition(
      () => events.filter((e) => e === 'parent:preStart').length >= 2,
      { label: 'the parent restarted without a name collision' },
    );

    parent.tell('ping');
    await awaitCondition(
      () => events.includes('child:ping'),
      { label: 'the re-spawned named child is reachable' },
    );
  });
});

// #635 — a failure suspends the failing actor's subtree so nothing in it runs
// while the supervisor decides.  `Directive.Resume` then only ever reached the
// actor that failed, so its children stayed suspended for good: mailboxes
// filled, nothing was processed, and there was no error and no dead letter to
// notice it by.
describe('resume after a failure', () => {
  const sys = systemFixture('resume-subtree-tests');

  test("a resumed actor's children are resumed with it", async () => {
    const events: string[] = [];
    class Grandchild extends Actor<string> {
      override onReceive(m: string): void { events.push(`grandchild:${m}`); }
    }
    class Child extends Actor<string> {
      private grandchild: import('../../src/ActorRef.js').ActorRef<string> | null = null;
      override preStart(): void { this.grandchild = this.context.spawnAnonymous(Grandchild); }
      override onReceive(m: string): void {
        if (m === 'boom') throw new FooError();
        events.push(`child:${m}`);
        this.grandchild?.tell(m);
      }
    }
    class Parent extends Actor<string> {
      private child: import('../../src/ActorRef.js').ActorRef<string> | null = null;
      override supervisorStrategy(): SupervisorStrategy {
        return new OneForOneStrategy(() => Directive.Resume);
      }
      override preStart(): void { this.child = this.context.spawnAnonymous(Child); }
      override onReceive(m: string): void { this.child?.tell(m); }
    }

    const parent = sys().spawn(Parent, 'resume-subtree');
    parent.tell('boom');
    // `Resume` leaves nothing behind to poll on — no restart, no stop, no event.
    // The window is simply "long enough for the failure to have been supervised"
    // before the next message probes whether the subtree survived it.
    await Bun.sleep(60);

    // The whole branch must still be live — child *and* grandchild.
    parent.tell('after');
    await awaitCondition(
      () => events.includes('grandchild:after'),
      { label: 'the grandchild processed a message after the resume' },
    );
    expect(events).toContain('child:after');
  });
});

/**
 * The budget is the half of a strategy nothing used to enforce outside
 * `ActorCell` (#638).  Testing it here rather than only through an actor is
 * what the injectable clock is for: the sliding window is otherwise only
 * observable by sleeping `withinTimeRangeMs`, which is slow and is exactly how
 * a suite acquires timing flakes.
 */
describe('RestartBudget', () => {
  /** A clock the test moves by hand, so no assertion ever waits on real time. */
  const manualClock = (): { now: () => number; advance: (ms: number) => void } => {
    let current = 1_000_000;
    return { now: () => current, advance: (ms: number) => { current += ms; } };
  };

  test('grants exactly maxRetries restarts and refuses the next one', () => {
    const strategy = new OneForOneStrategy(() => Directive.Restart, { maxRetries: 3 });
    const budget = new RestartBudget(strategy);
    expect([budget.registerRestart(), budget.registerRestart(), budget.registerRestart()])
      .toEqual([true, true, true]);
    // The fourth attempt is the one `maxRetries: 3` does not cover — the OO
    // `registerRestart` would still grant it (`<= maxRetries + 1`).
    expect(budget.registerRestart()).toBe(false);
    expect(budget.registerRestart()).toBe(false);
  });

  test('maxRetries: 0 refuses the very first restart', () => {
    const strategy = new OneForOneStrategy(() => Directive.Restart, { maxRetries: 0 });
    const budget = new RestartBudget(strategy);
    expect(budget.registerRestart()).toBe(false);
    // A refusal is not recorded, so "zero restarts granted" cannot drift into
    // "one restart granted" via a spent slot.
    expect(budget.recordedRestarts).toBe(0);
  });

  test('maxRetries: -1 is unlimited and records nothing', () => {
    // The default for a hand-built strategy, and the one every pre-existing
    // typed supervise test relies on — so it has to stay free of both a bound
    // and the array that would otherwise grow for the process lifetime.
    const strategy = new OneForOneStrategy(() => Directive.Restart);
    const budget = new RestartBudget(strategy);
    for (let i = 0; i < 1_000; i++) expect(budget.registerRestart()).toBe(true);
    expect(budget.recordedRestarts).toBe(0);
  });

  test('the window slides — restarts older than withinTimeRangeMs stop counting', () => {
    const clock = manualClock();
    const strategy = new OneForOneStrategy(
      () => Directive.Restart,
      { maxRetries: 2, withinTimeRangeMs: 1_000 },
    );
    const budget = new RestartBudget(strategy, clock.now);

    expect(budget.registerRestart()).toBe(true);
    expect(budget.registerRestart()).toBe(true);
    expect(budget.registerRestart()).toBe(false);

    // Both recorded failures fall out of the window, so the allowance is whole
    // again — a crash every ten minutes must never exhaust a per-minute budget.
    clock.advance(1_001);
    expect(budget.registerRestart()).toBe(true);
    expect(budget.registerRestart()).toBe(true);
    expect(budget.registerRestart()).toBe(false);
  });

  test('a partially-aged window frees exactly the entries that expired', () => {
    const clock = manualClock();
    const strategy = new OneForOneStrategy(
      () => Directive.Restart,
      { maxRetries: 2, withinTimeRangeMs: 1_000 },
    );
    const budget = new RestartBudget(strategy, clock.now);

    expect(budget.registerRestart()).toBe(true);   // at t
    clock.advance(600);
    expect(budget.registerRestart()).toBe(true);   // at t+600
    expect(budget.registerRestart()).toBe(false);

    // t+1001 drops only the first entry; the second is still 401ms old.
    clock.advance(401);
    expect(budget.registerRestart()).toBe(true);
    expect(budget.registerRestart()).toBe(false);
  });

  test('withinTimeRangeMs: 0 is a process-lifetime cap that never resets', () => {
    const clock = manualClock();
    const strategy = new OneForOneStrategy(() => Directive.Restart, { maxRetries: 2 });
    const budget = new RestartBudget(strategy, clock.now);

    expect(budget.registerRestart()).toBe(true);
    expect(budget.registerRestart()).toBe(true);
    clock.advance(365 * 24 * 60 * 60 * 1_000);
    expect(budget.registerRestart()).toBe(false);
    // Capped rather than unbounded: the refused attempts add nothing, so the
    // array cannot grow past `maxRetries` even with no window to prune it.
    expect(budget.recordedRestarts).toBe(2);
  });

  test('two supervisors reading one shared strategy keep separate allowances', () => {
    // `defaultStrategy` is a module-level singleton, so a tally living on the
    // strategy would be shared by every actor in the process.
    const first = new RestartBudget(defaultStrategy);
    const second = new RestartBudget(defaultStrategy);
    for (let i = 0; i < 10; i++) expect(first.registerRestart()).toBe(true);
    expect(first.registerRestart()).toBe(false);
    expect(second.registerRestart()).toBe(true);
  });
});
