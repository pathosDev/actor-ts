/**
 * A `ProducerController` handed a message it has no arm for (#1470).
 *
 * The producer's ref is not private: every delivery carries it as `replyTo`,
 * so the consumer, any handler that forwards a delivery on, and — for a
 * controller under `/user` — a cluster peer can all tell it something.  Its
 * `onReceive` used to end in `.exhaustive()`, so one message of a kind it did
 * not know threw, the supervisor restarted it, and the restart settled every
 * send in flight and every send still queued with `producer stopped` before
 * minting a new incarnation that knew nothing of them.  One stray tell cost
 * the whole window.  The first message a work-pulling consumer would need —
 * a demand signal back to its producer — is exactly such a message, which
 * made a mixed-version deployment of #1470 a way to do it on every request.
 *
 * Declining is the fix: the message becomes a dead letter naming the
 * producer, `actor_unhandled_total{class}` counts it, a warning says so at
 * most once a minute however many arrive, and the window is untouched.
 */
import { describe, expect, test } from 'bun:test';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { ProducerControllerOptions, ReliableDelivery } from '../../../src/delivery/index.js';
import type { Delivery } from '../../../src/delivery/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import type { TestProbe } from '../../../src/testkit/TestProbe.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/** A demand signal, as a work-pulling consumer would send one — a kind no producer here knows. */
const DEMAND = { kind: 'reliable-delivery.request', demand: 4 } as const;

/**
 * The interval the warning is paced by — `UNHANDLED_REPORT_INTERVAL_MS` in
 * `ProducerController.ts`, restated so the pacing case pins the value and
 * not only the shape: virtual time makes the minute free to cross.
 */
const REPORT_INTERVAL_MS = 60_000;

/** The decline warnings among everything the system logger was told. */
const declineWarnings = (logger: RecordingLogger): string[] => logger.records
  .filter((record) => record.level === 'warn' && record.message.startsWith('producer declined'))
  .map((record) => record.message);

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

