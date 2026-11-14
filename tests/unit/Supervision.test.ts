import type { Clock } from '../../src/Clock.js';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorRestarted, ActorStopped, Terminated } from '../../src/SystemMessages.js';
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
  type StrategyOptions,
  type SupervisorStrategy,
} from '../../src/Supervision.js';
import { TestKit } from '../../src/testkit/TestKit.js';
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
  // Structurally a `Clock`, so it goes straight into `RestartBudget` with no
  // adapter — the shape the contract exists to make ordinary (#1424).
  const manualClock = (): Clock & { advance: (ms: number) => void } => {
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
    const budget = new RestartBudget(strategy, clock);

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
    const budget = new RestartBudget(strategy, clock);

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
    const budget = new RestartBudget(strategy, clock);

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

/**
 * The cell and the budget agree on what `maxRetries` means.
 *
 * They did not.  `ActorCell` kept its own timestamp array and its own
 * arithmetic over it — `length <= maxRetries + 1` — while `RestartBudget`
 * refuses at `length >= maxRetries`.  `maxRetries: 5` therefore bought five
 * restarts in the worker mesh, which budgets slot respawns through the class
 * (#734), and six for an ordinary supervised child.  Two implementations of
 * one documented rule, and the sentence they both implement — "restart failing
 * child, up to 10 times per minute" — cannot be true of both.
 *
 * Nothing observed it: the whole unit suite stayed green through the change
 * that removed the duplicate, which is exactly why this is here.
 */
describe('the restart allowance means the same thing in both implementations', () => {
  const sys = systemFixture('supervision-allowance');

  class AlwaysFails extends Actor<string> {
    constructor(private readonly starts: { count: number }) { super(); }
    override preStart(): void { this.starts.count++; }
    override onReceive(): void { throw new FooError(); }
  }

  test('a child restarts exactly maxRetries times, then is stopped', async () => {
    const starts = { count: 0 };
    const seen: string[] = [];
    const probe = sys().spawn(() => new LifecycleCollector(seen), 'allowance-collector');
    sys().eventStream.subscribe(probe, ActorStopped);

    const maxRetries = 3;
    const ref = sys().spawn(() => new AlwaysFails(starts), 'allowance-child', {
      supervisorStrategy: new OneForOneStrategy(() => Directive.Restart, { maxRetries }),
    });

    // One more failure than the allowance, so the last one has to be refused.
    for (let i = 0; i < maxRetries + 1; i++) ref.tell('fail');

    await awaitCondition(() => seen.includes('ActorStopped:allowance-child'), {
      label: 'the restart allowance was spent and the child stopped',
    });

    // The initial construction plus one per granted restart.  Under the old
    // `maxRetries + 1` arithmetic this is 5, and the child would still have
    // been alive for one further failure.
    expect(starts.count).toBe(maxRetries + 1);
  });

  test('the budget grants the same number for the same strategy', () => {
    // The other half of the pair, stated as an equality rather than as two
    // numbers that happen to match: this is what would go red if either side
    // grew its own arithmetic again.
    const strategy = new OneForOneStrategy(() => Directive.Restart, { maxRetries: 3 });
    const budget = new RestartBudget(strategy);

    let granted = 0;
    while (budget.registerRestart()) granted++;

    expect(granted).toBe(strategy.maxRetries);
  });
});

/**
 * `all-for-one` widens a failure from the child that threw to every sibling
 * (#1019).  Until these cases existed the strategy was only ever constructed
 * and read back, so replacing the scope check in `ActorCell.onFailure` with
 * `false` — which silently turns `AllForOneStrategy` into `OneForOneStrategy`
 * — left every supervision test green.  An all-for-one group is chosen
 * because its siblings share state a partial restart would corrupt, so the
 * fan-out is the whole point of the strategy.
 */
describe('AllForOneStrategy fans a failure out to every sibling', () => {
  const sys = systemFixture('supervision-all-for-one');

  /** Counts constructions per child name; `fail` throws, anything else is ignored. */
  class Sibling extends Actor<string> {
    constructor(private readonly starts: Map<string, number>) { super(); }
    override preStart(): void {
      const name = this.context.self.path.name;
      this.starts.set(name, (this.starts.get(name) ?? 0) + 1);
    }
    override onReceive(message: string): void {
      if (message === 'fail') throw new FooError();
    }
  }

  const SIBLINGS = ['first', 'second', 'third'] as const;

  /** A parent over three siblings, failing only the one named in its message. */
  function parentClass(strategy: SupervisorStrategy, starts: Map<string, number>) {
    return class Parent extends Actor<string> {
      override supervisorStrategy(): SupervisorStrategy { return strategy; }
      override preStart(): void {
        for (const name of SIBLINGS) this.context.spawn(() => new Sibling(starts), name);
      }
      override onReceive(childName: string): void {
        this.context.child(childName).forEach((child) => child.tell('fail' as never));
      }
    };
  }

  test('Restart: one failing child restarts all three', async () => {
    const starts = new Map<string, number>();
    const strategy = new AllForOneStrategy(() => Directive.Restart);
    const parent = sys().spawn(parentClass(strategy, starts), 'all-for-one-restart');
    await awaitCondition(() => SIBLINGS.every((name) => starts.get(name) === 1), {
      label: 'all three siblings started',
    });

    parent.tell('second');

    await awaitCondition(() => SIBLINGS.every((name) => starts.get(name) === 2), {
      label: 'every sibling was rebuilt, not only the one that failed',
    });
  });

  test('Stop: one failing child stops all three', async () => {
    const starts = new Map<string, number>();
    const seen: string[] = [];
    const probe = sys().spawn(() => new LifecycleCollector(seen), 'all-for-one-stop-collector');
    sys().eventStream.subscribe(probe, ActorStopped);
    const strategy = new AllForOneStrategy(() => Directive.Stop);
    const parent = sys().spawn(parentClass(strategy, starts), 'all-for-one-stop');
    await awaitCondition(() => SIBLINGS.every((name) => starts.get(name) === 1), {
      label: 'all three siblings started',
    });

    parent.tell('first');

    await awaitCondition(
      () => SIBLINGS.every((name) => seen.includes(`ActorStopped:${name}`)),
      { label: 'every sibling was stopped, not only the one that failed' },
    );
  });

  test('the same group under OneForOneStrategy restarts only the failing child', async () => {
    // The control: without it, a cell that restarted every child on any
    // strategy would pass the Restart case above.
    const starts = new Map<string, number>();
    const strategy = new OneForOneStrategy(() => Directive.Restart);
    const parent = sys().spawn(parentClass(strategy, starts), 'one-for-one-control');
    await awaitCondition(() => SIBLINGS.every((name) => starts.get(name) === 1), {
      label: 'all three siblings started',
    });

    parent.tell('third');

    await awaitCondition(() => starts.get('third') === 2, { label: 'the failing child restarted' });
    expect(starts.get('first')).toBe(1);
    expect(starts.get('second')).toBe(1);
  });
});

/**
 * The parent's restart budget is a *rate*, not a lifetime quota (#1019): the
 * budget prunes failures older than `withinTimeRangeMs` before counting.  The
 * prune is tested on `RestartBudget` directly above; these cases cross the
 * window through a real parent, on the system's virtual clock, which is what
 * proves the cell hands its budget `system.clock` rather than leaving it on
 * the wall clock (#1424).
 *
 * The allowance is `maxRetries` restarts — `RestartBudget`'s reading, which
 * the cell has delegated to since the two implementations were unified; see
 * "the restart allowance means the same thing in both implementations".
 */
describe('the parent restart budget slides over withinTimeRangeMs', () => {
  class AlwaysFails extends Actor<string> {
    constructor(private readonly starts: { count: number }) { super(); }
    override preStart(): void { this.starts.count++; }
    override onReceive(): void { throw new FooError(); }
  }

  const strategy = new OneForOneStrategy(
    () => Directive.Restart,
    { maxRetries: 2, withinTimeRangeMs: 1_000 },
  );

  test('failures spaced beyond the window never exhaust the allowance', async () => {
    const { kit } = TestKit.withManualScheduler('supervision-window-spaced');
    try {
      const starts = { count: 0 };
      const ref = kit.system.spawn(() => new AlwaysFails(starts), 'spaced', { supervisorStrategy: strategy });

      ref.tell('fail');
      ref.tell('fail');
      await awaitCondition(() => starts.count === 3, { label: 'both restarts in the first window were granted' });

      // Both recorded restarts age out of the window, so the allowance is
      // whole again — a crash every ten minutes must not exhaust a per-second
      // budget.  On the wall clock this second would never pass.
      await kit.advance(1_001);
      ref.tell('fail');
      ref.tell('fail');
      await awaitCondition(() => starts.count === 5, {
        label: 'the two restarts after the window were granted as well',
      });
    } finally {
      await kit.shutdown();
    }
  });

  test('the same number of failures inside the window stops the child', async () => {
    const { kit } = TestKit.withManualScheduler('supervision-window-inside');
    try {
      const starts = { count: 0 };
      const seen: string[] = [];
      const probe = kit.system.spawn(() => new LifecycleCollector(seen), 'collector');
      kit.system.eventStream.subscribe(probe, ActorStopped);
      const ref = kit.system.spawn(() => new AlwaysFails(starts), 'inside', { supervisorStrategy: strategy });

      ref.tell('fail');
      await awaitCondition(() => starts.count === 2, { label: 'the first restart was granted' });
      await kit.advance(500);
      ref.tell('fail');
      await awaitCondition(() => starts.count === 3, { label: 'the second restart was granted' });
      // 999 ms after the first failure: still inside the window, so this is
      // the third failure counted against `maxRetries: 2`.
      await kit.advance(499);
      ref.tell('fail');

      await awaitCondition(() => seen.includes('ActorStopped:inside'), {
        label: 'the third failure inside the window spent the allowance and stopped the child',
      });
      expect(starts.count).toBe(3);
    } finally {
      await kit.shutdown();
    }
  });
});

/**
 * The restart budget belongs to the child that fails, not to the parent that
 * decides (#917).  It used to be one tally on the parent cell, so five
 * siblings that each crashed once spent one `maxRetries: 2` allowance between
 * them and two were stopped having failed once each — and every top-level
 * actor shared the user guardian's.  `AllForOneStrategy` keeps the shared
 * tally on purpose: its directive already treats the children as one unit.
 */
describe('the restart budget is kept per child', () => {
  const sys = systemFixture('supervision-per-child-budget');

  /** Counts constructions per child name; `fail` throws, anything else is ignored. */
  class Sibling extends Actor<string> {
    constructor(private readonly starts: Map<string, number>) { super(); }
    override preStart(): void {
      const name = this.context.self.path.name;
      this.starts.set(name, (this.starts.get(name) ?? 0) + 1);
    }
    override onReceive(message: string): void {
      if (message === 'fail') throw new FooError();
    }
  }

  const KIDS = ['k0', 'k1', 'k2', 'k3', 'k4'] as const;

  /**
   * A parent over a group of siblings that fails the child named in its
   * message.  `supervisorStrategy()` builds a fresh strategy on every call —
   * the shape the supervision guide shows — so the tally must not be keyed on
   * the strategy object's identity.
   */
  function parentClass(build: () => SupervisorStrategy, starts: Map<string, number>, kids: readonly string[]) {
    return class Parent extends Actor<string> {
      override supervisorStrategy(): SupervisorStrategy { return build(); }
      override preStart(): void {
        for (const name of kids) this.context.spawn(() => new Sibling(starts), name);
      }
      override onReceive(childName: string): void {
        this.context.child(childName).forEach((child) => child.tell('fail' as never));
      }
    };
  }

  const restartTwice = () => new OneForOneStrategy(
    () => Directive.Restart,
    { maxRetries: 2, withinTimeRangeMs: 60_000 },
  );

  test('five siblings that each fail once under maxRetries: 2 all restart', async () => {
    // One strategy instance for every decision: a tally keyed on identity
    // would let the fresh-per-call shape pass this case for the wrong reason.
    const stable = restartTwice();
    const starts = new Map<string, number>();
    const parent = sys().spawn(parentClass(() => stable, starts, KIDS), 'five-siblings');
    await awaitCondition(() => KIDS.every((name) => starts.get(name) === 1), { label: 'all five started' });

    for (const name of KIDS) parent.tell(name);

    await awaitCondition(() => KIDS.every((name) => starts.get(name) === 2), {
      label: 'every sibling was restarted after its single failure',
    });
  });

  test('one child failing maxRetries + 1 times is stopped, and its sibling keeps its allowance', async () => {
    const starts = new Map<string, number>();
    const seen: string[] = [];
    const probe = sys().spawn(() => new LifecycleCollector(seen), 'per-child-collector');
    sys().eventStream.subscribe(probe, ActorStopped);
    const parent = sys().spawn(parentClass(restartTwice, starts, ['flaky', 'steady']), 'one-flaky-child');
    await awaitCondition(() => starts.get('flaky') === 1 && starts.get('steady') === 1, { label: 'both started' });

    parent.tell('flaky');
    await awaitCondition(() => starts.get('flaky') === 2, { label: 'first restart granted' });
    parent.tell('flaky');
    await awaitCondition(() => starts.get('flaky') === 3, { label: 'second restart granted' });
    parent.tell('flaky');
    await awaitCondition(() => seen.includes('ActorStopped:flaky'), {
      label: 'the third failure inside the window spent the allowance and stopped the child',
    });

    // The sibling's allowance is its own and untouched.
    parent.tell('steady');
    await awaitCondition(() => starts.get('steady') === 2, { label: 'the sibling still restarts' });
    expect(starts.get('flaky')).toBe(3);
  });

  /**
   * The other direction of keying the tally by allowance: a strategy whose
   * allowance really changes gets a fresh tally under the new allowance.
   * Each case spends a `maxRetries: 2` budget, then changes one of the two
   * fields and fails again — a kept budget would be full and stop the child.
   */
  const ALLOWANCE_CHANGES: ReadonlyArray<readonly [string, StrategyOptions]> = [
    ['maxRetries 2 → 5, same window', { maxRetries: 5, withinTimeRangeMs: 60_000 }],
    ['same maxRetries, window 60 s → 30 s', { maxRetries: 2, withinTimeRangeMs: 30_000 }],
  ];
  for (const [label, changed] of ALLOWANCE_CHANGES) {
    test(`a changed allowance starts a fresh tally: ${label}`, async () => {
      let options: StrategyOptions = { maxRetries: 2, withinTimeRangeMs: 60_000 };
      const build = () => new OneForOneStrategy(() => Directive.Restart, options);
      const starts = new Map<string, number>();
      const seen: string[] = [];
      const probe = sys().spawn(() => new LifecycleCollector(seen), `allowance-change-collector-${changed.maxRetries}-${changed.withinTimeRangeMs}`);
      sys().eventStream.subscribe(probe, ActorStopped);
      const childName = `changing-${changed.maxRetries}-${changed.withinTimeRangeMs}`;
      const parent = sys().spawn(parentClass(build, starts, [childName]), `${childName}-parent`);
      await awaitCondition(() => starts.get(childName) === 1, { label: 'the child started' });

      parent.tell(childName);
      await awaitCondition(() => starts.get(childName) === 2, { label: 'first restart granted' });
      parent.tell(childName);
      await awaitCondition(() => starts.get(childName) === 3, { label: 'second restart granted — the old budget is full' });

      options = changed;
      parent.tell(childName);
      await awaitCondition(() => starts.get(childName) === 4, {
        label: 'the restart after the allowance changed was granted from a fresh tally',
      });
      expect(seen).not.toContain(`ActorStopped:${childName}`);
    });
  }

  test('AllForOneStrategy keeps one budget for the whole group', async () => {
    const starts = new Map<string, number>();
    const seen: string[] = [];
    const probe = sys().spawn(() => new LifecycleCollector(seen), 'all-for-one-budget-collector');
    sys().eventStream.subscribe(probe, ActorStopped);
    const group = ['a', 'b', 'c'] as const;
    const shared = () => new AllForOneStrategy(() => Directive.Restart, { maxRetries: 2, withinTimeRangeMs: 60_000 });
    const parent = sys().spawn(parentClass(shared, starts, group), 'all-for-one-budget');
    await awaitCondition(() => group.every((name) => starts.get(name) === 1), { label: 'the group started' });

    parent.tell('a');
    await awaitCondition(() => group.every((name) => starts.get(name) === 2), { label: 'first group restart' });
    parent.tell('b');
    await awaitCondition(() => group.every((name) => starts.get(name) === 3), { label: 'second group restart' });
    // A third *different* child: under a per-child tally it would restart,
    // but the group spends its allowance together.
    parent.tell('c');
    await awaitCondition(() => group.every((name) => seen.includes(`ActorStopped:${name}`)), {
      label: 'the shared allowance was spent and the whole group stopped',
    });
  });
});

/**
 * The per-child tally belongs to the child's *name* and outlives its cell
 * (#917, #1437): a child stopped for spending its allowance and spawned again
 * under the same name inside the window inherits the spent tally, so
 * re-creation is not a way to buy a fresh allowance.  Once the window has
 * passed, the name starts from a whole one.  Kept on a virtual clock, so
 * "inside" and "outside" the window are facts of the test.
 */
describe('the per-child restart budget survives re-creation under the same name', () => {
  type ParentCommand = { kind: 'spawn' } | { kind: 'fail' };

  test('inside the window a re-spawned child gets no fresh tally; outside it does', async () => {
    const { kit } = TestKit.withManualScheduler('supervision-respawn-budget');
    try {
      let starts = 0;
      const stopped: number[] = [];
      class Kid extends Actor<string> {
        override preStart(): void { starts++; }
        override onReceive(): void { throw new FooError(); }
      }
      const strategy = new OneForOneStrategy(() => Directive.Restart, { maxRetries: 2, withinTimeRangeMs: 1_000 });
      class Parent extends Actor<ParentCommand | Terminated> {
        override supervisorStrategy(): SupervisorStrategy { return strategy; }
        override onReceive(message: ParentCommand | Terminated): void {
          if (message instanceof Terminated) { stopped.push(starts); return; }
          if (message.kind === 'spawn') this.context.watch(this.context.spawn(Kid, 'kid'));
          else this.context.child('kid').forEach((kid) => kid.tell('fail' as never));
        }
      }
      const parent = kit.system.spawn(Parent, 'respawning-parent');

      parent.tell({ kind: 'spawn' });
      await awaitCondition(() => starts === 1, { label: 'the first kid started' });
      parent.tell({ kind: 'fail' });
      await awaitCondition(() => starts === 2, { label: 'first restart granted' });
      parent.tell({ kind: 'fail' });
      await awaitCondition(() => starts === 3, { label: 'second restart granted' });
      parent.tell({ kind: 'fail' });
      await awaitCondition(() => stopped.length === 1, { label: 'the third failure spent the allowance and stopped the kid' });

      // Inside the window: the new kid inherits the spent tally, so its very
      // first failure is refused and stops it — no restart in between.
      parent.tell({ kind: 'spawn' });
      await awaitCondition(() => starts === 4, { label: 'the kid was spawned again under its name' });
      parent.tell({ kind: 'fail' });
      await awaitCondition(() => stopped.length === 2, {
        label: 'the re-spawned kid was stopped on its first failure, from the inherited tally',
      });
      expect(starts).toBe(4);

      // Outside the window: every recorded restart has aged out, and the name
      // starts from a whole allowance again.
      await kit.advance(1_001);
      parent.tell({ kind: 'spawn' });
      await awaitCondition(() => starts === 5, { label: 'the kid was spawned a third time' });
      parent.tell({ kind: 'fail' });
      await awaitCondition(() => starts === 6, { label: 'outside the window the failure was restarted' });
      expect(stopped).toHaveLength(2);
    } finally {
      await kit.shutdown();
    }
  });
});
