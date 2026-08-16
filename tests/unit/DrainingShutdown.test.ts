/**
 * `terminate()` finishes the work the application already handed over (#663).
 *
 * The framework used to teach "sleep and hope": every example slept before it
 * shut down, because `ref.tell(x); await system.terminate()` dropped `x`.  The
 * cause is that `terminate` is a *system* command — `ActorCell.run()` re-checks
 * its system queue after every `await`, so a terminate landing in an open await
 * window preempts the user message queued behind it, and a cell that has flipped
 * to `terminating` stops dequeuing user messages at all.
 *
 * **Why these tests queue more than one message.**  The loss was
 * race-dependent, not deterministic: on the unfixed code a *started, idle*
 * actor still delivered exactly two messages — one per hop of the
 * root -> /user-guardian -> child terminate cascade — whatever the backlog
 * depth.  A test that tells once and terminates can therefore pass against
 * unfixed code.  Every case here either tells immediately after `spawn` or
 * queues at least three.
 *
 * Since #409 a hop delivers a whole *batch* rather than one message, so the
 * count that gets through without a drain is `2 x actor-ts.actor.throughput`.
 * The one case that asserts on that number pins its actor's budget to 1 rather
 * than tracking the default.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ActorOptions } from '../../src/ActorOptions.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { gracefulStop } from '../../src/pattern/GracefulStop.js';

function newSystem(name: string, drainTimeoutMs?: number): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (drainTimeoutMs === undefined) return ActorSystem.create(name, systemOptions);
  const configured = systemOptions
    .withConfig({ 'actor-ts': { system: { 'shutdown-drain-timeout': drainTimeoutMs } } });
  return ActorSystem.create(name, configured);
}

/** Records every message it handles into a caller-owned array. */
class Recorder extends Actor<string> {
  constructor(private readonly seen: string[]) { super(); }
  override onReceive(message: string): void { this.seen.push(message); }
}

describe('terminate drains the user tree', () => {
  test('a message told immediately after spawn is processed', async () => {
    const system = newSystem('drain-after-spawn');
    const seen: string[] = [];
    const ref = system.spawn(() => new Recorder(seen), 'recorder');

    // The strictest form of the defect: on unfixed code the terminate cascade
    // wins the create-turn's own await window and this delivered 0 of 1.
    ref.tell('x');
    await system.terminate();

    expect(seen).toEqual(['x']);
  });

  test('a backlog on a started actor is processed in full', async () => {
    const system = newSystem('drain-backlog');
    const seen: string[] = [];
    const ref = system.spawn(() => new Recorder(seen), 'recorder');
    // Let the create turn finish, so the backlog is queued on an idle actor —
    // the shape that used to deliver exactly two, however many were queued.
    await Bun.sleep(20);

    const sent = Array.from({ length: 25 }, (_, index) => `m${index}`);
    for (const message of sent) ref.tell(message);
    await system.terminate();

    expect(seen).toEqual(sent);
  });

  test('the drain follows messages the drain itself produces', async () => {
    const system = newSystem('drain-transitive');
    const hops: number[] = [];

    /** Bounces the message back to its sender until the counter runs out. */
    class Bouncer extends Actor<number> {
      override onReceive(remaining: number): void {
        hops.push(remaining);
        if (remaining > 0) {
          this.sender.forEach((peer) => peer.tell(remaining - 1, this.self));
        }
      }
    }

    const ping = system.spawn(Bouncer, 'ping');
    const pong = system.spawn(Bouncer, 'pong');
    // Neither mailbox is ever deep — the work only exists because draining it
    // creates more.  A single flush of each queue would stop after one hop.
    ping.tell(20, pong);
    await system.terminate();

    expect(hops).toHaveLength(21);
    expect(hops[hops.length - 1]).toBe(0);
  });

  test('a child spawned by a draining actor is drained too', async () => {
    const system = newSystem('drain-children');
    const seen: string[] = [];

    class Parent extends Actor<string> {
      private child: ActorRef<string> | null = null;
      override onReceive(message: string): void {
        this.child ??= this.context.spawn(() => new Recorder(seen), 'child');
        this.child.tell(`child:${message}`);
        seen.push(`parent:${message}`);
      }
    }

    const parent = system.spawn(Parent, 'parent');
    parent.tell('a');
    parent.tell('b');
    parent.tell('c');
    await system.terminate();

    expect(seen.filter((entry) => entry.startsWith('child:'))).toEqual([
      'child:a', 'child:b', 'child:c',
    ]);
  });

  test('the drain is bounded, and the remainder is still dead-lettered', async () => {
    // An actor that never goes quiet: each message it handles produces the
    // next one, so quiescence is unreachable and only the budget ends it.
    const system = newSystem('drain-bounded', 150);
    let handled = 0;

    class Perpetual extends Actor<string> {
      override onReceive(message: string): void {
        handled += 1;
        this.self.tell(message);
      }
    }

    const ref = system.spawn(Perpetual, 'perpetual');
    ref.tell('go');

    const startedAt = Date.now();
    await system.terminate();
    const elapsedMs = Date.now() - startedAt;

    expect(handled).toBeGreaterThan(1);
    expect(system.isTerminated).toBe(true);
    // The budget bounds it; the teardown that follows is what the rest of the
    // slack is for.
    expect(elapsedMs).toBeLessThan(2_000);
  }, 6_000);

  test('a drain budget of 0 restores the undrained teardown', async () => {
    const system = newSystem('drain-disabled', 0);
    const seen: string[] = [];
    // Batch budget pinned to 1 so the "one message per cascade hop" arithmetic
    // below stays literal (#409).  What this case is about is the drain budget,
    // and leaving the default in place would silently make it about
    // `actor-ts.actor.throughput` instead: two hops deliver two *batches*, so
    // at the default of 16 all 25 arrive and the case passes for a reason that
    // has nothing to do with #663.
    const recorderOptions = ActorOptions.create<string>().withThroughput(1);
    const ref = system.spawn(() => new Recorder(seen), 'recorder', recorderOptions);
    await Bun.sleep(20);

    for (let index = 0; index < 25; index++) ref.tell(`m${index}`);
    await system.terminate();

    // Exactly the pre-#663 behaviour: the terminate cascade takes two hops to
    // reach the actor, so two messages get through and the rest do not.
    expect(seen.length).toBeLessThan(25);
  });

  test('awaitQuiescence reports whether the tree went quiet', async () => {
    // Short configured budget so the teardown at the end does not sit out the
    // default two seconds behind the never-quiet actor spawned below; the
    // explicit arguments in the assertions override it either way.
    const system = newSystem('await-quiescence', 100);
    const seen: string[] = [];
    const ref = system.spawn(() => new Recorder(seen), 'recorder');
    for (let index = 0; index < 5; index++) ref.tell(`m${index}`);

    expect(await system.awaitQuiescence(2_000)).toBe(true);
    expect(seen).toHaveLength(5);

    class Perpetual extends Actor<string> {
      override onReceive(message: string): void { this.self.tell(message); }
    }
    system.spawn(Perpetual, 'perpetual').tell('go');

    expect(await system.awaitQuiescence(100)).toBe(false);

    await system.terminate();
  }, 6_000);
});

