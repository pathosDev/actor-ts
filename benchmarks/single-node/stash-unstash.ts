/**
 * Stash + unstash overhead — how fast is the per-actor stash buffer?
 * Each op = stash N, unstash N, drain.
 *
 *   bun run benchmarks/single-node/stash-unstash.ts
 */
import { match } from 'ts-pattern';
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger, Props, ask } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type WorkMessage = { kind: 'work' };
type GoMessage = { kind: 'go' };
type CountMessage = { kind: 'count' };

type Message = WorkMessage | GoMessage | CountMessage;

class Staller extends Actor<Message> {
  private seen = 0;

  override onReceive(m: Message): void {
    match(m)
      .with({ kind: 'work' }, () => this.onWork())
      .with({ kind: 'go' }, () => this.onGo())
      .with({ kind: 'count' }, () => this.onCount())
      .exhaustive();
  }

  private onWork(): void {
    this.context.stash();
  }

  /** Drains the stash, then swaps to the behavior that counts what comes back. */
  private onGo(): void {
    this.context.unstashAll();
    this.context.become((message) => {
      match(message as Message)
        .with({ kind: 'work' }, () => this.onDrainedWork())
        .with({ kind: 'count' }, () => this.onCount())
        .with({ kind: 'go' }, () => this.onGoIgnored())
        .exhaustive();
    });
  }

  private onDrainedWork(): void {
    this.seen++;
  }

  /** A second 'go' after the swap has nothing left to unstash. */
  private onGoIgnored(): void {}

  private onCount(): void {
    this.sender.forEach((s) => s.tell(this.seen));
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
    await ask<Message, number>(ref, { kind: 'count' }, 30_000);
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
