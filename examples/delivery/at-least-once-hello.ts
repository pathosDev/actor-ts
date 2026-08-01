/**
 * Hello Reliable Delivery: a producer publishes three messages to a
 * consumer that always succeeds.  You'll see each body printed once and
 * the confirm callbacks fire after the consumer Acks.
 *
 *   bun run examples/delivery/at-least-once-hello.ts
 */
import { ActorSystem, ReliableDelivery, ProducerControllerOptions } from '../../src/index.js';
import { attachDevTools } from '../devtools.js';

async function main(): Promise<void> {
  const system = ActorSystem.create('rd-hello');
  const devtools = await attachDevTools(system);
  const consumer = ReliableDelivery.consumer<string>(system, {
    handler: (m) => console.log(`[consumer] received "${m}"`),
  });
  const producer = ReliableDelivery.producer<string>(system,
    ProducerControllerOptions.create<string>().withConsumer(consumer.ref as never),
  );

  for (const s of ['hello', 'world', 'reliable-delivery']) {
    producer.tell(s, (err) => {
      console.log(err ? `[producer] delivery error: ${err.message}` : `[producer] acked "${s}"`);
    });
  }

  await Bun.sleep(100);
  producer.stop(); consumer.stop();
  await devtools.holdOpen();
  await system.terminate();
}

void main();
