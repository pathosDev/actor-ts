/**
 * JetStream durable streaming demo (#3).
 *
 *   bun run examples/io/jetstream-orders.ts
 *   # (requires nats peer-dep: `bun add nats`)
 *   # (requires a NATS server with JetStream enabled — `nats-server -js`)
 *
 * Pattern:
 *
 *   1. JetStreamActor owns the `ORDERS` stream + a durable consumer
 *      `order-proc`.  Both are auto-created at connect time.
 *
 *   2. Producer publishes to `orders.new` with a `messageId` —
 *      JetStream's dedupe-window guarantees that re-publishing the
 *      same id is idempotent at the stream level.
 *
 *   3. Consumer (OrderProcessor) handles each delivery and acks /
 *      naks / terms.  Ack on success, nak with delay on transient
 *      failures (DB hiccup), term on permanent failures (malformed
 *      JSON).
 *
 *   4. Long-running handlers can call `inProgress` to extend the
 *      ack window without losing the lease.
 */
import {
  Actor,
  ActorSystem,
  Props,
  JetStreamActor,
  type JetStreamCmd,
  type JetStreamMessage,
} from '../../src/index.js';
import type { ActorRef } from '../../src/index.js';

interface Order { orderId: string; amount: number }

class OrderProcessor extends Actor<JetStreamMessage> {
  constructor(private readonly js: ActorRef<JetStreamCmd>) { super(); }

  override async onReceive(m: JetStreamMessage): Promise<void> {
    const text = new TextDecoder().decode(m.payload);
    let order: Order;
    try {
      order = JSON.parse(text);
    } catch {
      console.error(`bad payload at streamSeq=${m.streamSeq}, terming`);
      this.js.tell({ kind: 'term', streamSeq: m.streamSeq, reason: 'malformed JSON' });
      return;
    }

    try {
      await db_insertOrder(order);
      console.log(`processed ${order.orderId} (streamSeq=${m.streamSeq}, deliveries=${m.deliveries})`);
      this.js.tell({ kind: 'ack', streamSeq: m.streamSeq });
    } catch (e) {
      console.error(`db error at streamSeq=${m.streamSeq}, naking with backoff`);
      this.js.tell({ kind: 'nak', streamSeq: m.streamSeq, delayMs: 5_000 });
    }
  }
}

async function db_insertOrder(o: Order): Promise<void> {
  await Bun.sleep(5);
  if (o.amount < 0) throw new Error('negative amount');
}

async function main(): Promise<void> {
  const system = ActorSystem.create('js-orders-demo');
  let js!: ActorRef<JetStreamCmd>;

  const processor = system.actorOf(
    Props.create(() => new OrderProcessor(js)),
    'processor',
  );

  js = system.actorOf(
    Props.create(() => new JetStreamActor({
      servers: ['nats://localhost:4222'],
      stream: {
        name: 'ORDERS',
        subjects: ['orders.>'],
        retention: 'limits',
        storage: 'file',
      },
      consumer: {
        durable: 'order-proc',
        ackPolicy: 'explicit',
        ackWaitMs: 30_000,
        deliverPolicy: 'all',
      },
      target: processor,
    })),
    'js',
  );

  // Give the actor a moment to connect + create the stream/consumer.
  await Bun.sleep(500);

  // Producer side — publish a few orders with idempotent message ids.
  for (const o of [
    { orderId: 'A1', amount: 100 },
    { orderId: 'A2', amount: 50 },
    { orderId: 'A3', amount: -1 },     // intentional fail → nak + backoff
  ]) {
    js.tell({
      kind: 'publish',
      publish: {
        subject: 'orders.new',
        payload: JSON.stringify(o),
        messageId: `ord-${o.orderId}`,
      },
    });
  }

  console.log('press Ctrl+C to exit');
  await new Promise<void>((resolve) => process.on('SIGINT', () => resolve()));
  await system.terminate();
}

void main();
