/**
 * Ask-throughput — full request/response round-trip via the `ask` pattern.
 * Each measured op = one ask → reply pair.
 *
 *   bun run benchmarks/single-node/ask-throughput.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, Props, ask } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

class Echo extends Actor<string> {
  override onReceive(m: string): void { this.sender.forEach((s) => s.tell(`echo:${m}`)); }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('bench-ask', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  const ref = system.spawnAnonymous(Props.create(() => new Echo()));

  await runGroup('single-node · ask-throughput', [
    {
      name: 'ask round-trip',
      unit: 'ask',
      iterations: 5_000,
      run: async () => { await ask<string, string>(ref, 'hi', 1_000); },
    },
  ]);

  await system.terminate();
}

void main();
