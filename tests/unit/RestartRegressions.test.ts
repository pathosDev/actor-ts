import { describe, expect, test } from 'bun:test';
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  AllForOneStrategy,
  Directive,
  LogLevel,
  NoopLogger,
  Router,
  type ActorRef,
  type SupervisorStrategy,
} from '../../src/index.js';
import { awaitCondition, sleep } from '../util/AwaitCondition.js';

/**
 * Regressions from the restart-stops-children change (#634).  Each of these
 * failed silently: nothing threw, nothing logged, and the actor tree looked
 * healthy under introspection — which is why the feature shipped with them.
 */

const quiet = (): ActorSystemOptions =>
  ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off) as ActorSystemOptions;

describe('restart regressions', () => {
  test('terminate() settles when it races a parked restart — #1029', async () => {
    const kidStarted = { value: false };
    class Kid extends Actor<string> {
      override preStart(): void { kidStarted.value = true; }
      override onReceive(): void {}
      // The 60 ms is the fixture for the whole case: a child that stops slowly
      // is what makes the parent's restart park long enough to race `terminate`.
      override async postStop(): Promise<void> { await sleep(60); }
    }
    class Parent extends Actor<string> {
      override preStart(): void { this.context.spawn(Kid, 'kid'); }
      override onReceive(): void { throw new Error('boom'); }
    }

    const system = ActorSystem.create('parked-restart-terminate', quiet());
    const parent = system.spawn(Parent, 'parent');
    // The restart only parks if there is a *running* child to wait on.
    await awaitCondition(() => kidStarted.value, {
      timeoutMs: 4_000,
      label: 'the slow-stopping child started',
    });
    // Fail, then stop while the restart is parked waiting on the child.
    parent.tell('crash');

    const settled = await Promise.race([
      system.terminate().then(() => 'settled' as const),
      // Not a wait but the losing arm of a race: this is the failure budget for
      // "terminate never settled", and it resolves only when the test is broken.
      sleep(4_000).then(() => 'hung' as const),
    ]);
    expect(settled).toBe('settled');
  });

  test('a restarted router pool keeps routing to its routees — #1030', async () => {
    let delivered = 0;
    // The all-for-one strategy restarts the *children* — the pool, not the
    // holder — so the routees coming back up is the observable that says the
    // restart is complete.
    let routeeStarts = 0;
    class Routee extends Actor<string> {
      override preStart(): void { routeeStarts++; }
      override onReceive(): void { delivered++; }
    }
    class Failing extends Actor<string> {
      override onReceive(): void { throw new Error('boom'); }
    }
    class Holder extends Actor<string> {
      private pool!: ActorRef<string>;
      private failing!: ActorRef<string>;
      // all-for-one so the sibling's failure restarts the router itself
      override supervisorStrategy(): SupervisorStrategy {
        return new AllForOneStrategy(() => Directive.Restart, { maxRetries: 5, withinTimeRangeMs: 60_000 });
      }
      override preStart(): void {
        this.pool = this.context.spawn(Router.roundRobin(3, Routee), 'pool');
        this.failing = this.context.spawn(Failing, 'failing');
      }
      override onReceive(message: string): void {
        if (message === 'crash') { this.failing.tell('go'); return; }
        this.pool.tell(message);
      }
    }

    const system = ActorSystem.create('router-restart', quiet());
    const holder = system.spawn(Holder, 'holder');
    await awaitCondition(() => routeeStarts >= 3, {
      timeoutMs: 4_000,
      label: 'the pool started its three routees',
    });

    holder.tell('crash');
    // The restart is done when three fresh routees have started — the 300 ms
    // this used to wait was a guess at how long the all-for-one restart of a
    // three-routee pool takes on an idle machine.
    await awaitCondition(() => routeeStarts >= 6, {
      timeoutMs: 4_000,
      label: 'the pool rebuilt its three routees after the restart',
    });

    delivered = 0;
    for (let index = 0; index < 6; index++) holder.tell(`after-${index}`);
    // Before the fix the stale Terminated for each old routee pruned the new
    // routee occupying the same path, leaving the pool empty and silent.  The
    // settle afterwards keeps the upper half of the assertion honest — polling
    // alone would return on the sixth delivery and never see a seventh.
    await awaitCondition(() => delivered >= 6, {
      timeoutMs: 4_000,
      label: 'the restarted pool routed all six messages',
    });
    // The settle window itself: a seventh delivery is an absence and cannot be
    // polled for, so this is the span in which one would show up.
    await sleep(30);
    expect(delivered).toBe(6);
    await system.terminate();
  });

  test('a retained child is resumed when its parent restarts — #1032', async () => {
    let delivered = 0;
    class Kid extends Actor<string> {
      override onReceive(): void { delivered++; }
    }
    let parentStarts = 0;
    class Parent extends Actor<string> {
      private kid!: ActorRef<string>;
      override stopChildrenOnRestart(): boolean { return false; }
      override preStart(): void {
        parentStarts++;
        this.kid = (this.context.child('kid').toNullable() as ActorRef<string> | null)
          ?? this.context.spawn(Kid, 'kid');
      }
      override onReceive(message: string): void {
        if (message === 'crash') throw new Error('boom');
        this.kid.tell(message);
      }
    }

    const system = ActorSystem.create('retained-child-resume', quiet());
    const parent = system.spawn(Parent, 'parent');
    await awaitCondition(() => parentStarts >= 1, {
      timeoutMs: 4_000,
      label: 'the parent started and adopted its child',
    });

    parent.tell('crash');
    await awaitCondition(() => parentStarts >= 2, {
      timeoutMs: 4_000,
      label: 'the parent restarted',
    });

    delivered = 0;
    for (let index = 0; index < 3; index++) parent.tell('ping');
    // The failure suspended the child along with its parent; only the parent
    // was ever resumed, so the opt-out kept the child alive but frozen.
    await awaitCondition(() => delivered >= 3, {
      timeoutMs: 4_000,
      label: 'the retained child handled messages again after the restart',
    });
    // The settle window itself: a fourth delivery is an absence and cannot be
    // polled for, so this is the span in which one would show up.
    await sleep(30);
    expect(delivered).toBe(3);
    await system.terminate();
  });

  test('the documented opt-out recipe survives a restart — #1031', async () => {
    let starts = 0;
    class Worker extends Actor<string> {
      override onReceive(): void {}
    }
    class Holder extends Actor<string> {
      private worker!: ActorRef<string>;
      override stopChildrenOnRestart(): boolean { return false; }
      override preStart(): void {
        starts++;
        // The recipe as published: adopt the survivor from the cell, never
        // from an instance field — `preStart` runs on a fresh instance.
        this.worker = (this.context.child('worker').toNullable() as ActorRef<string> | null)
          ?? this.context.spawn(Worker, 'worker');
      }
      override onReceive(): void { throw new Error('boom'); }
    }

    const system = ActorSystem.create('optout-recipe', quiet());
    const holder = system.spawn(Holder, 'holder');
    await awaitCondition(() => starts >= 1, {
      timeoutMs: 4_000,
      label: 'the holder started',
    });

    holder.tell('crash');
    // One start, one restart.  The field-based form looped until the restart
    // budget stopped it, because the duplicate name failed the spawn — so the
    // wait stops at the second start and the settle is what would catch a
    // third.  Polling alone cannot: it returns on the very increment the
    // broken version overshoots from.
    await awaitCondition(() => starts >= 2, {
      timeoutMs: 4_000,
      label: 'the holder restarted once',
    });
    // The settle window itself: a third start is an absence and cannot be polled
    // for, so this is the span in which the broken version would overshoot.
    await sleep(50);
    expect(starts).toBe(2);
    await system.terminate();
  });
});
