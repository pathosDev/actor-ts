/**
 * A producer whose deduplication window the consumer dropped, resuming at the
 * sequence after the last one acknowledged (#1862).
 *
 * `ProducerController.nextSeq` is per producer instance and never restarts, so
 * a producer that goes idle and comes back carries on at N+1.  When the
 * consumer had dropped that producer's window in the meantime — the idle
 * sweep, an LRU eviction, a promotion that demoted its incarnation (#1237),
 * the release of a quiet held incarnation, or a restart of the consumer — the
 * next window started at `contiguous: 0`.  Every delivery from N+1 landed in
 * `above`, seqs 1..N never came again to close the gap, and after
 * `maxOutOfOrder` deliveries the producer was refused for good.
 *
 * The fix is the producer's low-water mark: every delivery carries `floor`,
 * the lowest seq its producer still holds unacknowledged, and the consumer
 * raises the window it admits the delivery into to `floor - 1`.
 *
 * Every case runs on virtual time and with a small `maxOutOfOrder`, so the cap
 * is reached in a handful of deliveries rather than 1024.
 */
import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../src/ActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { ConsumerController, ProducerControllerOptions, ReliableDelivery } from '../../../src/delivery/index.js';
import type { Acknowledgment, ConsumerControllerOptionsType, Delivery } from '../../../src/delivery/index.js';
import type { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const PRODUCER = 'payments';
const LIVE = 'live-incarnation';
/** A second incarnation of the same producer id — a forger, or a restart the consumer holds beside the live one. */
const FORGED = 'forged-incarnation';
const THIRD = 'third-incarnation';
const IDLE_TTL_MS = 10_000;
const MAX_OUT_OF_ORDER = 4;
/** How many sequences the producer had acknowledged before its window was dropped. */
const ACKNOWLEDGED_BEFORE = 3;
/** Comfortably past the out-of-order cap. */
const RESUMED = MAX_OUT_OF_ORDER * 3;

/** A message that is not a delivery and faults the consumer, so its supervisor restarts it. */
type FaultMessage = { readonly kind: 'test.fault' };

/** Throws on {@link FaultMessage} so the default supervisor restarts it, discarding every window. */
class FaultableConsumer extends ConsumerController<string> {
  override onReceive(message: Delivery<string>): void | Promise<void> {
    if ((message as unknown as FaultMessage).kind === 'test.fault') throw new Error('restart the consumer');
    return super.onReceive(message);
  }
}

type Harness = {
  readonly kit: TestKit;
  readonly scheduler: ManualScheduler;
  readonly consumer: ActorRef<Delivery<string>>;
  readonly controller: () => ConsumerController<string>;
  readonly constructions: () => number;
  readonly handled: string[];
  readonly acknowledgments: TestProbe;
  readonly deadLetters: TestProbe;
};

function harness(name: string, options: Partial<ConsumerControllerOptionsType<string>> = {}): Harness {
  const { kit, scheduler } = TestKit.withManualScheduler(
    name,
    TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
  );
  const handled: string[] = [];
  const acknowledgments = kit.createTestProbe();
  const deadLetters = kit.createTestProbe();
  kit.system.eventStream.subscribe(deadLetters, DeadLetter);
  let controller: ConsumerController<string> | null = null;
  let constructions = 0;
  const consumer = kit.system.spawn<Delivery<string>>(() => {
    constructions++;
    controller = new FaultableConsumer({
      handler: (body) => { handled.push(body); },
      producerIdleTtlMs: IDLE_TTL_MS,
      maxOutOfOrder: MAX_OUT_OF_ORDER,
      ...options,
    });
    return controller;
  }, 'consumer');
  return {
    kit,
    scheduler,
    consumer,
    controller: () => {
      if (controller === null) throw new Error('the consumer was never constructed');
      return controller;
    },
    constructions: () => constructions,
    handled,
    acknowledgments,
    deadLetters,
  };
}

function bodyOf(producerId: string, incarnation: string, seq: number): string {
  return `${producerId}/${incarnation}/${seq}`;
}

function deliver(h: Harness, producerId: string, incarnation: string, seq: number, floor: number): void {
  h.consumer.tell({
    kind: 'reliable-delivery.delivery',
    producerId,
    incarnation,
    seq,
    floor,
    body: bodyOf(producerId, incarnation, seq),
    replyTo: h.acknowledgments as never,
  });
}

/**
 * Deliver and wait for the acknowledgment.  `floor` defaults to `seq`: what an
 * honest producer stamps when everything before this seq has been acknowledged.
 */
async function deliverAndAwaitAcknowledgment(
  h: Harness,
  producerId: string,
  incarnation: string,
  seq: number,
  floor: number = seq,
): Promise<void> {
  deliver(h, producerId, incarnation, seq, floor);
  const acknowledgment = await h.acknowledgments.receiveOne(4_000) as Acknowledgment;
  expect(acknowledgment.incarnation).toBe(incarnation);
  expect(acknowledgment.seq).toBe(seq);
}

async function acknowledgeFirstSequences(h: Harness, incarnation: string = LIVE): Promise<void> {
  for (let seq = 1; seq <= ACKNOWLEDGED_BEFORE; seq++) {
    await deliverAndAwaitAcknowledgment(h, PRODUCER, incarnation, seq);
  }
}

/** The producer resumes at N+1, and every delivery must be handled and acknowledged. */
async function expectResumedStreamDelivered(h: Harness, incarnation: string = LIVE): Promise<void> {
  const expected: string[] = [];
  for (let seq = ACKNOWLEDGED_BEFORE + 1; seq <= ACKNOWLEDGED_BEFORE + RESUMED; seq++) {
    await deliverAndAwaitAcknowledgment(h, PRODUCER, incarnation, seq);
    expected.push(bodyOf(PRODUCER, incarnation, seq));
  }
  expect(h.handled.slice(-RESUMED)).toEqual(expected);
}

describe('ConsumerController — a producer resuming after its window was dropped (#1862)', () => {
  test('after the idle sweep, the resumed stream is delivered past maxOutOfOrder', async () => {
    const h = harness('window-reset-sweep');
    await acknowledgeFirstSequences(h);

    h.scheduler.advance(IDLE_TTL_MS);
    expect(h.controller().trackedProducers).toBe(0);

    await expectResumedStreamDelivered(h);
    expect(h.controller().outOfOrderFor(PRODUCER)).toBe(0);
    await h.kit.system.terminate();
  });

  test('after an LRU eviction, the resumed stream is delivered past maxOutOfOrder', async () => {
    const h = harness('window-reset-eviction', { maxProducers: 1 });
    await acknowledgeFirstSequences(h);

    await deliverAndAwaitAcknowledgment(h, 'another-producer', 'other-incarnation', 1);
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(0);

    await expectResumedStreamDelivered(h);
    expect(h.controller().outOfOrderFor(PRODUCER)).toBe(0);
    await h.kit.system.terminate();
  });

  test('after another incarnation was promoted over it, the resumed stream is delivered past maxOutOfOrder', async () => {
    const h = harness('window-reset-promotion');
    await acknowledgeFirstSequences(h);

    // A second incarnation keeps the entry fresh while the live one is quiet,
    // so the sweep spares the entry and the next delivery promotes it.
    h.scheduler.advance(IDLE_TTL_MS / 2);
    await deliverAndAwaitAcknowledgment(h, PRODUCER, FORGED, 1);
    h.scheduler.advance(IDLE_TTL_MS / 2);
    await deliverAndAwaitAcknowledgment(h, PRODUCER, FORGED, 2);
    expect(h.controller().trackedProducers).toBe(1);

    // The live producer comes back from its idle spell at N+1, into a held window.
    await expectResumedStreamDelivered(h);
    await h.kit.system.terminate();
  });

  test('after a quiet held incarnation was released, its resumed stream is delivered past maxOutOfOrder', async () => {
    const h = harness('window-reset-released-held');
    await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, 1);
    // A second incarnation, held beside the live one, acknowledges 1..N and goes quiet.
    await acknowledgeFirstSequences(h, FORGED);
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(2);

    // The live one keeps talking, so nothing is promoted and the entry is not swept.
    h.scheduler.advance(IDLE_TTL_MS / 2);
    await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, 2);
    h.scheduler.advance(IDLE_TTL_MS / 2);
    await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, 3);

    // A third incarnation arriving releases the quiet held one on the way in.
    await deliverAndAwaitAcknowledgment(h, PRODUCER, THIRD, 1);
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(2);

    await expectResumedStreamDelivered(h, FORGED);
    await h.kit.system.terminate();
  });

  test('after the consumer restarted, the resumed stream is delivered past maxOutOfOrder', async () => {
    const h = harness('window-reset-consumer-restart');
    await acknowledgeFirstSequences(h);

    h.consumer.tell({ kind: 'test.fault' } as never);
    await awaitCondition(() => h.constructions() === 2, {
      timeoutMs: 4_000,
      label: 'the supervisor restarted the consumer',
    });
    expect(h.controller().trackedProducers).toBe(0);

    await expectResumedStreamDelivered(h);
    expect(h.controller().outOfOrderFor(PRODUCER)).toBe(0);
    await h.kit.system.terminate();
  });
});

