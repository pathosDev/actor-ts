/**
 * A delivery naming a live producer under an incarnation the consumer has not
 * seen (#1237).
 *
 * The consumer used to *replace* a producer's deduplication window whenever a
 * delivery arrived under a different incarnation.  Nothing on a `Delivery`
 * binds it to the producer it names, so one envelope from anybody who can
 * reach the consumer emptied a live producer's window, and that producer's
 * next retransmit of a sequence the handler had already run ran it again.
 *
 * The fix holds the old and the new incarnation side by side, each
 * deduplicated in its own window, and promotes the new one — dropping the old
 * window — only once the old one has gone quiet for `producerIdleTtlMs`: the
 * same evidence the idle sweep already takes as "this producer is gone".  The
 * number held per producer is bounded by `maxIncarnationsPerProducer`, and a
 * delivery under one incarnation too many is refused as a dead letter, without
 * a handler call or an acknowledgment, so its producer retransmits it.
 *
 * Every case runs on virtual time: "gone quiet for the idle TTL" is a
 * statement about minutes, and `system.clock` under a `ManualScheduler` is
 * what makes the far edge reachable without holding the test still.
 */
import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../src/ActorRef.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { ConsumerController } from '../../../src/delivery/index.js';
import type { Acknowledgment, ConsumerControllerOptionsType, Delivery } from '../../../src/delivery/index.js';
import type { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../src/testkit/TestProbe.js';

/** The producer every case is about, and the incarnation it is really running. */
const PRODUCER = 'payments';
const LIVE = 'live-incarnation';
/** An incarnation nobody is running — what a forged envelope carries. */
const FORGED = 'forged-incarnation';
/** A short idle TTL, so "gone quiet" is a few virtual seconds. */
const IDLE_TTL_MS = 10_000;

type Harness = {
  readonly kit: TestKit;
  readonly scheduler: ManualScheduler;
  readonly consumer: ActorRef<Delivery<string>>;
  readonly controller: () => ConsumerController<string>;
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
  const consumer = kit.system.spawn<Delivery<string>>(() => {
    controller = new ConsumerController<string>({
      handler: (body) => { handled.push(body); },
      producerIdleTtlMs: IDLE_TTL_MS,
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
    handled,
    acknowledgments,
    deadLetters,
  };
}

/** One delivery under `incarnation`, acknowledged to the harness's probe. */
function deliver(h: Harness, incarnation: string, seq: number, body: string): void {
  h.consumer.tell({
    kind: 'reliable-delivery.delivery',
    producerId: PRODUCER,
    incarnation,
    seq,
    body,
    replyTo: h.acknowledgments as never,
  });
}

/** Deliver, and wait for the acknowledgment — which follows the handler, when it runs. */
async function deliverAndAwaitAcknowledgment(
  h: Harness,
  incarnation: string,
  seq: number,
  body: string,
): Promise<void> {
  deliver(h, incarnation, seq, body);
  const acknowledgment = await h.acknowledgments.receiveOne(4_000) as Acknowledgment;
  expect(acknowledgment.incarnation).toBe(incarnation);
  expect(acknowledgment.seq).toBe(seq);
}

describe('ConsumerController — an unrecognised incarnation for a live producer (#1237)', () => {
  test('a forged incarnation does not reset the live window: a retransmit of a handled seq stays a duplicate', async () => {
    const h = harness('incarnation-forged');

    await deliverAndAwaitAcknowledgment(h, LIVE, 1, 'live-1');
    await deliverAndAwaitAcknowledgment(h, LIVE, 2, 'live-2');
    await deliverAndAwaitAcknowledgment(h, LIVE, 3, 'live-3');

    // One forged envelope before every honest retransmit — the shape that
    // kept the window empty for as long as the sender cared to.
    for (const seq of [1, 2, 3]) {
      await deliverAndAwaitAcknowledgment(h, FORGED, seq, `forged-${seq}`);
      await deliverAndAwaitAcknowledgment(h, LIVE, seq, `live-${seq}-again`);
    }
    // The live stream carries on from where its high-water mark is.
    await deliverAndAwaitAcknowledgment(h, LIVE, 4, 'live-4');

    // Every honest retransmit took the duplicate branch: acknowledged, never
    // handled again.  The forged sequences ran once each, in a window of
    // their own — they are new messages as far as anyone can tell.
    expect(h.handled).toEqual(['live-1', 'live-2', 'live-3', 'forged-1', 'forged-2', 'forged-3', 'live-4']);
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(2);

    await h.kit.system.terminate();
  });

  test('the held incarnation is deduplicated in its own window', async () => {
    const h = harness('incarnation-held-window');

    await deliverAndAwaitAcknowledgment(h, LIVE, 1, 'live-1');
    await deliverAndAwaitAcknowledgment(h, FORGED, 1, 'held-1');
    await deliverAndAwaitAcknowledgment(h, FORGED, 1, 'held-1-again');
    await deliverAndAwaitAcknowledgment(h, FORGED, 2, 'held-2');

    expect(h.handled).toEqual(['live-1', 'held-1', 'held-2']);

    await h.kit.system.terminate();
  });

  test('a held incarnation is not promoted while the live one keeps talking', async () => {
    const h = harness('incarnation-not-promoted');

    await deliverAndAwaitAcknowledgment(h, LIVE, 1, 'live-1');
    // Well past the idle TTL in total, but never a TTL's worth of silence
    // from the live incarnation.
    for (let round = 0; round < 5; round++) {
      h.scheduler.advance(IDLE_TTL_MS / 2);
      await deliverAndAwaitAcknowledgment(h, FORGED, round + 1, `forged-${round + 1}`);
      await deliverAndAwaitAcknowledgment(h, LIVE, 1, 'live-1-again');
    }

    expect(h.handled).toEqual(['live-1', 'forged-1', 'forged-2', 'forged-3', 'forged-4', 'forged-5']);
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(2);

    await h.kit.system.terminate();
  });

  test('a real restart converges: the new incarnation is promoted, with its window, once the old one has gone quiet', async () => {
    const h = harness('incarnation-restart');
    const RESTARTED = 'restarted-incarnation';

    await deliverAndAwaitAcknowledgment(h, LIVE, 1, 'old-1');
    await deliverAndAwaitAcknowledgment(h, LIVE, 2, 'old-2');
    // The producer restarts: its new incarnation is handled at once, held
    // beside the old one rather than replacing it.
    await deliverAndAwaitAcknowledgment(h, RESTARTED, 1, 'new-1');
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(2);

    // Not yet: the old incarnation has been quiet for less than the TTL.
    h.scheduler.advance(IDLE_TTL_MS - 1);
    await deliverAndAwaitAcknowledgment(h, RESTARTED, 2, 'new-2');
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(2);

    // Now it has: the next delivery of the new incarnation promotes it, and
    // the old window is dropped.
    h.scheduler.advance(1);
    await deliverAndAwaitAcknowledgment(h, RESTARTED, 3, 'new-3');
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(1);

    // Promotion carried the new incarnation's own window across: a retransmit
    // of a sequence it had already delivered is still a duplicate.
    await deliverAndAwaitAcknowledgment(h, RESTARTED, 2, 'new-2-again');
    expect(h.handled).toEqual(['old-1', 'old-2', 'new-1', 'new-2', 'new-3']);

    await h.kit.system.terminate();
  });

  test('past maxIncarnationsPerProducer a new incarnation is refused as a dead letter, and admitted once a held one goes quiet', async () => {
    const h = harness('incarnation-bound', { maxIncarnationsPerProducer: 2 });
    const THIRD = 'third-incarnation';

    await deliverAndAwaitAcknowledgment(h, LIVE, 1, 'live-1');
    await deliverAndAwaitAcknowledgment(h, FORGED, 1, 'forged-1');

    // One incarnation too many: no handler call, no acknowledgment, and the
    // envelope goes to the dead-letter office naming this consumer.
    deliver(h, THIRD, 1, 'third-1');
    const letter = await h.deadLetters.receiveOne(4_000) as DeadLetter;
    expect((letter.message as Delivery<string>).incarnation).toBe(THIRD);
    expect(letter.recipient.path.toString()).toBe(h.consumer.path.toString());
    await h.acknowledgments.expectNoMessage(50);
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(2);

    // The live incarnation keeps talking; the held one goes quiet for the
    // TTL and its slot is released, so the producer's retransmit gets in.
    // Sent half-way and at the end, so the sweep never finds the whole
    // entry idle.
    h.scheduler.advance(IDLE_TTL_MS / 2);
    await deliverAndAwaitAcknowledgment(h, LIVE, 2, 'live-2');
    h.scheduler.advance(IDLE_TTL_MS / 2);
    await deliverAndAwaitAcknowledgment(h, LIVE, 3, 'live-3');
    await deliverAndAwaitAcknowledgment(h, THIRD, 1, 'third-1');

    expect(h.handled).toEqual(['live-1', 'forged-1', 'live-2', 'live-3', 'third-1']);
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(2);

    await h.kit.system.terminate();
  });

  test('maxIncarnationsPerProducer defaults to 4, the live incarnation included', async () => {
    const h = harness('incarnation-default-bound');

    await deliverAndAwaitAcknowledgment(h, LIVE, 1, 'live-1');
    for (let i = 1; i <= 3; i++) await deliverAndAwaitAcknowledgment(h, `held-${i}`, 1, `held-${i}`);
    expect(h.controller().incarnationsHeldFor(PRODUCER)).toBe(4);

    deliver(h, 'held-4', 1, 'refused');
    const letter = await h.deadLetters.receiveOne(4_000) as DeadLetter;
    expect((letter.message as Delivery<string>).incarnation).toBe('held-4');
    expect(h.handled).not.toContain('refused');

    await h.kit.system.terminate();
  });
});
