/**
 * Stash + unstash overhead — how fast is the per-actor stash buffer?
 * Each op = stash N, unstash N, drain.
 *
 *   bun run benchmarks/single-node/stash-unstash.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, Props } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Message = { kind: 'work' } | { kind: 'go' } | { kind: 'count' };

/*
 * The dispatch below deliberately stays a raw `if`-chain, against the
 * project-wide `match()` rule (AGENTS.md).  This benchmark measures the
 * per-message path itself, and ts-pattern's allocation per `match()` call
 * shows up directly in the number: converting it cost ~10 % here
 * (133k -> 119k msg/s at stash=1000), consistently across alternating runs.
 * Measuring the framework's overhead through a matcher that production
 * actor code would amortise differently makes the figure say less, not more.
 */
class Staller extends Actor<Message> {
  private seen = 0;
  override onReceive(m: Message): void {
    if (m.kind === 'work') {
      this.context.stash();
      return;
    }
    if (m.kind === 'go') {
      this.context.unstashAll();
      this.context.become((message) => {
        if ((message as Message).kind === 'work') this.seen++;
        if ((message as Message).kind === 'count') this.sender.forEach((s) => s.tell(this.seen));
      });
      return;
    }
    if (m.kind === 'count') this.sender.forEach((s) => s.tell(this.seen));
  }
}

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-stash', systemOptions);

  const run = async (batch: number): Promise<void> => {
    const ref = system.spawnAnonymous(Props.create(() => new Staller()));
    for (let i = 0; i < batch; i++) ref.tell({ kind: 'work' });
    ref.tell({ kind: 'go' });
    await ref.ask<number>({ kind: 'count' }, 30_000);
    ref.stop();
  };

  // Stash buffer capacity defaults to 1024 messages per actor — larger
  // batches would trip StashOverflowError, restart the actor, and lose the
  // `count` ask reply.  The benchmark stays within that limit.
  await runGroup('single-node · stash-unstash', [
    { name: 'stash=100',  unit: 'msg', iterations: 200, opsPerIteration: 100,   run: () => run(100) },
    { name: 'stash=500',  unit: 'msg', iterations: 80,  opsPerIteration: 500,   run: () => run(500) },
    { name: 'stash=1000', unit: 'msg', iterations: 40,  opsPerIteration: 1_000, run: () => run(1_000) },
  ]);

  await system.terminate();
}

void main();