describe('ConsumerController — what a floor may not do (#1862)', () => {
  test('a floor under an unknown incarnation moves only that incarnation\'s held window, never the live one', async () => {
    const h = harness('floor-forged-incarnation');
    await acknowledgeFirstSequences(h);

    // A forger naming the live producer under an invented incarnation, with a
    // floor far above the live high-water mark.
    await deliverAndAwaitAcknowledgment(h, PRODUCER, FORGED, 1_000, 1_000);
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(2);

    // The live producer still has 4..10 in flight; 10 arrives first.  Had the
    // forged floor reached the live window, 4..9 would be absorbed as
    // duplicates without the handler running.
    await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, 10, 4);
    expect(h.controller().outOfOrderFor(PRODUCER)).toBe(1);
    for (let seq = 4; seq <= 9; seq++) await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, seq, 4);

    expect(h.handled.filter((body) => body.includes(LIVE))).toEqual(
      [1, 2, 3, 10, 4, 5, 6, 7, 8, 9].map((seq) => bodyOf(PRODUCER, LIVE, seq)),
    );
    expect(h.controller().outOfOrderFor(PRODUCER)).toBe(0);
    await h.kit.system.terminate();
  });

  test('a floor above its own seq, or one that is not a positive integer, is a malformed delivery', async () => {
    const h = harness('floor-malformed');
    await acknowledgeFirstSequences(h);

    for (const floor of [5, 0, -1, 1.5, Number.NaN, '4' as unknown as number]) {
      deliver(h, PRODUCER, LIVE, 4, floor);
      const letter = await h.deadLetters.receiveOne(4_000) as DeadLetter;
      expect((letter.message as Delivery<string>).floor).toBe(floor);
    }
    await h.acknowledgments.expectNoMessage(50);
    expect(h.handled).toHaveLength(ACKNOWLEDGED_BEFORE);

    // The same seq with an honest floor is still handled.
    await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, 4);
    expect(h.handled.at(-1)).toBe(bodyOf(PRODUCER, LIVE, 4));
    await h.kit.system.terminate();
  });

  test('a raised floor releases retained seqs at or below it and slides over the ones just above', async () => {
    const h = harness('floor-releases-retained');
    await acknowledgeFirstSequences(h);

    // 4 is outstanding, so 5 and 6 are retained out of order.
    await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, 5, 4);
    await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, 6, 4);
    expect(h.controller().outOfOrderFor(PRODUCER)).toBe(2);

    // The producer now holds nothing below 6 (4 and 5 acknowledged, 6's
    // acknowledgment still on its way), so 8 carries floor 6: 5 is released,
    // 6 slides, and only 8 is retained.
    await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, 8, 6);
    expect(h.controller().outOfOrderFor(PRODUCER)).toBe(1);

    await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, 7, 6);
    expect(h.controller().outOfOrderFor(PRODUCER)).toBe(0);
    expect(h.handled.slice(ACKNOWLEDGED_BEFORE)).toEqual([5, 6, 8, 7].map((seq) => bodyOf(PRODUCER, LIVE, seq)));
    await h.kit.system.terminate();
  });

  test('a delivery without a floor counts as floor 1, the behaviour before the field', async () => {
    const h = harness('floor-absent');
    await acknowledgeFirstSequences(h);
    h.scheduler.advance(IDLE_TTL_MS);

    h.consumer.tell({
      kind: 'reliable-delivery.delivery',
      producerId: PRODUCER,
      incarnation: LIVE,
      seq: ACKNOWLEDGED_BEFORE + 1,
      body: bodyOf(PRODUCER, LIVE, ACKNOWLEDGED_BEFORE + 1),
      replyTo: h.acknowledgments as never,
    } as never);
    const acknowledgment = await h.acknowledgments.receiveOne(4_000) as Acknowledgment;
    expect(acknowledgment.seq).toBe(ACKNOWLEDGED_BEFORE + 1);
    // Admitted out of order into a window waiting at 0, exactly as before.
    expect(h.controller().outOfOrderFor(PRODUCER)).toBe(1);
    await h.kit.system.terminate();
  });

  test('after a drop, out-of-order first arrivals at and above the floor all reach the handler', async () => {
    const h = harness('floor-no-skip');
    await acknowledgeFirstSequences(h);
    h.scheduler.advance(IDLE_TTL_MS);
    expect(h.controller().trackedProducers).toBe(0);

    // 4, 5 and 6 are all in flight, so every one of them carries floor 4, and
    // they arrive highest first.  Adopting the first seq seen as the base
    // would absorb 4 and 5 as duplicates.
    for (const seq of [6, 5, 4]) await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, seq, 4);

    expect(h.handled.slice(ACKNOWLEDGED_BEFORE)).toEqual([6, 5, 4].map((seq) => bodyOf(PRODUCER, LIVE, seq)));
    expect(h.controller().outOfOrderFor(PRODUCER)).toBe(0);

    // And each is now a duplicate: a retransmit re-acknowledges without the handler.
    await deliverAndAwaitAcknowledgment(h, PRODUCER, LIVE, 5, 4);
    expect(h.handled).toHaveLength(ACKNOWLEDGED_BEFORE + 3);
    await h.kit.system.terminate();
  });
});

