import { describe, expect, test } from 'bun:test';
import {
  Actor, ActorSystem, ActorSystemOptions, AllForOneStrategy, Directive, LogLevel,
  NoopLogger, Router,
  type ActorRef, type SupervisorStrategy,
} from '../../src/index.js';

/**
 * Regressions from the restart-stops-children change (#634).  Each of these
 * failed silently: nothing threw, nothing logged, and the actor tree looked
 * healthy under introspection — which is why the feature shipped with them.
 */

const quiet = (): ActorSystemOptions =>
  ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off) as ActorSystemOptions;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('restart regressions', () => {
  test('terminate() settles when it races a parked restart — #1029', async () => {
    class Kid extends Actor<string> {
      override onReceive(): void {}
      override async postStop(): Promise<void> { await sleep(60); }
    }
    class Parent extends Actor<string> {
      override preStart(): void { this.context.spawn(Kid, 'kid'); }
      override onReceive(): void { throw new Error('boom'); }
    }

    const system = ActorSystem.create('parked-restart-terminate', quiet());
    const parent = system.spawn(Parent, 'parent');
    await sleep(60);
    // Fail, then stop while the restart is parked waiting on the child.
    parent.tell('crash');

    const settled = await Promise.race([
      system.terminate().then(() => 'settled' as const),
      sleep(4_000).then(() => 'hung' as const),
    ]);
    expect(settled).toBe('settled');
  });

  test('a restarted router pool keeps routing to its routees — #1030', async () => {
    let delivered = 0;
    class Routee extends Actor<string> {
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
    await sleep(80);

    holder.tell('crash');
    await sleep(300);

    delivered = 0;
    for (let index = 0; index < 6; index++) holder.tell(`after-${index}`);
    await sleep(300);

    // Before the fix the stale Terminated for each old routee pruned the new
    // routee occupying the same path, leaving the pool empty and silent.
    expect(delivered).toBe(6);
    await system.terminate();
  });

  test('a retained child is resumed when its parent restarts — #1032', async () => {
    let delivered = 0;
    class Kid extends Actor<string> {
      override onReceive(): void { delivered++; }
    }
    class Parent extends Actor<string> {
      private kid!: ActorRef<string>;
      override stopChildrenOnRestart(): boolean { return false; }
      override preStart(): void {
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
    await sleep(80);

    parent.tell('crash');
    await sleep(300);

    delivered = 0;
    for (let index = 0; index < 3; index++) parent.tell('ping');
    await sleep(300);

    // The failure suspended the child along with its parent; only the parent
    // was ever resumed, so the opt-out kept the child alive but frozen.
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
    await sleep(80);

    holder.tell('crash');
    await sleep(400);

    // One start, one restart.  The field-based form looped until the restart
    // budget stopped it, because the duplicate name failed the spawn.
    expect(starts).toBe(2);
    await system.terminate();
  });
});
