/**
 * A `confirm` callback that throws (#1230).
 *
 * `confirm` is the caller's code, and the producer calls it on two paths, both
 * on its own turn.  On an acknowledgment, a throw used to leave `onReceive` and
 * fault the producer: the supervisor restarted it, the restart's `postStop`
 * settled every other send in flight and queued with `producer stopped`, and
 * the new incarnation started again at seq 1 — one bad callback cost the whole
 * window.  In `postStop`, the same throw abandoned the settlement loop, so
 * every send behind it was never told anything.
 *
 * Each call is guarded now.  A throw is logged at error level, naming the
 * producer and the seq it was reporting, and the turn carries on: the
 * acknowledgment still drains the window, and the stop still settles every
 * remaining send.
 */
import { describe, expect, test } from 'bun:test';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel } from '../../../src/Logger.js';
import type { Logger } from '../../../src/Logger.js';
import { ActorRestarted } from '../../../src/SystemMessages.js';
import { ProducerControllerOptions, ReliableDelivery } from '../../../src/delivery/index.js';
import type { ConfirmationCallback, Delivery } from '../../../src/delivery/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/** One line the system logger was told, with the arguments it carried. */
type LoggedLine = { readonly level: string; readonly message: string; readonly args: readonly unknown[] };

/**
 * Collects every line the system logger is told, arguments included.
 *
 * `tests/util/RecordingLogger.ts` keeps the level and the message only, but
 * what a callback threw travels as an argument — the part of the line that
 * carries its stack, and the part a guard that logged while dropping the
 * error would leave out.
 */
class LineRecordingLogger implements Logger {
  readonly level = LogLevel.Debug;

  constructor(readonly lines: LoggedLine[] = []) {}

  debug(message: string, ...args: unknown[]): void { this.lines.push({ level: 'debug', message, args }); }
  info(message: string, ...args: unknown[]): void { this.lines.push({ level: 'info', message, args }); }
  warn(message: string, ...args: unknown[]): void { this.lines.push({ level: 'warn', message, args }); }
  error(message: string, ...args: unknown[]): void { this.lines.push({ level: 'error', message, args }); }
  withSource(_source: string): Logger { return new LineRecordingLogger(this.lines); }
  withFields(_fields: LogContextData): Logger { return new LineRecordingLogger(this.lines); }
}

/** One send's settlement: its body, and the error message it was told or `null` for delivered. */
type Settlement = readonly [string, string | null];

/** The error lines the producer wrote about a confirm callback, in the order it wrote them. */
const confirmFailures = (logger: LineRecordingLogger): LoggedLine[] => logger.lines
  .filter((line) => line.level === 'error' && line.message.includes('confirm callback'));

/** A callback that records its settlement and returns. */
const recording = (settled: Settlement[], body: string): ConfirmationCallback => (err) => {
  settled.push([body, err === null ? null : err.message]);
};

/** A callback that records its settlement and then throws `thrown`, as a buggy caller's would. */
const throwing = (settled: Settlement[], body: string, thrown: unknown): ConfirmationCallback => (err) => {
  settled.push([body, err === null ? null : err.message]);
  throw thrown;
};

/** Acknowledge a delivery the way a consumer does, echoing the incarnation it was sent under. */
const acknowledge = (delivery: Delivery<string>): void => {
  delivery.replyTo.tell({
    kind: 'reliable-delivery.ack',
    producerId: delivery.producerId,
    incarnation: delivery.incarnation,
    seq: delivery.seq,
  });
};

