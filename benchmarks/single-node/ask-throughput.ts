/**
 * Ask-throughput — full request/response round-trip via the `ask` pattern.
 * Each measured op = one ask → reply pair.
 *
 * **This arm is structurally immune to per-actor batching (#409), and that is
 * worth knowing before anyone measures it against a batching change.**  The
 * loop awaits each reply before issuing the next ask, so the echo actor's
 * mailbox never holds more than one message and a batch of 16 has 15 slots of
 * nothing to do.  What batching removes is the *second and subsequent*
 * scheduling round trips within one turn; a depth-1 workload only ever pays
 * the first.  #409 measured 64.9k -> 91.8k ask/s (1.4x) here against 2.1-2.9x
 * on `tell-throughput`, and the gap is the whole explanation — the residual
 * gain is the reply hop sharing a turn, not the request being batched.
 *
 * A pipelined arm (N asks in flight, then `Promise.all`) would be the one that
 * responds to this knob.  It is deliberately not added here: this file's
 * subject is round-trip *latency* under the ask pattern, and folding a
 * throughput arm into it would make the single row mean two things.
 *
 *   bun run benchmarks/single-node/ask-throughput.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

class Echo extends Actor<string> {
  override onReceive(m: string): void { this.sender.forEach((s) => s.tell(`echo:${m}`)); }
}

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-ask', systemOptions);
  const ref = system.spawnAnonymous(Echo);

  await runGroup('single-node · ask-throughput', [
    {
      name: 'ask round-trip',
      unit: 'ask',
      iterations: 5_000,
      run: async () => { await ref.ask<string>('hi', 1_000); },
    },
  ]);

  await system.terminate();
}

void main();
