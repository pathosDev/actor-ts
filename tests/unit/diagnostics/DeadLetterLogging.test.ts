import { describe, expect, test } from 'bun:test';
import { ActorPath } from '../../../src/ActorPath.js';
import { ActorRef } from '../../../src/ActorRef.js';
import { EventStream } from '../../../src/EventStream.js';
import { DeadLetterRef, type DeadLetterLogging } from '../../../src/internal/DeadLetterRef.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { RecordingLogger, type RecordedLog } from '../../util/RecordingLogger.js';

/**
 * The dead-letter log throttle (#1000).
 *
 * `DeadLetterRef` is exercised directly rather than through an `ActorSystem`,
 * for two reasons that are the same reason twice: the throttle is a pure
 * function of a counter and a clock, and both are constructor arguments here.
 * Driving a real system would add a spawn, a stop and a race to observe a
 * property that has none — and the *window* half could not be tested at all
 * without either a five-minute wait or a scheduler the ref does not use.  The
 * window is measured lazily against `nowMs`, never scheduled, so moving the
 * injected clock is the whole of "five minutes passed".
 *
 * `tests/unit/DeadLetter.test.ts` carries the other half: that a default
 * `ActorSystem` really does supply this, so the settings reach a running
 * system rather than only a hand-built ref.
 */

/** A ref whose clock and settings the test owns outright. */
function refUnderTest(
  overrides: Partial<DeadLetterLogging> = {},
): { ref: DeadLetterRef; log: RecordingLogger; clock: { ms: number } } {
  const log = new RecordingLogger();
  const clock = { ms: 1_000 };
  const ref = new DeadLetterRef('diag', new EventStream(), {
    log,
    logDeadLetters: 3,
    logDeadLettersDuringShutdown: false,
    logDeadLettersSuspendDurationMs: 60_000,
    isTerminating: () => false,
    nowMs: () => clock.ms,
    ...overrides,
  });
  return { ref, log, clock };
}

const infos = (log: RecordingLogger): RecordedLog[] =>
  log.records.filter((r) => r.level === 'info');
const warns = (log: RecordingLogger): RecordedLog[] =>
  log.records.filter((r) => r.level === 'warn');

/** A ref that only collects, standing in for a real actor at a real path. */
class CollectingRef extends ActorRef<unknown> {
  readonly path: ActorPath;
  readonly received: unknown[] = [];

  constructor(name: string) {
    super();
    this.path = new ActorPath('', null, 'diag').child('user').child(name);
  }

  override tell(message: unknown): void { this.received.push(message); }
}

describe('the dead-letter record', () => {
  test('names the recipient path and the message class', () => {
    class OrderPlaced { constructor(readonly orderId: string) {} }
    const { ref, log } = refUnderTest();
    const worker = new CollectingRef('worker');

    // Pre-wrapped, because that is the normal path: a cell wraps before it
    // calls, so the recipient is the actor the message failed to reach rather
    // than the dead-letter office, which is the one recipient every letter
    // shares and therefore no information (#433).
    ref.tell(new DeadLetter(new OrderPlaced('order-4711'), null, worker));

    expect(infos(log)).toHaveLength(1);
    expect(infos(log)[0]!.message).toContain('actor-ts://diag/user/worker');
    expect(infos(log)[0]!.message).toContain('OrderPlaced');
  });

  test('never carries the payload', () => {
    // The whole reason the record names a class and not a value: an
    // undeliverable message is untrusted application data, and printing it is
    // the same data-protection decision that makes the queue's store `off`.
    class Credentials { constructor(readonly password: string) {} }
    const { ref, log } = refUnderTest();

    ref.tell(new Credentials('hunter2'));

    expect(log.records.map((r) => r.message).join('\n')).not.toContain('hunter2');
  });

  test('names the sender when there is one, and says nothing when there is not', () => {
    const { ref, log } = refUnderTest();
    const worker = new CollectingRef('worker');
    const api = new CollectingRef('api');

    ref.tell(new DeadLetter('anonymous', null, worker));
    ref.tell(new DeadLetter('attributed', api, worker));

    expect(infos(log)[0]!.message).not.toContain('from ');
    expect(infos(log)[1]!.message).toContain('from actor-ts://diag/user/api');
  });
});

