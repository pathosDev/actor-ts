/**
 * Manual-ack mode — autoAck=false.  The consumer holds the delivery
 * until an explicit `{ kind: 'ack', delivery }` arrives.  A `nack`
 * with `requeue: true` puts the message back on the queue for
 * re-delivery; with `requeue: false` it goes to dead-letter (or
 * is dropped if no DLX is configured).
 */
import { Actor } from '../../../../../src/Actor.js';
import { Props } from '../../../../../src/Props.js';
import type { AmqpCommand, AmqpDelivery } from '../../../../../src/io/broker/AmqpActor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { spawnAmqp, type AmqpCtx } from '../runner.js';
import { waitFor, type BrokerScenario } from '../../lib/scenario.js';

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

class AckOnSecondTry extends Actor<AmqpDelivery> {
  readonly seen: AmqpDelivery[] = [];
  ackCount = 0;
  nackCount = 0;
  kafka: ActorRef<AmqpCommand> | null = null;
  override onReceive(d: AmqpDelivery): void {
    this.seen.push(d);
    if (this.seen.length === 1) {
      // First delivery — nack with requeue so it comes back.
      this.kafka?.tell({ kind: 'nack', delivery: d, requeue: true });
      this.nackCount++;
    } else {
      // Subsequent deliveries — ack.
      this.kafka?.tell({ kind: 'ack', delivery: d });
      this.ackCount++;
    }
  }
}

export const scenario: BrokerScenario<AmqpCtx> = {
  name: 'manual ack + nack-requeue triggers re-delivery',
  async run(ctx) {
    const tag = `b5-ack-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const queue = `${tag}-queue`;
    await declareQueue(ctx.url, queue);

    const handler = new AckOnSecondTry();
    const inboxRef = ctx.system.spawnAnonymous(Props.create(() => handler));
    const amqp = spawnAmqp(ctx, {
      autoAck: false,
      bindings: [{
        queue,
        target: inboxRef as never,
        queueOptions: { durable: false, autoDelete: true },
      }],
    });
    handler.kafka = amqp as unknown as ActorRef<AmqpCommand>;
    try {
      await new Promise((r) => setTimeout(r, 1_000));

      amqp.tell({
        kind: 'publish',
        publish: { exchange: '', routingKey: queue, content: new TextEncoder().encode('redeliver-me') },
      });

      // First delivery → nack/requeue → second delivery → ack.
      await waitFor(`second delivery (post-requeue) arrives`,
        () => handler.seen.length >= 2 && handler.ackCount >= 1,
        10_000,
      );
      if (handler.nackCount < 1 || handler.ackCount < 1) {
        throw new Error(`expected ≥1 nack + ≥1 ack, got nacks=${handler.nackCount} acks=${handler.ackCount}`);
      }
    } finally {
      amqp.stop();
      inboxRef.stop();
    }
  },
};
