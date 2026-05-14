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
  Props,
} from '../../src/index.js';

class SlowPrinter extends Actor<number> {
  override async onReceive(n: number): Promise<void> {
    await Bun.sleep(30);
    console.log(`processed ${n}`);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('bnd-hello');
  const props = Props.create(() => new SlowPrinter())
    .withMailbox(() => new BoundedMailbox<number>({ capacity: 2, overflow: 'drop-head' }) as never);
  const ref = system.spawnAnonymous(props);

  for (let i = 0; i < 10; i++) ref.tell(i);
  await Bun.sleep(200);
  await system.terminate();
}

void main();