describe('gracefulStop', () => {
  test('resolves true once the actor has drained and terminated', async () => {
    const system = newSystem('graceful-stop');
    const seen: string[] = [];
    const ref = system.spawn(() => new Recorder(seen), 'recorder');

    for (let index = 0; index < 10; index++) ref.tell(`m${index}`);
    const stopped = await gracefulStop(ref, 2_000);

    // The PoisonPill is an ordinary user message, so it is ordered behind the
    // backlog — which is what makes "graceful" mean stop-after-drain.
    expect(stopped).toBe(true);
    expect(seen).toHaveLength(10);

    await system.terminate();
  }, 6_000);

  test('resolves false and hard-stops an actor that overruns the budget', async () => {
    const system = newSystem('graceful-stop-timeout');
    let released = (): void => {};
    const blocked = new Promise<void>((resolve) => { released = resolve; });

    class Blocked extends Actor<string> {
      override async onReceive(): Promise<void> { await blocked; }
    }

    const ref = system.spawn(Blocked, 'blocked');
    ref.tell('a');
    ref.tell('b');

    const startedAt = Date.now();
    const stopped = await gracefulStop(ref, 150);
    const elapsedMs = Date.now() - startedAt;

    expect(stopped).toBe(false);
    // Lower bound well under the 150 ms budget on purpose: Bun can fire a
    // timer up to a full 15.6 ms scheduling quantum early (#477), so pinning
    // this near the budget is a flake, not a stronger assertion.
    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    expect(elapsedMs).toBeLessThan(1_500);

    // Escalation is the point of the `false`: a caller who ran out of patience
    // must not also be left with a live actor.  Releasing the in-flight turn
    // lets the system command it is now queued behind run.
    released();
    await system.terminate();
  }, 6_000);

  test('an already-terminated actor settles immediately', async () => {
    const system = newSystem('graceful-stop-dead');
    const seen: string[] = [];
    const ref = system.spawn(() => new Recorder(seen), 'recorder');

    expect(await gracefulStop(ref, 2_000)).toBe(true);
    // `_addWatcher` answers a dead target on the spot rather than through a
    // mailbox, so a second call cannot hang waiting for a `Terminated` that
    // has already been delivered.
    expect(await gracefulStop(ref, 2_000)).toBe(true);

    await system.terminate();
  }, 6_000);
});
