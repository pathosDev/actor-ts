/**
 * Why one reliable-delivery stream feeds exactly one consumer (#1470).
 *
 * The delivery pages used to suggest splitting one logical stream across N
 * consumers with "a custom router on top".  That cannot work, and no router
 * can make it work, because the obstacle is the consumer's own window: it
 * keys its deduplication state on `(producerId, incarnation)` and holds it on
 * one consumer only.
 *
 * Before the producer's floor (#1862) the split stalled outright: a consumer
 * handed every other sequence never saw its gaps close, handled up to
 * `maxOutOfOrder` sequences above the first one, and refused the rest.  The
 * floor closes those gaps once the other consumer's acknowledgments reach the
 * producer, so the first case now pins the stall only while the gap is still
 * held open: every delivery carries floor 1, as it does while seq 1 is
 * unacknowledged.  What the floor cannot give a split stream is deduplication
 * across consumers — a retransmit the router hands to the other consumer runs
 * the handler a second time, where one consumer would absorb it — and the
 * router case pins exactly that.
 *
 * What the pages say instead is one producer per consumer, each its own
 * `(producerId, incarnation)` stream, with the caller choosing the stream.
 * The last case is that advice running under the same cap, and it drains.
 * Work-pulling — one producer, consumers pulling by demand — is #1470's to
 * build.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  ConsumerController,
  ConsumerControllerOptions,
  ProducerController,
  ProducerControllerOptions,
  ReliableDelivery,
} from '../../../src/delivery/index.js';
import type { Delivery } from '../../../src/delivery/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * The cap every case runs under.  Small so the stall is readable — the
 * default of 1 024 stalls the same way, only later.
 */
const MAX_OUT_OF_ORDER = 8;

const quietOptions = (): TestKitOptions => TestKitOptions.create()
  .withLogger(new NoopLogger())
  .withLogLevel(LogLevel.Off);

/** Mutable slot the spawn factory writes the live controller into. */
type ControllerSlot = { controller: ConsumerController<number> | null };

/**
 * Spawn a consumer under `/user` and keep hold of the instance.
 *
 * Under `/user` so `kit.settle()` covers it — the facade spawns under
 * `/system/delivery`, which the settle deliberately does not inspect — and
 * kept so `outOfOrderFor` can say the window is parked at the cap rather
 * than merely slow.  `holdHandler`, when given, is awaited after a body is
 * recorded, so a test can keep the handler running while time moves on.
 */
const spawnConsumer = (
  kit: TestKit,
  slot: ControllerSlot,
  handled: number[],
  name: string,
  holdHandler: () => Promise<void> = () => Promise.resolve(),
): ActorRef<Delivery<number>> => {
  const consumerOptions = ConsumerControllerOptions.create<number>()
    .withHandler(async (body) => {
      handled.push(body);
      await holdHandler();
    })
    .withMaxOutOfOrder(MAX_OUT_OF_ORDER);
  return kit.system.spawn<Delivery<number>>(() => {
    slot.controller = new ConsumerController<number>(consumerOptions);
    return slot.controller;
  }, name);
};

/**
 * A hand-built delivery of `seq` from one fixed `(producerId, incarnation)`,
 * carrying floor 1: the producer still holds seq 1 unacknowledged.
 */
const deliver = (consumer: ActorRef<Delivery<number>>, replyTo: unknown, seq: number): void => {
  consumer.tell({
    kind: 'reliable-delivery.delivery',
    producerId: 'one-stream',
    incarnation: 'incarnation-1',
    seq,
    floor: 1,
    body: seq,
    replyTo,
  } as never);
};

/** Forwards each delivery to the next consumer in turn — the "custom router on top". */
class RoundRobinRouter extends Actor<Delivery<number>> {
  private next = 0;

  constructor(private readonly consumers: readonly ActorRef<Delivery<number>>[]) {
    super();
  }

  override onReceive(delivery: Delivery<number>): void {
    const consumer = this.consumers[this.next % this.consumers.length]!;
    this.next++;
    consumer.tell(delivery);
  }
}

