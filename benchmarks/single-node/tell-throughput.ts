/**
 * Tell-throughput — how fast can a single actor drain its mailbox?
 *
 * We enqueue N messages in one batch, then `ask` for the final count.
 * `opsPerIteration` = batch size so the harness reports messages/second.
 *
 * `batch=100k` was fiction until #1148.  The default mailbox was bounded at
 * 10 000, so the iteration handled ~9 999 messages while the harness was
 * told it had handled 100 000 — the row printed ~1.04M msg/s against a real
 * ~245k, four times the truth, and the shape of the drop path rather than
 * the drain path (#1027).  Every batch now completes in full, which is why
 * the rows finally agree with each other.
 *
 * Measured for #409 (Bun 1.3.1, Windows 11), one message per op:
 *
 * | batch | one message per turn | batched (throughput=16) | ratio |
 * | ----- | -------------------- | ----------------------- | ----- |
 * | 100   |          136k msg/s  |              281k msg/s | 2.1x  |
 * | 1k    |          246k msg/s  |              681k msg/s | 2.8x  |
 * | 10k   |          254k msg/s  |              745k msg/s | 2.9x  |
 * | 100k  |          255k msg/s  |              735k msg/s | 2.9x  |
 *
 * The "before" column is the tree at #408 — re-measured rather than taken
 * from this header's old ~245k, which predated the ring buffer.  The ratio
 * is bounded by what a round trip costs relative to the handler: batching
 * removes 15 of every 16 `setImmediate` hops, and what remains is the
 * per-message microtask that awaiting an async handler costs either way.
 * `batch=100` gains least because the batch is amortised over fewer
 * messages before the mailbox runs dry.
 *
 *   bun run benchmarks/single-node/tell-throughput.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Message = { kind: 'increment' } | { kind: 'get' };

class Counter extends Actor<Message> {
  private n = 0;
  override onReceive(m: Message): void {
    if (m.kind === 'increment') this.n++;
    else this.sender.forEach((s) => s.tell(this.n));
  }
}

async function drain(system: ActorSystem, batch: number): Promise<void> {
  const ref = system.spawnAnonymous(Counter);
  for (let i = 0; i < batch; i++) ref.tell({ kind: 'increment' });
  await ref.ask<number>({ kind: 'get' }, 30_000);
  ref.stop();
}

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-tell', systemOptions);

  await runGroup('single-node · tell-throughput', [
    { name: 'batch=100',  unit: 'msg', iterations: 200, opsPerIteration: 100,     run: () => drain(system, 100) },
    { name: 'batch=1k',   unit: 'msg', iterations: 100, opsPerIteration: 1_000,   run: () => drain(system, 1_000) },
    { name: 'batch=10k',  unit: 'msg', iterations: 30,  opsPerIteration: 10_000,  run: () => drain(system, 10_000) },
    { name: 'batch=100k', unit: 'msg', iterations: 10,  opsPerIteration: 100_000, run: () => drain(system, 100_000) },
  ]);

  await system.terminate();
}

void main();
