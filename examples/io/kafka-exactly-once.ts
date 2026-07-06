/**
 * Manual offset-commit / exactly-once-with-processing demo (#2).
 *
 *   bun run examples/io/kafka-exactly-once.ts
 *   # (requires kafkajs: `bun add kafkajs`)
 *   # (requires a real broker reachable at localhost:9092 — adjust below)
 *
 * The pattern:
 *
 *   1. KafkaActor configured with `consumer.commitMode: 'manual'`.
 *      The consumer pump pauses on every record and awaits an
 *      explicit `commit` (or `nack`) command from the handler.
 *
 *   2. Handler does its work (here: a fake DB call).  On success it
 *      tells the KafkaActor `{ kind: 'commit', topic, partition,
 *      offset }`; on failure it tells `{ kind: 'nack', ... }`.
 *
 *   3. Crash semantics: if the handler dies mid-processing without
 *      sending either, the pump's commitTimeoutMs fires, kafkajs
 *      treats the partition as failed, and the same offset is
 *      re-delivered after rebalance — at-least-once on the wire,
 *      exactly-once at the application level (assuming idempotent
 *      DB writes or transactional producer for downstream effects).
 */
import {
  Actor,
  ActorSystem,
  Props,
  KafkaActor,
  KafkaOptions,
  type KafkaCmd,
  type KafkaRecord,
} from '../../src/index.js';
import type { ActorRef } from '../../src/index.js';

interface Order { orderId: string; userId: string; amount: number }

class OrderProcessor extends Actor<KafkaRecord> {
  constructor(private readonly kafka: ActorRef<KafkaCmd>) { super(); }

  override async onReceive(rec: KafkaRecord): Promise<void> {
    const text = new TextDecoder().decode(rec.value!);
    let order: Order;
    try {
      order = JSON.parse(text);
    } catch (e) {
      console.error(`bad payload at offset ${rec.offset}, nacking:`, e);
      this.kafka.tell({
        kind: 'nack', topic: rec.topic, partition: rec.partition, offset: rec.offset,
        reason: 'malformed JSON',
      });
      return;
    }

    try {
      await db_insertOrder(order);
      console.log(`processed order ${order.orderId} at offset ${rec.offset}`);
      // Idempotency in the DB layer (an insert ... on conflict do
      // nothing keyed by orderId) is what makes the at-most-once
      // guarantee airtight — even if a re-delivery sneaks past, the
      // second insert is a no-op.
      this.kafka.tell({
        kind: 'commit', topic: rec.topic, partition: rec.partition, offset: rec.offset,
      });
    } catch (e) {
      console.error(`db error at offset ${rec.offset}, nacking:`, e);
      this.kafka.tell({
        kind: 'nack', topic: rec.topic, partition: rec.partition, offset: rec.offset,
        reason: (e as Error).message,
      });
    }
  }
}

async function db_insertOrder(o: Order): Promise<void> {
  // Pretend to do real I/O.  A real impl would hit Postgres /
  // DynamoDB / etc with an idempotency-key-based upsert so a
  // re-delivery couldn't double-charge the user.
  await Bun.sleep(5);
  if (o.amount < 0) throw new Error('negative amount');
}

async function main(): Promise<void> {
  const system = ActorSystem.create('kafka-eo-demo');

  // Forward decl so the processor can refer to the kafka actor.
  let kafka!: ActorRef<KafkaCmd>;

  const processor = system.spawn(
    Props.create(() => new OrderProcessor(kafka)),
    'processor',
  );

  kafka = system.spawn(
    Props.create(() => new KafkaActor(
      KafkaOptions.create()
        .withBrokers(['localhost:9092'])
        .withClientId('eo-demo')
        .withConsumer({
          groupId: 'orders-eo',
          commitMode: 'manual',
          commitTimeoutMs: 30_000,
          fromBeginning: false,
        })
        .withTopics(['orders'])
        .withTarget(processor)
        // Idempotent producer keeps any downstream emits exactly-once
        // on the producer side too.
        .withProducer({ idempotent: true, allowAutoTopicCreation: false }),
    )),
    'kafka',
  );

  console.log('listening for orders on `orders` topic — press Ctrl+C to stop');
  // Keep the process alive.  Real apps would integrate with their
  // existing shutdown path; here we just block.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
  });
  await system.terminate();
}

void main();
