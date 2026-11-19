/**
 * The default acknowledgment mode against a live RabbitMQ (#976): the actor
 * acks a delivery only once its target replied `{ kind: 'acknowledgment' }`.
 * A `negativeAcknowledgment` reply must leave the delivery with the broker —
 * nacked with requeue — so it comes back, and the acknowledged second copy is
 * then gone for good: once a reply acknowledged it, nothing more arrives.
 */
import { Actor } from '../../../../../src/Actor.js';
import type { AmqpDelivery } from '../../../../../src/io/broker/AmqpActor.js';
import { acknowledgeDelivery, negativelyAcknowledgeDelivery } from '../../../../../src/io/broker/BrokerAcknowledgment.js';
import { spawnAmqp, type AmqpContext } from '../Runner.js';
import { waitFor, type BrokerScenario } from '../../lib/Scenario.js';

async function declareQueue(url: string, queue: string): Promise<void> {
  const amqp = await import('amqplib');
  const connection = await amqp.connect(url);
  try {
    const ch = await connection.createChannel();
    try {
      await ch.assertQueue(queue, { durable: false, autoDelete: true });
    } finally {
      await ch.close();
    }
  } finally {
    await connection.close();
  }
}

/** Refuses the first copy, acknowledges every later one. */
class RefuseOnceThenAcknowledge extends Actor<AmqpDelivery> {
  readonly seen: AmqpDelivery[] = [];
  override onReceive(delivery: AmqpDelivery): void {
    this.seen.push(delivery);
    if (this.seen.length === 1) negativelyAcknowledgeDelivery(delivery, 'first copy refused on purpose');
    else acknowledgeDelivery(delivery);
  }
}

export const scenario: BrokerScenario<AmqpContext> = {
  name: 'on-reply: a negative reply requeues, an acknowledgment settles',
  async run(context) {
    const tag = `b5-on-reply-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const queue = `${tag}-queue`;
    await declareQueue(context.url, queue);

    const handler = new RefuseOnceThenAcknowledge();
    const inboxRef = context.system.spawnAnonymous(() => handler);
    // Shipped defaults: autoAcknowledge true, acknowledgment 'on-reply'.
    const amqp = spawnAmqp(context, {
      bindings: [{
        queue,
        target: inboxRef as never,
        queueOptions: { durable: false, autoDelete: true },
      }],
    });
    try {
      // The consumer registers on a channel the actor opens on its own
      // schedule and exposes no readiness signal for; 02-ack-nack waits the same.
      await new Promise((r) => setTimeout(r, 1_000));

      amqp.tell({
        kind: 'publish',
        publish: { exchange: '', routingKey: queue, content: new TextEncoder().encode('redeliver-me') },
      });

      await waitFor('the refused delivery comes back', () => handler.seen.length >= 2, 10_000);
      if (handler.seen[1]?.replyTo === undefined) {
        throw new Error('the redelivered copy carried no replyTo — on-reply is not the default');
      }
      // Acknowledged now: a third copy would mean the ack never reached the broker.
      await new Promise((r) => setTimeout(r, 1_500));
      if (handler.seen.length !== 2) {
        throw new Error(`expected exactly 2 copies (refused + acknowledged), got ${handler.seen.length}`);
      }
    } finally {
      amqp.stop();
      inboxRef.stop();
    }
  },
};
