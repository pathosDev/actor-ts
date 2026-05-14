/**
 * Realistic Typed Behaviors: a "work poller" that ticks on a timer and
 * occasionally fails.  Shows how setup/withTimers/supervise compose:
 *   - setup captures self and creates initial state
 *   - withTimers starts a recurring self-tick
 *   - supervise().onFailure(Restart) re-runs setup on crash, so the timer
 *     and state are rebuilt automatically
 *
 *   bun run examples/typed/behaviors-supervise.ts
 *
 * Expected output: a few ticks, then a simulated failure, then the actor
 * restarts (you'll see "setup#2" in the log) and keeps ticking.
 */
import {
  ActorSystem,
  Behaviors,
  Directive,
  OneForOneStrategy,
  type Behavior,
} from '../../src/index.js';

type PollerCmd = { kind: 'tick' } | { kind: 'fail-next' };

// Number of times setup has run — survives across restarts because the
// lexical binding is outside the behavior.  Useful for observability.
let setupCalls = 0;

const poller = (maxTicks: number): Behavior<PollerCmd> =>
  Behaviors.setup<PollerCmd>((ctx) => {
    setupCalls++;
    ctx.log.info(`poller setup#${setupCalls}`);

    return Behaviors.withTimers<PollerCmd>((timers) => {
      timers.startTimerWithFixedDelay('tick', { kind: 'tick' }, 80, 40);

      let ticks = 0;
      let pendingFail = false;

      return Behaviors.receive((_c, cmd) => {
        if (cmd.kind === 'fail-next') {
          pendingFail = true;
          return Behaviors.same;
        }
        if (pendingFail) {
          pendingFail = false;
          throw new Error('simulated poll failure');
        }
        ticks++;
        ctx.log.info(`poller tick#${ticks} (setup run ${setupCalls})`);
        if (ticks >= maxTicks) {
          ctx.log.info('poller finished, stopping');
          return Behaviors.stopped;
        }
        return Behaviors.same;
      });
    });
  });

async function main(): Promise<void> {
  const system = ActorSystem.create('typed-supervise');

  const supervised = Behaviors.supervise(poller(6)).onFailure(
    new OneForOneStrategy(() => Directive.Restart, { maxRetries: 3, withinTimeRangeMs: 5_000 }),
  );
  const ref = system.spawnTyped(supervised, 'poller');

  // Let a few ticks go by, then cause a crash.
  await Bun.sleep(200);
  ref.tell({ kind: 'fail-next' });

  // Watch the restart + continued ticks, then let the actor reach its own limit.
  await Bun.sleep(700);
  await system.terminate();
}

void main();
