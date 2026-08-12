/**
 * Memory footprint of queued messages — block an actor on its first
 * message, then push N more into its mailbox and snapshot process memory.
 *
 * A latch promise inside `onReceive` holds the first message long enough
 * for the next N tells to pile up behind it.  We resolve the latch at the
 * end of each run so the actor drains and the process exits cleanly.
 *
 * The rows only became comparable in #1148.  While the default mailbox was
 * bounded at 10 000 with `drop-head`, the 100 000 row retained ~9 999
 * messages and spent the other 90 001 tells performing an O(n) shift over a
 * full array — so the number it printed was allocator churn from the drop
 * path, not the footprint of a queue (#972).  It read *higher* than the
 * unbounded measurement, which is why "the cap is what it reports" was the
 * wrong diagnosis even though the row was wrong.
 *
 *   bun run benchmarks/memory/queued-messages.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } from '../../src/index.js';
import { memoryGroup } from '../lib/harness.js';

type Message = { payload: string };

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('bench-queued', systemOptions);
  const payload: Message = { payload: 'x'.repeat(64) };

  const group = memoryGroup('memory · queued messages (64-byte payload)');

  for (const n of [1_000, 10_000, 100_000] as const) {
    let release: () => void = () => {};
    const latch = new Promise<void>((r) => { release = r; });

    class Sleeper extends Actor<Message> {
      private first = true;
      override async onReceive(_m: Message): Promise<void> {
        if (this.first) {
          this.first = false;
          await latch; // blocks so the next N tells queue up behind this one
        }
      }
    }

    const ref = system.spawnAnonymous(Sleeper);

    await group.measure(`enqueue ${n.toLocaleString()} messages to a blocked actor`, async () => {
      ref.tell(payload); // wedges the actor on the latch
      for (let i = 0; i < n; i++) ref.tell(payload);
      await Bun.sleep(20); // let the scheduler actually populate the mailbox
    });

    // Drain so the next iteration starts with a clean baseline.
    release();
    await Bun.sleep(50);
    ref.stop();
    await Bun.sleep(20);
  }

  group.end();
  await system.terminate();
}

void main();
