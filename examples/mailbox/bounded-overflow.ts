/**
 * Hello Bounded Mailbox: pick the "drop-head" policy to make the actor
 * always work on the freshest messages.  Slow handler + fast producer ⇒
 * the mailbox drops old items to keep up.
 *
 *   bun run examples/mailbox/bounded-overflow.ts
 */
import {
  Actor,
  ActorSystem,
  BoundedMailbox,
  ActorOptions,
} from '../../src/index.js';

class SlowPrinter extends Actor<number> {
  override async onReceive(n: number): Promise<void> {
    await Bun.sleep(30);
    console.log(`processed ${n}`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('bnd-hello');
  const printerOptions = ActorOptions.create<number>()
    .withMailbox(() => new BoundedMailbox<number>({ capacity: 2, overflow: 'drop-head' }) as never);
  const ref = system.spawnAnonymous(SlowPrinter, printerOptions);

  for (let i = 0; i < 10; i++) ref.tell(i);
  // No sleep: the drops happen synchronously as the loop overflows the
  // capacity-2 mailbox, and terminate() drains whatever survived.
  await system.terminate();
}

void main();
