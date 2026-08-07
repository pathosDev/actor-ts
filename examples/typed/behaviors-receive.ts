/**
 * Hello for the Typed Behaviors DSL.  A counter actor built as pure data:
 * each handler returns the next Behavior instead of mutating state.
 *
 *   bun run examples/typed/behaviors-receive.ts
 *
 * Expected output: the counter logs after each increment and stops itself
 * when it reaches the limit.
 */
import { match } from 'ts-pattern';
import { ActorSystem, Behaviors, type Behavior, type TypedActorContext } from '../../src/index.js';
import { attachDevTools } from '../devtools.js';

type IncrementCommand = { kind: 'increment' };
type GetCommand = { kind: 'get' };

type CounterCommand = IncrementCommand | GetCommand;

/**
 * Behavior holds its state by currying — `n` is captured in the closure.
 *
 * Arms may mix a real transition with a sentinel freely: `Behaviors.same` and
 * `Behaviors.stopped` are payload-free types that belong to `Behavior<T>` for
 * every `T`, so the union of the arms reduces to `Behavior<CounterCommand>`
 * without a cast.
 */
const counter = (n: number, limit: number): Behavior<CounterCommand> =>
  Behaviors.receive((context, command) =>
    match(command)
      .with({ kind: 'increment' }, () => onIncrement(context, n, limit))
      .with({ kind: 'get' }, () => onGet(context, n))
      .exhaustive());

function onIncrement(context: TypedActorContext<CounterCommand>, n: number, limit: number) {
  const next = n + 1;
  context.log.info(`counter @ ${next}`);
  if (next >= limit) {
    context.log.info(`counter reached limit ${limit}, stopping`);
    return Behaviors.stopped;
  }
  return counter(next, limit);
}

function onGet(context: TypedActorContext<CounterCommand>, n: number) {
  context.log.info(`counter value = ${n}`);
  return Behaviors.same;
}

async function main(): Promise<void> {
  const system = ActorSystem.create('typed-counter');
  const devtools = await attachDevTools(system);
  const ref = system.spawnTyped(counter(0, 3), 'counter');

  ref.tell({ kind: 'increment' });
  ref.tell({ kind: 'get' });
  ref.tell({ kind: 'increment' });
  ref.tell({ kind: 'increment' }); // reaches limit, actor stops

  await Bun.sleep(60);
  await devtools.holdOpen();
  await system.terminate();
}

void main();
