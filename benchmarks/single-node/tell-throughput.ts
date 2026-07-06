/**
 * Tell-throughput — how fast can a single actor drain its mailbox?
 *
 * We enqueue N messages in one batch, then `ask` for the final count.
 * `opsPerIteration` = batch size so the harness reports messages/second.
 *
 *   bun run benchmarks/single-node/tell-throughput.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, Props, ask } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Msg = { kind: 'inc' } | { kind: 'get' };

class Counter extends Actor<Msg> {
  private n = 0;
  override onReceive(m: Msg): void {
    if (m.kind === 'inc') this.n++;
    else this.sender.forEach((s) => s.tell(this.n));
  }
}

async function drain(system: ActorSystem, batch: number): Promise<void> {
  const ref = system.spawnAnonymous(Props.create(() => new Counter()));
  for (let i = 0; i < batch; i++) ref.tell({ kind: 'inc' });
  await ask<Msg, number>(ref, { kind: 'get' }, 30_000);
  ref.stop();
}

async function main(): Promise<void> {
  const system = ActorSystem.create('bench-tell', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));

  await runGroup('single-node · tell-throughput', [
    { name: 'batch=100',  unit: 'msg', iterations: 200, opsPerIteration: 100,     run: () => drain(system, 100) },
    { name: 'batch=1k',   unit: 'msg', iterations: 100, opsPerIteration: 1_000,   run: () => drain(system, 1_000) },
    { name: 'batch=10k',  unit: 'msg', iterations: 30,  opsPerIteration: 10_000,  run: () => drain(system, 10_000) },
    { name: 'batch=100k', unit: 'msg', iterations: 10,  opsPerIteration: 100_000, run: () => drain(system, 100_000) },
  ]);

  await system.terminate();
}

void main();
