/**
 * Hello for the Typed Behaviors DSL.  A counter actor built as pure data:
 * each handler returns the next Behavior instead of mutating state.
 *
 *   bun run examples/typed/behaviors-receive.ts
 *
 * Expected output: the counter logs after each increment and stops itself
 * when it reaches the limit.
 */
import { ActorSystem, Behaviors, type Behavior } from '../../src/index.js';

type CounterCommand = { kind: 'inc' } | { kind: 'get' };

/** Behavior holds its state by currying — `n` is captured in the closure. */
const counter = (n: number, limit: number): Behavior<CounterCommand> =>
  Behaviors.receive((ctx, cmd) => {
    if (cmd.kind === 'inc') {
      const next = n + 1;
      ctx.log.info(`counter @ ${next}`);
      if (next >= limit) {
        ctx.log.info(`counter reached limit ${limit}, stopping`);
        return Behaviors.stopped;
      }
      return counter(next, limit);
    }
    if (cmd.kind === 'get') {
      ctx.log.info(`counter value = ${n}`);
      return Behaviors.same;
    }
    return Behaviors.unhandled;
  });

async function main(): Promise<void> {
  const system = ActorSystem.create('typed-counter');
  const ref = system.spawnTyped(counter(0, 3), 'counter');

  ref.tell({ kind: 'inc' });
  ref.tell({ kind: 'get' });
  ref.tell({ kind: 'inc' });
  ref.tell({ kind: 'inc' }); // reaches limit, actor stops

  await Bun.sleep(60);
  await system.terminate();
}

void main();
