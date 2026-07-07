/**
 * Actor creation/destruction rate — how fast can we spawn and stop an
 * actor?  Measures spawn + stop as one op.
 *
 *   bun run benchmarks/single-node/actor-creation.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, Props } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

class Noop extends Actor<unknown> { override onReceive(): void {} }

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-create', systemOptions);
  const props = Props.create(() => new Noop());

  await runGroup('single-node · actor-creation', [
    {
      name: 'spawn + stop (flat)',
      unit: 'actor',
      iterations: 5_000,
      run: () => {
        const ref = system.spawnAnonymous(props);
        ref.stop();
      },
    },
    {
      name: 'spawn 100-deep sibling burst',
      unit: 'actor',
      iterations: 100,
      opsPerIteration: 100,
      run: () => {
        const refs = [];
        for (let i = 0; i < 100; i++) refs.push(system.spawnAnonymous(props));
        for (const r of refs) r.stop();
      },
    },
  ]);

  await system.terminate();
}

void main();