describe('Multiple consumers — one stream split across them (#1470)', () => {
  test('a consumer fed every other sequence of one stream, while seq 1 is unacknowledged, handles maxOutOfOrder of them and refuses the rest', async () => {
    const kit = TestKit.create('multiple-consumers-even-half', quietOptions());
    const handled: number[] = [];
    const slot: ControllerSlot = { controller: null };
    const acknowledgments = kit.createTestProbe();
    const consumer = spawnConsumer(kit, slot, handled, 'even-half');

    // The even half of one stream — what the second consumer of a two-way
    // round robin over a single sequence space receives.  Seq 1 never
    // arrives here, and neither does any other odd one.
    for (let seq = 2; seq <= 40; seq += 2) deliver(consumer, acknowledgments, seq);
    // Every delivery is already told and the consumer lives under /user, so
    // settling the tree is a barrier rather than a wait: when it returns,
    // each of the twenty has been handled or refused.
    await kit.settle();

    // Eight handled, twelve refused: 2..16 fill the out-of-order window
    // above the gap at 1, and 18..40 find it full.
    expect(handled).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(acknowledgments.messageCount).toBe(MAX_OUT_OF_ORDER);
    expect(slot.controller?.outOfOrderFor('one-stream')).toBe(MAX_OUT_OF_ORDER);

    // A stall for as long as seq 1 stays unacknowledged: the retransmits of
    // the refused twelve meet the same full window, because the sequences
    // that would close the gaps went to the other consumer and never come
    // here, and the floor cannot rise past a seq the producer still holds.
    for (let seq = 18; seq <= 40; seq += 2) deliver(consumer, acknowledgments, seq);
    await kit.settle();
    expect(handled).toHaveLength(MAX_OUT_OF_ORDER);
    expect(acknowledgments.messageCount).toBe(MAX_OUT_OF_ORDER);

    await kit.system.terminate();
  });

  test('a router splitting one producer across two consumers runs a retransmitted message on both', async () => {
    // The advice the pages used to give, end to end: a real producer whose
    // `consumer` is a router alternating between two consumers.  Virtual
    // time, so the producer's retransmit fires when the test says and not
    // before.  Everything is spawned under /user so one settle covers the
    // producer as well; that is also why the send carries no `confirm`, which
    // the kit's structured-clone check refuses on a /user recipient.
    const { kit, scheduler } = TestKit.withManualScheduler('multiple-consumers-router', quietOptions());
    const odd: number[] = [];
    const even: number[] = [];
    let releaseOdd: () => void = () => {};
    const oddGate = new Promise<void>((resolve) => { releaseOdd = resolve; });
    const oddSlot: ControllerSlot = { controller: null };
    const evenSlot: ControllerSlot = { controller: null };
    const oddConsumer = spawnConsumer(kit, oddSlot, odd, 'odd-consumer', () => oddGate);
    const evenConsumer = spawnConsumer(kit, evenSlot, even, 'even-consumer');
    const router = kit.system.spawn<Delivery<number>>(
      () => new RoundRobinRouter([oddConsumer, evenConsumer]),
      'router',
    );

    const producerOptions = ProducerControllerOptions.create<number>()
      .withProducerId('split-stream')
      .withConsumer(router)
      .withWindowSize(16)
      .withResendTimeout(1_000);
    const producer = kit.system.spawn(() => new ProducerController<number>(producerOptions), 'producer');
    // One job: the router hands it to the odd consumer, and its retransmit —
    // the router's second delivery — to the even one.
    producer.tell({ kind: 'reliable-delivery.send', body: 1 });
    await awaitCondition(() => odd.length === 1, {
      timeoutMs: 4_000,
      label: 'the odd consumer started handling job 1',
    });

    // The odd consumer is still inside its handler when the resend timer
    // fires.  One consumer would absorb that retransmit as the duplicate it
    // is; the router hands it to a consumer that has never seen the seq.
    scheduler.advance(1_000);
    await awaitCondition(() => even.length === 1, {
      timeoutMs: 4_000,
      label: 'the retransmit reached the even consumer',
    });
    releaseOdd();
    await kit.settle();

    // The handler ran twice for one message, once on each consumer — the
    // deduplication the protocol promises holds per consumer, never across
    // them.
    expect(odd).toEqual([1]);
    expect(even).toEqual([1]);

    await kit.system.terminate();
  });

  test('one producer per consumer: each stream drains completely under the same cap', async () => {
    // The replacement advice, through the facade the pages build it with.
    // The caller picks the stream — here by parity — and each producer is
    // its own (producerId, incarnation), so neither consumer ever sees a gap.
    const kit = TestKit.create('multiple-consumers-one-each', quietOptions());
    const odd: number[] = [];
    const even: number[] = [];
    const oddConsumer = ReliableDelivery.consumer<number>(kit.system, {
      handler: (body) => { odd.push(body); },
      maxOutOfOrder: MAX_OUT_OF_ORDER,
    });
    const evenConsumer = ReliableDelivery.consumer<number>(kit.system, {
      handler: (body) => { even.push(body); },
      maxOutOfOrder: MAX_OUT_OF_ORDER,
    });
    const oddProducerOptions = ProducerControllerOptions.create<number>()
      .withProducerId('jobs-odd')
      .withConsumer(oddConsumer.ref);
    const oddProducer = ReliableDelivery.producer<number>(kit.system, oddProducerOptions);
    const evenProducerOptions = ProducerControllerOptions.create<number>()
      .withProducerId('jobs-even')
      .withConsumer(evenConsumer.ref);
    const evenProducer = ReliableDelivery.producer<number>(kit.system, evenProducerOptions);

    const confirmed: number[] = [];
    const failed: number[] = [];
    for (let job = 1; job <= 40; job++) {
      const producer = job % 2 === 1 ? oddProducer : evenProducer;
      producer.tell(job, (err) => { (err === null ? confirmed : failed).push(job); });
    }
    await awaitCondition(() => confirmed.length + failed.length === 40, {
      timeoutMs: 4_000,
      label: 'every job was settled by its own producer',
    });

    // Forty of forty, each in order on its own consumer — the same cap of
    // eight that stalled the split stream above never comes into play.
    expect(failed).toEqual([]);
    expect(odd).toEqual(Array.from({ length: 20 }, (_, i) => 2 * i + 1));
    expect(even).toEqual(Array.from({ length: 20 }, (_, i) => 2 * i + 2));

    oddProducer.stop(); evenProducer.stop();
    oddConsumer.stop(); evenConsumer.stop();
    await kit.system.terminate();
  });
});
