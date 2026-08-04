/**
 * Priority mailbox vs. default mailbox — what's the cost of ordering?
 *
 *   bun run benchmarks/single-node/priority-mailbox.ts
 */
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  LogLevel,
  NoopLogger,
  PriorityMailbox,
  ActorOptions,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Message = { pri: number; id: number } | { kind: 'count' };

class Worker extends Actor<Message> {
  private seen = 0;
  override onReceive(m: Message): void {
    if ('kind' in m) this.sender.forEach((s) => s.tell(this.seen));
    else this.seen++;
  }
}

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-pri', systemOptions);
  const batch = 5_000;

  const worker = (): Worker => new Worker();
  const priorityOptions = ActorOptions.create<Message>()
    .withMailbox(() => new PriorityMailbox<Message>({
      priorityFor: (m) => ('pri' in m ? m.pri : 0),
    }) as never);

  const drain = async (options?: ActorOptions<Message>): Promise<void> => {
    const ref = system.spawnAnonymous(worker, options);
    for (let i = 0; i < batch; i++) ref.tell({ pri: (i * 7) % 5, id: i });
    await ref.ask<number>({ kind: 'count' }, 30_000);
    ref.stop();
  };

  await runGroup('single-node · priority-mailbox (batch=5k)', [
    { name: 'default mailbox',  unit: 'msg', iterations: 30, opsPerIteration: batch, run: () => drain() },
    { name: 'priority mailbox', unit: 'msg', iterations: 30, opsPerIteration: batch, run: () => drain(priorityOptions) },
  ]);

  await system.terminate();
}

void main();
