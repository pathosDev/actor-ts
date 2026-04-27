/**
 * Hello Reliable Delivery: a producer publishes three messages to a
 * consumer that always succeeds.  You'll see each body printed once and
 * the confirm callbacks fire after the consumer Acks.
 *
 *   bun run examples/delivery/at-least-once-hello.ts
 */
import { ActorSystem, ReliableDelivery } from '../../src/index.js';

async function main(): Promise<void> {
  const system = ActorSystem.create('rd-hello');
  const consumer = ReliableDelivery.consumer<string>(system, {
    handler: (m) => console.log(`[consumer] received "${m}"`),
  });
  const producer = ReliableDelivery.producer<string>(system, {
    consumer: consumer.ref as never,
  });

  for (const s of ['hello', 'world', 'reliable-delivery']) {
    producer.tell(s, (err) => {
      console.log(err ? `[producer] delivery error: ${err.message}` : `[producer] acked "${s}"`);
    });
  }

  await Bun.sleep(100);
  producer.stop(); consumer.stop();
  await system.terminate();
}

void main();
