/**
 * Hello Reliable Delivery: a producer publishes three messages to a
 * consumer that always succeeds.  You'll see each body printed once and
 * the confirm callbacks fire after the consumer Acks.
 *
 *   bun run examples/delivery/at-least-once-hello.ts
 */
import { ActorSystem } from '../../src/index.js';
import { ReliableDelivery, ProducerControllerOptions } from '../../src/delivery/index.js';

async function main(): Promise<void> {
  const system = ActorSystem.create('rd-hello');
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

  // Not a drain sleep, and load-bearing twice over: the producer and consumer
  // are `/system` actors, which terminate() does not drain, and the stop below
  // is what actually races the acks.  Without this all three report
  // "delivery error: producer stopped" instead of an ack.
  await Bun.sleep(100);
  producer.stop(); consumer.stop();
  await system.terminate();
}

void main();
