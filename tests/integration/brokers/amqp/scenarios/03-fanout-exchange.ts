/**
 * Fanout exchange — a single publish fans out to N queues bound to
 * the same exchange.  Verifies the framework's binding setup works
 * against a non-default exchange.
 */
import { spawnAmqp, spawnInbox, type AmqpCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

async function declareTopology(url: string, exchange: string, queues: string[]): Promise<void> {
  const amqp = await import('amqplib');
  const conn = await amqp.connect(url);
  try {
    const ch = await conn.createChannel();
    try {
      await ch.assertExchange(exchange, 'fanout', { durable: false, autoDelete: true });
      for (const q of queues) {
        await ch.assertQueue(q, { durable: false, autoDelete: true });
        await ch.bindQueue(q, exchange, '');
      }
    } finally {
      await ch.close();
    }
  } finally {
    await conn.close();
  }
}

export const scenario: BrokerScenario<AmqpCtx> = {
  name: 'fanout exchange — single publish → multiple queues',
  async run(ctx) {
    const tag = `b5-fanout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const exchange = `${tag}-ex`;
    const q1 = `${tag}-q1`;
    const q2 = `${tag}-q2`;
    await declareTopology(ctx.url, exchange, [q1, q2]);

    const { ref: inboxA, inbox: aInbox } = spawnInbox(ctx);
    const { ref: inboxB, inbox: bInbox } = spawnInbox(ctx);
    const consumerA = spawnAmqp(ctx, {
      bindings: [{ queue: q1, target: inboxA as never }],
    });
    const consumerB = spawnAmqp(ctx, {
      bindings: [{ queue: q2, target: inboxB as never }],
    });
    const publisher = spawnAmqp(ctx);
    try {
      await new Promise((r) => setTimeout(r, 1_500));

      publisher.tell({
        kind: 'publish',
        publish: {
          exchange,
          routingKey: '', // fanout ignores routingKey
          content: new TextEncoder().encode('broadcast'),
        },
      });

      await waitFor(`both queues received the broadcast`,
        () => aInbox.received.length >= 1 && bInbox.received.length >= 1,
        10_000,
      );
    } finally {
      publisher.stop();
      consumerA.stop();
      consumerB.stop();
      inboxA.stop();
      inboxB.stop();
    }
  },
};