describe('ProducerController and ConsumerController — the floor end to end (#1862)', () => {
  test('a producer resuming after the sweep, with its first transmission lost, delivers every message once', async () => {
    const resendTimeoutMs = 1_000;
    const { kit, scheduler } = TestKit.withManualScheduler(
      'floor-end-to-end',
      TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off),
    );
    const handled: string[] = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (body) => { handled.push(body); },
      producerIdleTtlMs: IDLE_TTL_MS,
      maxOutOfOrder: MAX_OUT_OF_ORDER,
    });
    const floors: Array<readonly [number, number]> = [];
    let dropped = false;
    const lossyLink = {
      tell(delivery: Delivery<string>): void {
        floors.push([delivery.seq, delivery.floor]);
        // The first transmission of the first seq after the sweep is lost, so
        // everything above it arrives ahead of it.
        if (delivery.seq === ACKNOWLEDGED_BEFORE + 1 && !dropped) {
          dropped = true;
          return;
        }
        consumer.ref.tell(delivery);
      },
    };
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(lossyLink as never)
      .withProducerId(PRODUCER)
      .withResendTimeout(resendTimeoutMs)
      .withWindowSize(RESUMED);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);

    const settled: Array<string | null> = [];
    const send = (body: string): void => {
      producer.tell(body, (err) => { settled.push(err === null ? null : err.message); });
    };
    for (let index = 1; index <= ACKNOWLEDGED_BEFORE; index++) send(`m${index}`);
    await awaitCondition(() => settled.length === ACKNOWLEDGED_BEFORE, {
      timeoutMs: 4_000,
      label: 'the first sends were confirmed',
    });
    // Each first send went out before any acknowledgment came back, so all carry floor 1.
    expect(floors).toEqual([[1, 1], [2, 1], [3, 1]]);

    scheduler.advance(IDLE_TTL_MS);
    for (let index = ACKNOWLEDGED_BEFORE + 1; index <= ACKNOWLEDGED_BEFORE + RESUMED; index++) send(`m${index}`);
    await awaitCondition(() => floors.length >= ACKNOWLEDGED_BEFORE + RESUMED, {
      timeoutMs: 4_000,
      label: 'every resumed send went out once',
    });
    // The lowest unacknowledged seq is the lost one, so it is every resumed send's floor.
    expect(floors.slice(ACKNOWLEDGED_BEFORE).every(([, floor]) => floor === ACKNOWLEDGED_BEFORE + 1)).toBe(true);

    // Retransmits close the gap and then re-send what the cap refused.  Every
    // round has to confirm something, or the producer is stalled.
    while (settled.length < ACKNOWLEDGED_BEFORE + RESUMED) {
      const before = settled.length;
      scheduler.advance(resendTimeoutMs);
      await awaitCondition(() => settled.length > before, {
        timeoutMs: 4_000,
        label: 'a resend round confirmed at least one more send',
      });
    }

    expect(settled.every((outcome) => outcome === null)).toBe(true);
    expect([...handled].sort()).toEqual(
      Array.from({ length: ACKNOWLEDGED_BEFORE + RESUMED }, (_, index) => `m${index + 1}`).sort(),
    );
    producer.stop();
    consumer.stop();
    await kit.system.terminate();
  });
});