describe('ProducerController — a message it has no arm for (#1470)', () => {
  test('one message of an unknown kind leaves every in-flight and queued send where it was', async () => {
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('producer-unhandled-window', kitOptions);
    const settled: Array<readonly [string, string | null]> = [];

    // Nothing acknowledges on its own, so the test decides what the producer
    // hears and in which order.  A window of two puts `a` and `b` in flight
    // and queues `c` behind them — both collections a restart used to empty.
    const neverAcknowledges = kit.createTestProbe();
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(neverAcknowledges as never)
      .withResendTimeout(10_000)
      .withWindowSize(2);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);
    for (const job of ['a', 'b', 'c']) {
      producer.tell(job, (err) => { settled.push([job, err === null ? null : err.message]); });
    }
    const first = await neverAcknowledges.receiveOne(4_000) as Delivery<string>;
    const second = await neverAcknowledges.receiveOne(4_000) as Delivery<string>;
    expect([first.body, second.body]).toEqual(['a', 'b']);

    // The stray message, and right behind it in the same mailbox a genuine
    // acknowledgment of `a` echoing the incarnation `a` was sent under.  The
    // order is the point: the acknowledgment can only settle `a` if the
    // producer that receives it is still the one that sent it.
    producer.ref.tell(DEMAND as never);
    first.replyTo.tell({
      kind: 'reliable-delivery.ack',
      producerId: first.producerId,
      incarnation: first.incarnation,
      seq: first.seq,
    });
    await awaitCondition(() => settled.length > 0, {
      timeoutMs: 4_000,
      label: 'the first send was settled',
    });
    // Settled by the acknowledgment and by nothing else: `b` is still in
    // flight and `c` still queued, neither of them told anything.
    expect(settled).toEqual([['a', null]]);

    // `c` moves into the slot `a` freed, numbered on from the same counter
    // under the same incarnation — a restart would have minted a new token
    // and started again at seq 1.
    const third = await neverAcknowledges.receiveOne(4_000) as Delivery<string>;
    expect(third.body).toBe('c');
    expect(third.seq).toBe(3);
    expect(third.incarnation).toBe(first.incarnation);

    producer.stop();
    await kit.system.terminate();
  });

  test('a send whose confirm is not a function is declined as well, before it can enter the window', async () => {
    // A send is the other way into this actor, and `confirm` is the one field
    // the producer calls.  A cluster peer can only send JSON, so a `confirm`
    // it supplies is a string at best — and admitted, that send sat in the
    // window until its acknowledgment made the producer call the string,
    // which faulted it into the same restart as an unknown kind.
    const kitOptions = TestKitOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const kit = TestKit.create('producer-unhandled-confirm-shape', kitOptions);
    const deadLetters = kit.createTestProbe();
    kit.system.eventStream.subscribe(deadLetters, DeadLetter);
    const settled: Array<readonly [string, string | null]> = [];
    const neverAcknowledges = kit.createTestProbe();
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(neverAcknowledges as never)
      .withResendTimeout(10_000)
      .withWindowSize(4);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);
    const stringConfirm = { kind: 'reliable-delivery.send', body: 'string-confirm', confirm: 'not-a-function' };
    const objectConfirm = { kind: 'reliable-delivery.send', body: 'object-confirm', confirm: { call: 'x' } };
    // `null` is what a JSON sender writes for "no callback", and the optional
    // call skips it — this one is a send like any other.
    const nullConfirm = { kind: 'reliable-delivery.send', body: 'null-confirm', confirm: null };

    producer.tell('before', (err) => { settled.push(['before', err === null ? null : err.message]); });
    producer.ref.tell(stringConfirm as never);
    producer.ref.tell(objectConfirm as never);
    producer.ref.tell(nullConfirm as never);
    producer.tell('after', (err) => { settled.push(['after', err === null ? null : err.message]); });

    // Neither malformed send becomes a delivery: the three acceptable ones
    // take seq 1 to 3 between them.
    const deliveries: Delivery<string>[] = [];
    for (let i = 0; i < 3; i++) deliveries.push(await neverAcknowledges.receiveOne(4_000) as Delivery<string>);
    expect(deliveries.map((delivery) => delivery.body)).toEqual(['before', 'null-confirm', 'after']);
    expect(deliveries.map((delivery) => delivery.seq)).toEqual([1, 2, 3]);
    for (const malformed of [stringConfirm, objectConfirm]) {
      const letter = await letterCarrying(deadLetters, malformed);
      expect(letter.recipient.path.toString()).toBe(producer.ref.path.toString());
    }

    // And the well-formed ones still settle normally, under the incarnation
    // that sent them.
    for (const delivery of deliveries) {
      delivery.replyTo.tell({
        kind: 'reliable-delivery.ack',
        producerId: delivery.producerId,
        incarnation: delivery.incarnation,
        seq: delivery.seq,
      });
    }
    await awaitCondition(() => settled.length === 2, {
      timeoutMs: 4_000,
      label: 'both well-formed sends were settled',
    });
    expect(settled).toEqual([['before', null], ['after', null]]);

    producer.stop();
    await kit.system.terminate();
  });

  test('the declined message becomes a dead letter naming the producer, and a warning says so', async () => {
    const logger = new RecordingLogger();
    const kit = TestKit.create('producer-unhandled-letter', TestKitOptions.create().withLogger(logger));
    const deadLetters = kit.createTestProbe();
    kit.system.eventStream.subscribe(deadLetters, DeadLetter);
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(kit.createTestProbe() as never);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);

    producer.ref.tell(DEMAND as never);
    const letter = await letterCarrying(deadLetters, DEMAND);

    // The producer is named as the recipient — the actor that declined it —
    // and not the dead-letter office, which would say nothing about who.
    expect(letter.recipient.path.toString()).toBe(producer.ref.path.toString());
    // Written in the same turn that published the letter, so it is already there.
    const warnings = declineWarnings(logger);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('producer declined 1 message it could not act on');
    // The kind is the sender's text, and length is not even checked on it —
    // the letter carries it for whoever subscribes; the log line does not.
    expect(warnings[0]).not.toContain(DEMAND.kind);

    producer.stop();
    await kit.system.terminate();
  });

  test('the warning is paced: a flood is named once, and the next line carries what it folded', async () => {
    // Virtual time, read through `system.clock` — the pacing is a statement
    // about a minute, and only a clock the test can move makes the far edge
    // of that minute reachable without holding the test still for it.
    const logger = new RecordingLogger();
    const { kit, scheduler } = TestKit.withManualScheduler(
      'producer-unhandled-paced',
      TestKitOptions.create().withLogger(logger),
    );
    const deadLetters = kit.createTestProbe();
    kit.system.eventStream.subscribe(deadLetters, DeadLetter);
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(kit.createTestProbe() as never);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);
    const declineOne = async (): Promise<void> => {
      producer.ref.tell(DEMAND as never);
      await letterCarrying(deadLetters, DEMAND);
    };

    // At virtual time 0.  A pacer whose "never reported" sentinel is 0 would
    // swallow this first line on a clock that starts there.
    for (let i = 0; i < 5; i++) await declineOne();
    expect(declineWarnings(logger)).toHaveLength(1);
    expect(declineWarnings(logger)[0]).toContain('producer declined 1 message it could not act on');

    // One millisecond short of the interval: still folded.
    scheduler.advance(REPORT_INTERVAL_MS - 1);
    await declineOne();
    expect(declineWarnings(logger)).toHaveLength(1);

    // At the interval: reported, carrying the five folded since plus itself.
    scheduler.advance(1);
    await declineOne();
    const warnings = declineWarnings(logger);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('producer declined 6 messages it could not act on');

    producer.stop();
    await kit.system.terminate();
  });
});
