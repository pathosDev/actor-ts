/**
 * Stash + unstash overhead — how fast is the per-actor stash buffer?
 * Each op = stash N, unstash N, drain.
 *
 *   bun run benchmarks/single-node/stash-unstash.ts
 */
import { Actor, ActorSystem, LogLevel, NoopLogger, Props, ask } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Msg = { kind: 'work' } | { kind: 'go' } | { kind: 'count' };

class Staller extends Actor<Msg> {
  private seen = 0;
  override onReceive(m: Msg): void {
    if (m.kind === 'work') {
      this.context.stash();
      return;
    }
    if (m.kind === 'go') {
      this.context.unstashAll();
      this.context.become((msg) => {
        if ((msg as Msg).kind === 'work') this.seen++;
        if ((msg as Msg).kind === 'count') this.sender.forEach((s) => s.tell(this.seen));
      });
      return;
    }
    if (m.kind === 'count') this.sender.forEach((s) => s.tell(this.seen));
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('bench-stash', { logger: new NoopLogger(), logLevel: LogLevel.Off });

  const run = async (batch: number): Promise<void> => {
    const ref = system.spawnAnonymous(Props.create(() => new Staller()));
    for (let i = 0; i < batch; i++) ref.tell({ kind: 'work' });
    ref.tell({ kind: 'go' });
    await ask<Msg, number>(ref, { kind: 'count' }, 30_000);
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