describe('ProducerController — a confirm callback that throws (#1230)', () => {
  test('a throwing confirm in postStop costs no other send its settlement', async () => {
    const logger = new LineRecordingLogger();
    const kit = TestKit.create('confirm-isolation-stop', TestKitOptions.create().withLogger(logger));
    const settled: Settlement[] = [];

    // Nothing acknowledges, so every send is still owed a settlement when the
    // producer stops.  A window of two puts `a` and `b` in flight and queues
    // `c` and `d` behind them — both loops of `postStop`, each with a throwing
    // callback ahead of a well-behaved one.  JavaScript throws any value, so
    // `c` throws a string: a guard that caught only `Error`s would let it out.
    const thrownByA = new Error('the confirm callback for a blew up');
    const thrownByC = 'the confirm callback for c threw a string';
    const neverAcknowledges = kit.createTestProbe();
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(neverAcknowledges as never)
      .withProducerId('isolation-stop')
      .withResendTimeout(10_000)
      .withWindowSize(2);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);
    producer.tell('a', throwing(settled, 'a', thrownByA));
    producer.tell('b', recording(settled, 'b'));
    producer.tell('c', throwing(settled, 'c', thrownByC));
    producer.tell('d', recording(settled, 'd'));
    const first = await neverAcknowledges.receiveOne(4_000) as Delivery<string>;
    const second = await neverAcknowledges.receiveOne(4_000) as Delivery<string>;
    expect([first.body, second.body]).toEqual(['a', 'b']);

    producer.stop();
    await awaitCondition(() => settled.length === 4, {
      timeoutMs: 4_000,
      label: 'every send, in flight and queued, was settled despite two throwing callbacks',
    });
    expect(settled).toEqual([
      ['a', 'producer stopped'],
      ['b', 'producer stopped'],
      ['c', 'producer stopped'],
      ['d', 'producer stopped'],
    ]);

    // Both throws are reported, each with what was thrown, and the in-flight
    // one by its seq.  A queued send never took a number, so its line says it
    // was queued instead.
    const failures = confirmFailures(logger);
    expect(failures).toHaveLength(2);
    expect(failures[0].message).toContain('producer isolation-stop');
    expect(failures[0].message).toContain('seq=1');
    expect(failures[0].message).toContain('producer stopped');
    expect(failures[0].args).toContain(thrownByA);
    expect(failures[1].message).toContain('producer isolation-stop');
    expect(failures[1].message).toContain('queued');
    expect(failures[1].args).toContain(thrownByC);
    // And neither throw left `postStop`: the cell logs one that does, and the
    // settlement loop it came out of would have been abandoned on the way.
    expect(logger.lines.filter((line) => line.message.startsWith('postStop threw'))).toEqual([]);

    await kit.system.terminate();
  });

  test('a throwing confirm on an acknowledgment does not restart the producer', async () => {
    const logger = new LineRecordingLogger();
    const kit = TestKit.create('confirm-isolation-ack', TestKitOptions.create().withLogger(logger));
    const restarts = kit.createTestProbe();
    kit.system.eventStream.subscribe(restarts, ActorRestarted);
    const settled: Settlement[] = [];

    // The test plays the consumer, so it decides which acknowledgment arrives
    // when.  A window of two puts `a` and `b` in flight and queues `c`.
    const thrownByA = new Error('the confirm callback for a blew up');
    const neverAcknowledges = kit.createTestProbe();
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(neverAcknowledges as never)
      .withProducerId('isolation-ack')
      .withResendTimeout(10_000)
      .withWindowSize(2);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);
    producer.tell('a', throwing(settled, 'a', thrownByA));
    producer.tell('b', recording(settled, 'b'));
    producer.tell('c', recording(settled, 'c'));
    const first = await neverAcknowledges.receiveOne(4_000) as Delivery<string>;
    const second = await neverAcknowledges.receiveOne(4_000) as Delivery<string>;
    expect([first.body, second.body]).toEqual(['a', 'b']);

    acknowledge(first);
    // The slot `a` freed is filled from the queue, numbered on from the same
    // counter under the same incarnation.  A restart would have settled `b`
    // and `c` with `producer stopped` and dispatched nothing at all.
    const third = await neverAcknowledges.receiveOne(4_000) as Delivery<string>;
    expect(third.body).toBe('c');
    expect(third.seq).toBe(3);
    expect(third.incarnation).toBe(first.incarnation);
    expect(settled).toEqual([['a', null]]);

    // `b` is still live: an acknowledgment echoing the incarnation it was sent
    // under settles it as delivered.  A restarted producer would have ignored
    // that incarnation, having told `b` it stopped already.
    acknowledge(second);
    await awaitCondition(() => settled.length === 2, {
      timeoutMs: 4_000,
      label: 'the acknowledgment of b, under the first incarnation, settled it',
    });
    expect(settled).toEqual([['a', null], ['b', null]]);

    // Later sends keep numbering on, and are delivered and confirmed.
    producer.tell('d', recording(settled, 'd'));
    const fourth = await neverAcknowledges.receiveOne(4_000) as Delivery<string>;
    expect(fourth.body).toBe('d');
    expect(fourth.seq).toBe(4);
    expect(fourth.incarnation).toBe(first.incarnation);
    acknowledge(third);
    acknowledge(fourth);
    await awaitCondition(() => settled.length === 4, {
      timeoutMs: 4_000,
      label: 'c and d were confirmed as delivered',
    });
    expect(settled).toEqual([['a', null], ['b', null], ['c', null], ['d', null]]);

    // No restart was published, and the throw is in the log with its seq and
    // with the error itself.
    expect(restarts.messageCount).toBe(0);
    const failures = confirmFailures(logger);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain('producer isolation-ack');
    expect(failures[0].message).toContain('seq=1');
    expect(failures[0].args).toContain(thrownByA);

    producer.stop();
    await kit.system.terminate();
  });

  test('a confirm whose returned promise rejects is logged with its seq, not left unhandled', async () => {
    // `async` is the natural way to write "persist that it is done" for a
    // durable producer, and `(err) => void` accepts such a callback.  It never
    // throws on the producer's turn; its rejection arrives later, and an
    // unhandled rejection ends a Bun or Node process.
    const logger = new LineRecordingLogger();
    const kit = TestKit.create('confirm-isolation-async', TestKitOptions.create().withLogger(logger));
    const settled: Settlement[] = [];
    const rejectedForA = new Error('the async confirm callback for a rejected');
    const rejectedForB = new Error('the async confirm callback for b rejected');
    const neverAcknowledges = kit.createTestProbe();
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(neverAcknowledges as never)
      .withProducerId('isolation-async')
      .withResendTimeout(10_000)
      .withWindowSize(2);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);
    producer.tell('a', async (err) => {
      settled.push(['a', err === null ? null : err.message]);
      throw rejectedForA;
    });
    // `b` hands back a bare thenable rather than a `Promise`: anything `await`
    // would treat as a promise can carry a rejection the same way.
    producer.tell('b', (err) => {
      settled.push(['b', err === null ? null : err.message]);
      return { then: (_onFulfilled: unknown, onRejected: (reason: unknown) => void) => onRejected(rejectedForB) };
    });
    // `c` is an `async` callback that succeeds, and a promise that resolves is
    // nothing to report.
    producer.tell('c', async (err) => {
      settled.push(['c', err === null ? null : err.message]);
    });
    const first = await neverAcknowledges.receiveOne(4_000) as Delivery<string>;
    await neverAcknowledges.receiveOne(4_000);

    // On the acknowledgment path: `a` is told it was delivered, then rejects.
    // The slot it frees takes `c` out of the queue.
    acknowledge(first);
    await awaitCondition(() => confirmFailures(logger).length >= 1, {
      timeoutMs: 4_000,
      label: 'the rejection of the confirm for seq 1 was logged',
    });
    await neverAcknowledges.receiveOne(4_000);

    // On the stop path: `b` is told the producer stopped, then rejects; `c` is
    // told the same and resolves.
    producer.stop();
    await awaitCondition(() => confirmFailures(logger).length >= 2, {
      timeoutMs: 4_000,
      label: 'the rejection of the confirm for seq 2 was logged',
    });
    expect(settled).toEqual([['a', null], ['b', 'producer stopped'], ['c', 'producer stopped']]);

    const failures = confirmFailures(logger);
    expect(failures).toHaveLength(2);
    expect(failures[0].message).toContain('producer isolation-async');
    expect(failures[0].message).toContain('seq=1');
    expect(failures[0].message).toContain('rejected');
    expect(failures[0].args).toContain(rejectedForA);
    expect(failures[1].message).toContain('seq=2');
    expect(failures[1].message).toContain('producer stopped');
    expect(failures[1].args).toContain(rejectedForB);

    await kit.system.terminate();
  });
});
