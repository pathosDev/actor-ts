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
 * Measured for #409 + #411 (Bun 1.3.1, Windows 11), one message per op.
 * Each column is the mean of several rounds run *alternately* with its
 * neighbour rather than one run apiece, because a single sample here is not
 * separable from the noise — the run-to-run spread within one arm is 5-15%,
 * so read the ratios and treat the last digit of every figure as fiction:
 *
 * | batch | at #408 | + batching (#409) | + fewer allocations (#411) | total |
 * | ----- | ------- | ----------------- | -------------------------- | ----- |
 * | 100   |    143k |        297k (2.1x)|                       337k  | 2.4x  |
 * | 1k    |    250k |        656k (2.6x)|                       740k  | 3.0x  |
 * | 10k   |    255k |        723k (2.8x)|                       922k  | 3.6x  |
 * | 100k  |    202k |        717k (3.6x)|                       902k  | 4.5x  |
 *
 * The "at #408" column was re-measured rather than taken from this header's
 * old ~245k, which predated the ring buffer.  The two arms at #409 were
 * measured twice, once against each neighbour, and agreed within 1-2% — which
 * is the check that makes the columns comparable at all.
 *
 * The two changes move different costs and the split is worth keeping.  #409
 * removes 15 of every 16 `setImmediate` round trips; what survives it is the
 * per-message microtask that awaiting an async handler costs either way, which
 * is why `batch=100` gains least — the batch is amortised over fewer messages
 * before the mailbox runs dry.  #411 then removes the four extension lookups,
 * four metric label objects, one closure, one keys array and two clock reads
 * that every delivery paid with instrumentation switched *off*, and it shows
 * up here rather than on a memory bench because that garbage was short-lived:
 * it never survived a collection, so it cost GC pressure and never appeared as
 * retention.  See `benchmarks/memory/receive-path.ts`.
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
