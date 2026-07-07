/**
 * Memory footprint of idle actors — spawn N actors that never process a
 * message, measure the resulting ΔRSS and Δheap-used.
 *
 *   bun --smol run benchmarks/memory/idle-actors.ts   (for a more compact RSS)
 *   bun run benchmarks/memory/idle-actors.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, Props } from '../../src/index.js';
import { memoryGroup } from '../lib/harness.js';

class Noop extends Actor<unknown> { override onReceive(): void {} }

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-mem', systemOptions);
  const props = Props.create(() => new Noop());

  const group = memoryGroup('memory · idle actors');

  for (const n of [1_000, 10_000, 100_000] as const) {
    await group.measure(`spawn ${n.toLocaleString()} idle actors`, async () => {
      const refs = new Array(n);
      for (let i = 0; i < n; i++) refs[i] = system.spawnAnonymous(props);
      // Hold refs so GC keeps cells alive.
      void refs;
    });
  }

  group.end();
  await system.terminate();
}

void main();
