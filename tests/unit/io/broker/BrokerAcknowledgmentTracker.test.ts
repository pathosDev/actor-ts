/**
 * `BrokerAcknowledgmentTracker` on its own (#1845 G18): the bookkeeping that
 * lets a teardown give up on every outstanding reply, and the texts a refused
 * delivery is reported with.
 *
 * The broker suites reach the tracker only through a whole actor, which reads
 * neither `outstandingCount` nor the error message, so a settled entry that
 * stayed in `outstanding` — or a timeout reported as "(timed out)" — passed
 * them all.  The target here is a stand-in whose `ask` the test settles by
 * hand, so every path is exact and nothing waits on a clock.
 */
import { describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../../src/ActorRef.js';
import {
  BrokerAcknowledgmentTracker,
  BrokerDeliveryNotAcknowledgedError,
} from '../../../../src/io/broker/BrokerAcknowledgment.js';
import { AskTimeoutError } from '../../../../src/SystemMessages.js';

const TARGET_PATH = 'actor-ts://tracker/user/target';
const TIMEOUT_MS = 1_234;

/** A target whose one `ask` is settled by the test. */
function standInTarget(): {
  readonly target: ActorRef<object>;
  readonly answer: (reply: unknown) => void;
  readonly refuse: (error: unknown) => void;
  readonly delivered: object[];
} {
  let answer: (reply: unknown) => void = () => undefined;
  let refuse: (error: unknown) => void = () => undefined;
  const delivered: object[] = [];
  const target = {
    path: { toString: () => TARGET_PATH },
    tell: (message: object) => { delivered.push(message); },
    ask: (message: object) => {
      delivered.push(message);
      return new Promise<unknown>((resolve, reject) => { answer = resolve; refuse = reject; });
    },
  };
  return {
    target: target as unknown as ActorRef<object>,
    answer: (reply) => answer(reply),
    refuse: (error) => refuse(error),
    delivered,
  };
}

type Outcome = { readonly kind: 'pending' } | { readonly kind: 'resolved' } | { readonly kind: 'rejected'; readonly error: Error };

/** Track how `promise` settles without awaiting it, so a promise that never settles is a finding, not a hang. */
function observe(promise: Promise<void>): { readonly current: () => Outcome } {
  let outcome: Outcome = { kind: 'pending' };
  promise.then(
    () => { outcome = { kind: 'resolved' }; },
    (error: Error) => { outcome = { kind: 'rejected', error }; },
  );
  return { current: () => outcome };
}

/** Let every queued promise reaction run: a macrotask runs only once the microtask queue is empty. */
function drainMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

function rejectionOf(outcome: Outcome): Error {
  if (outcome.kind !== 'rejected') throw new Error(`expected a rejection, the delivery is ${outcome.kind}`);
  return outcome.error;
}

describe('BrokerAcknowledgmentTracker — on-reply bookkeeping', () => {
  test('an acknowledgment reply resolves the delivery and leaves nothing outstanding', async () => {
    const tracker = new BrokerAcknowledgmentTracker('on-reply', TIMEOUT_MS);
    const { target, answer, delivered } = standInTarget();
    const delivery = observe(tracker.deliver(target, { id: 1 }));
    expect(delivered).toEqual([{ id: 1 }]);
    expect(tracker.outstandingCount).toBe(1);

    answer({ kind: 'acknowledgment' });
    await drainMicrotasks();
    expect(delivery.current()).toEqual({ kind: 'resolved' });
    expect(tracker.outstandingCount).toBe(0);
  });

  test('a negative reply rejects and leaves nothing outstanding', async () => {
    const tracker = new BrokerAcknowledgmentTracker('on-reply', TIMEOUT_MS);
    const { target, answer } = standInTarget();
    const delivery = observe(tracker.deliver(target, { id: 1 }));

    answer({ kind: 'negativeAcknowledgment', reason: 'database unavailable' });
    await drainMicrotasks();
    const error = rejectionOf(delivery.current());
    expect(error).toBeInstanceOf(BrokerDeliveryNotAcknowledgedError);
    expect(error.message).toBe('negatively acknowledged: database unavailable');
    expect(tracker.outstandingCount).toBe(0);
  });

  test('a negative reply without a reason reads exactly "negatively acknowledged"', async () => {
    const tracker = new BrokerAcknowledgmentTracker('on-reply', TIMEOUT_MS);
    const { target, answer } = standInTarget();
    const delivery = observe(tracker.deliver(target, { id: 1 }));

    answer({ kind: 'negativeAcknowledgment' });
    await drainMicrotasks();
    expect(rejectionOf(delivery.current()).message).toBe('negatively acknowledged');
  });

  test('a null reply is refused as unrecognised rather than crashing the bookkeeping', async () => {
    const tracker = new BrokerAcknowledgmentTracker('on-reply', TIMEOUT_MS);
    const { target, answer } = standInTarget();
    const delivery = observe(tracker.deliver(target, { id: 1 }));

    answer(null);
    await drainMicrotasks();
    expect(rejectionOf(delivery.current()).message).toBe(
      "the target's reply was neither { kind: 'acknowledgment' } nor { kind: 'negativeAcknowledgment' }",
    );
    expect(tracker.outstandingCount).toBe(0);
  });

  test('an ask timeout names the target and the budget, with no suffix', async () => {
    const tracker = new BrokerAcknowledgmentTracker('on-reply', TIMEOUT_MS);
    const { target, refuse } = standInTarget();
    const delivery = observe(tracker.deliver(target, { id: 1 }));

    refuse(new AskTimeoutError('ask timed out'));
    await drainMicrotasks();
    const error = rejectionOf(delivery.current());
    expect(error).toBeInstanceOf(BrokerDeliveryNotAcknowledgedError);
    expect(error.message).toBe(`no reply from ${TARGET_PATH} within ${TIMEOUT_MS} ms`);
    expect(tracker.outstandingCount).toBe(0);
  });

  test('any other ask failure carries its message as a suffix', async () => {
    const tracker = new BrokerAcknowledgmentTracker('on-reply', TIMEOUT_MS);
    const { target, refuse } = standInTarget();
    const delivery = observe(tracker.deliver(target, { id: 1 }));

    refuse(new Error('target terminated'));
    await drainMicrotasks();
    expect(rejectionOf(delivery.current()).message).toBe(
      `no reply from ${TARGET_PATH} within ${TIMEOUT_MS} ms (target terminated)`,
    );
    expect(tracker.outstandingCount).toBe(0);
  });

  test('cancelAll rejects every outstanding delivery with its cause and empties the set', async () => {
    const tracker = new BrokerAcknowledgmentTracker('on-reply', TIMEOUT_MS);
    const first = observe(tracker.deliver(standInTarget().target, { id: 1 }));
    const second = observe(tracker.deliver(standInTarget().target, { id: 2 }));
    expect(tracker.outstandingCount).toBe(2);

    tracker.cancelAll('connection gone');
    await drainMicrotasks();
    expect(rejectionOf(first.current()).message).toBe('connection gone');
    expect(rejectionOf(second.current()).message).toBe('connection gone');
    expect(tracker.outstandingCount).toBe(0);
  });
});

describe('BrokerAcknowledgmentTracker — on-delivery', () => {
  test('tells the target, resolves at once and tracks nothing', async () => {
    const tracker = new BrokerAcknowledgmentTracker('on-delivery', TIMEOUT_MS);
    const { target, delivered } = standInTarget();
    expect(tracker.awaitsReply).toBe(false);
    const delivery = observe(tracker.deliver(target, { id: 1 }));
    await drainMicrotasks();
    expect(delivered).toEqual([{ id: 1 }]);
    expect(delivery.current()).toEqual({ kind: 'resolved' });
    expect(tracker.outstandingCount).toBe(0);
  });
});
