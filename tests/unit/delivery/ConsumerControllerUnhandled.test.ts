/**
 * A `ConsumerController` handed a message that is not a delivery.
 *
 * Its `onReceive` returned on any kind but `reliable-delivery.delivery` and
 * said nothing about it: no dead letter, no `actor_unhandled_total`, no log
 * line.  The consumer's ref is not private — every producer delivering here
 * holds it, a handler can pass it on, and a controller under `/user` is
 * addressable from a cluster peer — so whatever reached it and was not a
 * delivery vanished without a trace.  The first message work-pulling needs
 * (#1470) travels between the two controllers, and a consumer that predates it
 * would have swallowed every one in silence.
 *
 * Declining is the fix, and it is the producer's (see
 * `ProducerControllerUnhandled.test.ts`) applied to this side: the message
 * becomes a dead letter naming the consumer, `actor_unhandled_total{class}`
 * counts it, a warning says so at most once a minute however many arrive, and
 * the deduplication state and the handler are untouched.
 */
import { describe, expect, test } from 'bun:test';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { MetricsRegistry } from '../../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { ReliableDelivery } from '../../../src/delivery/index.js';
import type { Acknowledgment, Delivery } from '../../../src/delivery/index.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../src/testkit/TestProbe.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/** A demand signal, as a work-pulling producer would send one — a kind no consumer here knows. */
const DEMAND = { kind: 'reliable-delivery.request', demand: 4 } as const;

/**
 * The interval the warning is paced by — `UNHANDLED_REPORT_INTERVAL_MS` in
 * `src/delivery/Constants.ts`, restated so the pacing case pins the value and
 * not only the shape: virtual time makes the minute free to cross.
 */
const REPORT_INTERVAL_MS = 60_000;

const quietOptions = (): TestKitOptions => TestKitOptions.create()
  .withLogger(new NoopLogger())
  .withLogLevel(LogLevel.Off);

/** The decline warnings among everything the system logger was told. */
const declineWarnings = (logger: RecordingLogger): string[] => logger.records
  .filter((record) => record.level === 'warn' && record.message.startsWith('consumer declined'))
  .map((record) => record.message);

/** `actor_unhandled_total` for one actor class, summed over its series. */
const unhandledCount = (registry: MetricsRegistry, className: string): number => registry.collect()
  .filter((sample) => sample.name === 'actor_unhandled_total' && sample.labels['class'] === className)
  .reduce((total, sample) => total + sample.value, 0);

/**
 * The next dead letter carrying `message`, skipping any other.
 *
 * The dead-letter stream is shared by the whole system, so the letter is
 * found by what it carries rather than by arriving first.
 */
async function letterCarrying(deadLetters: TestProbe, message: unknown): Promise<DeadLetter> {
  for (;;) {
    const letter = await deadLetters.receiveOne(4_000) as DeadLetter;
    if (JSON.stringify(letter.message) === JSON.stringify(message)) return letter;
  }
}

/** One delivery from a single producer, acknowledged to `replyTo`. */
const deliver = (consumer: ActorRef<Delivery<unknown>>, replyTo: TestProbe, seq: number, body: string): void => {
  consumer.tell({
    kind: 'reliable-delivery.delivery',
    producerId: 'stray-neighbour',
    incarnation: 'incarnation-1',
    seq,
    body,
    replyTo: replyTo as never,
  });
};

describe('ConsumerController — a message that is not a delivery', () => {
  test('it becomes a dead letter naming the consumer, and actor_unhandled_total counts it', async () => {
    const kit = TestKit.create('consumer-unhandled-letter', quietOptions());
    const registry = kit.system.extension(MetricsExtensionId).enable();
    const deadLetters = kit.createTestProbe();
    kit.system.eventStream.subscribe(deadLetters, DeadLetter);
    const consumer = ReliableDelivery.consumer<string>(kit.system, { handler: () => {} });

    consumer.ref.tell(DEMAND as never);
    const letter = await letterCarrying(deadLetters, DEMAND);

    // The consumer is named as the recipient — the actor that declined it —
    // and not the dead-letter office, which would say nothing about who.
    expect(letter.recipient.path.toString()).toBe(consumer.ref.path.toString());
    // Counted before the letter was published, so it is already there.
    expect(unhandledCount(registry, 'ConsumerController')).toBe(1);

    consumer.stop();
    await kit.system.terminate();
  });

  test('one between two deliveries of a producer leaves its window and its handler alone', async () => {
    const kit = TestKit.create('consumer-unhandled-window', quietOptions());
    const handled: string[] = [];
    const acknowledgments = kit.createTestProbe();
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (body) => { handled.push(body); },
    });

    deliver(consumer.ref, acknowledgments, 1, 'one');
    // Two strays in the same mailbox: a kind this consumer has no arm for, and
    // a `null`, which used to reach `message.kind` and throw.  A throw is a
    // supervised fault, and the restart behind it discards every producer's
    // deduplication window — the one thing a decline must not cost.
    consumer.ref.tell(DEMAND as never);
    consumer.ref.tell(null as never);
    // seq 1 again is a duplicate only if the window survived both strays: it
    // is acknowledged and not handled.  A consumer that lost the window runs
    // the handler a second time, and one that died acknowledges nothing.
    deliver(consumer.ref, acknowledgments, 1, 'one-again');
    deliver(consumer.ref, acknowledgments, 2, 'two');

    const acknowledged = await acknowledgments.receiveN(3, 4_000) as Acknowledgment[];
    expect(acknowledged.map((acknowledgment) => acknowledgment.seq)).toEqual([1, 1, 2]);
    expect(handled).toEqual(['one', 'two']);

    consumer.stop();
    await kit.system.terminate();
  });

  test('the warning is paced: a flood is named once, carries nothing the sender wrote, and the next line counts what it folded', async () => {
    // Virtual time, read through `system.clock` — the pacing is a statement
    // about a minute, and only a clock the test can move makes the far edge
    // of that minute reachable without holding the test still for it.
    const logger = new RecordingLogger();
    const { kit, scheduler } = TestKit.withManualScheduler(
      'consumer-unhandled-paced',
      TestKitOptions.create().withLogger(logger),
    );
    const deadLetters = kit.createTestProbe();
    kit.system.eventStream.subscribe(deadLetters, DeadLetter);
    const consumer = ReliableDelivery.consumer<string>(kit.system, { handler: () => {} });
    const declineOne = async (): Promise<void> => {
      consumer.ref.tell(DEMAND as never);
      await letterCarrying(deadLetters, DEMAND);
    };

    // At virtual time 0.  A pacer whose "never reported" sentinel is 0 would
    // swallow this first line on a clock that starts there.
    for (let i = 0; i < 5; i++) await declineOne();
    expect(declineWarnings(logger)).toHaveLength(1);
    expect(declineWarnings(logger)[0]).toContain('consumer declined 1 message that was not a delivery');
    // The kind is the sender's text, and nothing bounds its length — the
    // letter carries it for whoever subscribes; the log line does not.
    expect(declineWarnings(logger)[0]).not.toContain(DEMAND.kind);

    // One millisecond short of the interval: still folded.
    scheduler.advance(REPORT_INTERVAL_MS - 1);
    await declineOne();
    expect(declineWarnings(logger)).toHaveLength(1);

    // At the interval: reported, carrying the five folded since plus itself.
    scheduler.advance(1);
    await declineOne();
    const warnings = declineWarnings(logger);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('consumer declined 6 messages that were not a delivery');

    consumer.stop();
    await kit.system.terminate();
  });
});
