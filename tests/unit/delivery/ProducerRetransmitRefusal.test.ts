/**
 * A retransmit the consumer refuses (#1230).
 *
 * A consumer's `tell` can throw — a bounded mailbox with the `reject` overflow
 * policy throws `MailboxFullError` at the sender.  On a message's first
 * transmission that happens on the producer's turn and faults it, which
 * `ReliableDelivery.test.ts` uses as its restart trigger.  A retransmit runs
 * from the scheduler instead, and the producer used to arm the next retransmit
 * only after the tell returned: one refused retransmit skipped the re-arm, the
 * scheduler reported a bare task error naming neither the producer nor the
 * seq, and that seq was never sent again — it held its window slot until the
 * producer stopped.
 */
import { describe, expect, test } from 'bun:test';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel } from '../../../src/Logger.js';
import type { Logger } from '../../../src/Logger.js';
import { ProducerControllerOptions, ReliableDelivery } from '../../../src/delivery/index.js';
import type { Delivery } from '../../../src/delivery/index.js';
import { TestKit } from '../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/** One line the system logger was told, with the arguments it carried. */
type LoggedLine = { readonly level: string; readonly message: string; readonly args: readonly unknown[] };

/**
 * Collects every line the system logger is told, arguments included — the
 * error a refused tell threw travels as an argument, and `RecordingLogger`
 * keeps only the level and the message.
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

/** The resend timeout, on virtual time — the test moves the clock, so its size costs nothing. */
const RESEND_TIMEOUT_MS = 1_000;

describe('ProducerController — a retransmit the consumer refuses (#1230)', () => {
  test('is logged with its seq, and the seq is retransmitted again after the next timeout', async () => {
    const logger = new LineRecordingLogger();
    const { kit, scheduler } = TestKit.withManualScheduler(
      'retransmit-refusal',
      TestKitOptions.create().withLogger(logger),
    );
    const handled: string[] = [];
    const settled: Array<string | null> = [];
    const consumer = ReliableDelivery.consumer<string>(kit.system, {
      handler: (body) => { handled.push(body); },
    });

    // The first transmission is lost on the way, so only a retransmit can
    // deliver the message; the first retransmit is refused; everything after
    // that reaches the real consumer.
    const refusal = new Error('the consumer refused the first retransmit');
    const transmissions: number[] = [];
    const losesThenRefuses = {
      tell(delivery: Delivery<string>): void {
        transmissions.push(delivery.seq);
        if (transmissions.length === 1) return;
        if (transmissions.length === 2) throw refusal;
        consumer.ref.tell(delivery);
      },
    };
    const producerOptions = ProducerControllerOptions.create<string>()
      .withConsumer(losesThenRefuses as never)
      .withProducerId('refused-retransmit')
      .withResendTimeout(RESEND_TIMEOUT_MS)
      .withWindowSize(4);
    const producer = ReliableDelivery.producer<string>(kit.system, producerOptions);
    producer.tell('x', (err) => { settled.push(err === null ? null : err.message); });
    await awaitCondition(() => transmissions.length === 1, {
      timeoutMs: 4_000,
      label: 'the first transmission went out',
    });

    // The timer fires synchronously inside `advance`, and so does the tell it
    // makes, so each count can be read straight after.
    scheduler.advance(RESEND_TIMEOUT_MS);
    expect(transmissions).toEqual([1, 1]);

    scheduler.advance(RESEND_TIMEOUT_MS);
    expect(transmissions).toEqual([1, 1, 1]);
    await awaitCondition(() => settled.length === 1, {
      timeoutMs: 4_000,
      label: 'the second retransmit was handled and acknowledged',
    });
    expect(handled).toEqual(['x']);
    expect(settled).toEqual([null]);

    // The refusal is reported by the producer, with the seq and what was
    // thrown — not by the scheduler, whose generic report names neither.
    const refusals = logger.lines.filter((line) => line.message.includes('refused the retransmit'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0].level).toBe('warn');
    expect(refusals[0].message).toContain('producer refused-retransmit');
    expect(refusals[0].message).toContain('seq=1');
    expect(refusals[0].args).toContain(refusal);
    expect(logger.lines.filter((line) => line.message.startsWith('Unhandled scheduler error'))).toEqual([]);

    producer.stop();
    consumer.stop();
    await kit.system.terminate();
  });
});
