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

type CounterCommand = { kind: 'increment' } | { kind: 'get' };

/** Behavior holds its state by currying — `n` is captured in the closure. */
const counter = (n: number, limit: number): Behavior<CounterCommand> =>
  Behaviors.receive((context, command) => {
    if (command.kind === 'increment') {
      const next = n + 1;
      context.log.info(`counter @ ${next}`);
      if (next >= limit) {
        context.log.info(`counter reached limit ${limit}, stopping`);
        return Behaviors.stopped;
      }
      return counter(next, limit);
    }
    if (command.kind === 'get') {
      context.log.info(`counter value = ${n}`);
      return Behaviors.same;
    }
    return Behaviors.unhandled;
  });

async function main(): Promise<void> {
  const system = ActorSystem.create('typed-counter');
  const ref = system.spawnTyped(counter(0, 3), 'counter');

  ref.tell({ kind: 'increment' });
  ref.tell({ kind: 'get' });
  ref.tell({ kind: 'increment' });
  ref.tell({ kind: 'increment' }); // reaches limit, actor stops

  await Bun.sleep(60);
  await system.terminate();
}

void main();