describe('the dead-letter log throttle', () => {
  test('logs the configured count in full, then exactly one suppression line', () => {
    const { ref, log } = refUnderTest();

    for (let i = 0; i < 10; i += 1) ref.tell(`message-${i}`);

    expect(infos(log)).toHaveLength(3);
    expect(warns(log)).toHaveLength(1);
    expect(warns(log)[0]!.message).toContain('suspended');
  });

  test('stays silent for the whole window, however many letters arrive', () => {
    const { ref, log, clock } = refUnderTest();

    for (let i = 0; i < 3; i += 1) ref.tell(`filling-${i}`);
    const afterCap = log.records.length;

    clock.ms += 59_999;
    for (let i = 0; i < 100; i += 1) ref.tell(`suppressed-${i}`);

    expect(log.records).toHaveLength(afterCap);
  });

  test('resumes once the window elapses, and reports what it cost', () => {
    const { ref, log, clock } = refUnderTest();

    for (let i = 0; i < 3; i += 1) ref.tell(`filling-${i}`);
    for (let i = 0; i < 7; i += 1) ref.tell(`suppressed-${i}`);
    clock.ms += 60_000;
    ref.tell('after-the-window');

    // Four full records: three before the suspension, one after it lifted.
    expect(infos(log)).toHaveLength(4);
    // The tally lands on resumption because at suspension time nothing has
    // been suppressed yet and the number would be zero.
    const resumed = warns(log).filter((r) => r.message.includes('resumed'));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.message).toContain('7 dead letters');
  });

  test('a window that suppressed nothing resumes silently', () => {
    const { ref, log, clock } = refUnderTest();

    for (let i = 0; i < 3; i += 1) ref.tell(`filling-${i}`);
    clock.ms += 60_000;
    ref.tell('after-the-quiet-window');

    expect(warns(log).filter((r) => r.message.includes('resumed'))).toHaveLength(0);
    expect(infos(log)).toHaveLength(4);
  });

  test('the counter resets, so a second window logs the full count again', () => {
    const { ref, log, clock } = refUnderTest();

    for (let i = 0; i < 5; i += 1) ref.tell(`first-${i}`);
    clock.ms += 60_000;
    for (let i = 0; i < 5; i += 1) ref.tell(`second-${i}`);

    expect(infos(log)).toHaveLength(6);
    expect(warns(log).filter((r) => r.message.includes('suspended'))).toHaveLength(2);
  });

  test('a suspend duration of 0 never suspends', () => {
    const { ref, log } = refUnderTest({ logDeadLettersSuspendDurationMs: 0 });

    for (let i = 0; i < 50; i += 1) ref.tell(`unthrottled-${i}`);

    expect(infos(log)).toHaveLength(50);
    expect(warns(log)).toHaveLength(0);
  });

  test('a count of 0 logs nothing at all', () => {
    const { ref, log } = refUnderTest({ logDeadLetters: 0 });

    for (let i = 0; i < 50; i += 1) ref.tell(`silent-${i}`);

    expect(log.records).toHaveLength(0);
  });
});

describe('shutdown silence', () => {
  test('is silent while the system is terminating', () => {
    const { ref, log } = refUnderTest({ isTerminating: () => true });

    ref.tell('drained-on-the-way-down');

    expect(log.records).toHaveLength(0);
  });

  test('logs the teardown burst when asked to', () => {
    const { ref, log } = refUnderTest({
      isTerminating: () => true,
      logDeadLettersDuringShutdown: true,
    });

    ref.tell('drained-on-the-way-down');

    expect(infos(log)).toHaveLength(1);
  });

});

describe('the gate covers the log and nothing else', () => {
  const cases: ReadonlyArray<readonly [string, Partial<DeadLetterLogging>]> = [
    ['throttled', {}],
    ['silenced by shutdown', { isTerminating: () => true }],
    ['switched off', { logDeadLetters: 0 }],
  ];

  test.each(cases)('a %s letter is still captured and published', (_label, overrides) => {
    // The load-bearing half of "gate the log only": the sink is the durable
    // record and the stream is a contract with every subscriber, so neither may
    // notice that logging went quiet.  A gate in front of either would turn the
    // queue's completeness claim into a lie and would silently change what
    // every existing subscriber sees — which is #1179's decision, not this
    // one's.
    const eventStream = new EventStream();
    const subscriber = new CollectingRef('subscriber');
    eventStream.subscribe(subscriber, DeadLetter);
    const captured: DeadLetter[] = [];
    const ref = new DeadLetterRef('diag', eventStream, {
      log: new RecordingLogger(),
      logDeadLetters: 1,
      logDeadLettersDuringShutdown: false,
      logDeadLettersSuspendDurationMs: 60_000,
      isTerminating: () => false,
      nowMs: () => 1_000,
      ...overrides,
    });
    ref._setSink((deadLetter) => { captured.push(deadLetter); });

    for (let i = 0; i < 5; i += 1) ref.tell(`unlogged-${i}`);

    expect(captured).toHaveLength(5);
    expect(subscriber.received).toHaveLength(5);
  });
});
