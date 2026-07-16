/**
 * Baseline — declare a queue, bind it to the default exchange via
 * routing key, publish, consume.  Auto-ack mode (the default).
 */
import { spawnAmqp, spawnInbox, type AmqpContext } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

/**
 * The framework's AmqpActor expects bindings to be pre-declared by
 * the operator OR set up via the `bindings` setting.  For a clean
 * scenario, we pre-declare via amqplib directly, then point the
 * actor at the existing queue.
 */
async function declareQueue(url: string, queue: string): Promise<void> {
  const amqp = await import('amqplib');
  const conn = await amqp.connect(url);
  try {
    const ch = await conn.createChannel();
    try {
      await ch.assertQueue(queue, { durable: false, autoDelete: true });
    } finally {
      await ch.close();
    }
  } finally {
    await conn.close();
  }
}

export const scenario: BrokerScenario<AmqpContext> = {
  name: 'publish/consume round-trip (default exchange + queue binding)',
  async run(ctx) {
    const tag = `b5-pubsub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const queue = `${tag}-queue`;

    // 1. Declare the queue out-of-band so the binding exists when
    //    the actor connects.
    await declareQueue(ctx.url, queue);

    const { ref: inboxRef, inbox } = spawnInbox(ctx);
    const amqp = spawnAmqp(ctx, {
      bindings: [{
        queue,
        target: inboxRef as never,
        // Match the pre-declared queue's properties — without this
        // the actor's assertQueue would conflict (PRECONDITION_FAILED)
        // and silently close the channel.
        queueOptions: { durable: false, autoDelete: true },
      }],
    });
    try {
      // Give the actor time to connect + subscribe.
      await new Promise((r) => setTimeout(r, 1_000));

      // Publish through the default exchange ('') with routingKey == queue.
      // RabbitMQ semantics: the default exchange auto-routes to the
      // queue whose name matches the routing key.
      amqp.tell({
        kind: 'publish',
        publish: {
          exchange: '',
          routingKey: queue,
          content: new TextEncoder().encode('hello-amqp'),
        },
      });

      await waitFor(`delivery on ${queue}`,
        () => inbox.received.length >= 1,
        10_000,
      );
      const delivery = inbox.received[0]!;
      if (new TextDecoder().decode(delivery.content) !== 'hello-amqp') {
        throw new Error(`payload mismatch: got ${new TextDecoder().decode(delivery.content)}`);
      }
    } finally {
      amqp.stop();
      inboxRef.stop();
    }
  },
};
