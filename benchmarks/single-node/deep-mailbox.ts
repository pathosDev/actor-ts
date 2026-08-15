/**
 * Deep-mailbox throughput — what does a backlog cost per message?
 *
 * The queue depth is the variable.  Every other single-node benchmark drives
 * a mailbox that happens to be deep as a side effect of the batch size; this
 * one exists to make depth the axis, because the backing store's complexity
 * only shows up as the queue grows and #1148 removed the ceiling that used to
 * cap it (the unbounded mailbox is the default again, so a real backlog is
 * bounded by the heap and nothing else).
 *
 * Two arms, deliberately:
 *
 * - **raw queue** drives `Mailbox` directly — enqueue the whole batch, then
 *   dequeue it — so the number is the data structure and nothing else.  This
 *   is the arm #408 moves.
 * - **through an actor** drives the same depth end-to-end.  It is the honest
 *   figure for a user, and it is much flatter, because on the default
 *   `ImmediateDispatcher` every message pays a `setImmediate` round trip that
 *   dwarfs the queue operation (#409).
 *
 * Measured before/after for #408 (Bun 1.3.1, Windows 11; one op = one
 * message through a full enqueue-then-dequeue cycle at the stated depth):
 *
 * | raw queue | array `shift()` |  ring buffer | ratio |
 * | --------- | --------------- | ------------ | ----- |
 * | depth=1k  |     6.6M msg/s  |   9.3M msg/s | 1.4x  |
 * | depth=10k |     9.8M msg/s  |  14.2M msg/s | 1.5x  |
 * | depth=50k |    12.9M msg/s  |  28.9M msg/s | 2.2x  |
 *
 * The gap widening with depth is the shape to watch — that is the reindex
 * being removed.  It is not the textbook quadratic blow-up, because
 * JavaScriptCore recognises a dense array and slides its start offset instead
 * of moving the payload; that optimisation is an engine's choice, not a
 * guarantee, and it does not survive an array leaving the fast shape.
 *
 * The actor arm moved from ~242k to ~256k msg/s at depth=50k and is flat
 * below that — the dispatcher round trip is three orders of magnitude larger
 * than the queue operation, which is #409's territory, not this one's.
 *
 *   bun run benchmarks/single-node/deep-mailbox.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, Mailbox, NoopLogger } from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Message = { kind: 'increment' } | { kind: 'get' };

class Counter extends Actor<Message> {
  private handled = 0;
  override onReceive(m: Message): void {
    if (m.kind === 'increment') this.handled++;
    else this.sender.forEach((s) => s.tell(this.handled));
  }
}

/**
 * Fill the mailbox completely before draining it, so every `dequeue` runs
 * against a queue that is still deep.  Interleaving would keep the depth at
 * one and measure nothing.
 */
function cycleRawQueue(depth: number): void {
  const mailbox = new Mailbox<number>();
  for (let i = 0; i < depth; i++) mailbox.enqueue({ message: i, sender: null });
  while (mailbox.dequeueUser() !== undefined) { /* drain */ }
}

async function cycleThroughActor(system: ActorSystem, depth: number): Promise<void> {
  const ref = system.spawnAnonymous(Counter);
  // `tell` is synchronous and the dispatcher only runs on the next macrotask,
  // so the whole batch is queued before the first message is handled — the
  // actor really does start its drain from `depth`.
  for (let i = 0; i < depth; i++) ref.tell({ kind: 'increment' });
  await ref.ask<number>({ kind: 'get' }, 60_000);
  ref.stop();
}

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-deep-mailbox', systemOptions);

  await runGroup('single-node · deep-mailbox · raw queue', [
    { name: 'depth=1k',  unit: 'msg', iterations: 200, opsPerIteration: 1_000,  run: () => cycleRawQueue(1_000) },
    { name: 'depth=10k', unit: 'msg', iterations: 50,  opsPerIteration: 10_000, run: () => cycleRawQueue(10_000) },
    { name: 'depth=50k', unit: 'msg', iterations: 20,  opsPerIteration: 50_000, run: () => cycleRawQueue(50_000) },
  ]);

  await runGroup('single-node · deep-mailbox · through an actor', [
    { name: 'depth=1k',  unit: 'msg', iterations: 60, opsPerIteration: 1_000,  run: () => cycleThroughActor(system, 1_000) },
    { name: 'depth=10k', unit: 'msg', iterations: 20, opsPerIteration: 10_000, run: () => cycleThroughActor(system, 10_000) },
    { name: 'depth=50k', unit: 'msg', iterations: 10, opsPerIteration: 50_000, run: () => cycleThroughActor(system, 50_000) },
  ]);

  await system.terminate();
}

void main();
