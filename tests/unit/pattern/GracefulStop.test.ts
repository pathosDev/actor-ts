import { describe, expect, test } from 'bun:test';
import { ActorPath } from '../../../src/ActorPath.js';
import { ActorRef } from '../../../src/ActorRef.js';
import { PoisonPill } from '../../../src/SystemMessages.js';
import { gracefulStop } from '../../../src/pattern/GracefulStop.js';
import { MAX_TIMER_DELAY_MS } from '../../../src/util/Constants.js';
import { assertDoesNotCompleteWithin } from '../../util/AsyncAssertions.js';

/**
 * `gracefulStop` on a ref with no local cell waits a budget past the host
 * timer ceiling in full (found while #870).
 *
 * A local actor's budget runs on the system scheduler, which chains a long
 * delay.  Any other ref — a cluster ref, a remote routee — has nothing local
 * to confirm the stop with, so its budget is a host timer of its own, and
 * `setTimeout` cannot hold a delay above {@link MAX_TIMER_DELAY_MS} (~24.9
 * days).  On bun 1.4.2 `gracefulStop(ref, 2 ** 31)` resolved `false` within
 * milliseconds — 1.3 ms in one run, 15 ms in another: a caller who granted a
 * stop weeks got an answer at once.
 *
 * The chain is proven on the runtime's own timers with the global
 * `setTimeout` recorded, a link's callback run by hand standing in for the
 * link elapsing.
 */

/** 2^31 ms — one past the largest delay a host timer holds. */
const CEILING_PLUS_ONE_MS = MAX_TIMER_DELAY_MS + 1;

/** A ref with no cell behind it, which is every ref `gracefulStop` cannot watch. */
class RemoteLikeRef extends ActorRef<unknown> {
  readonly path = new ActorPath('remote-like');
  readonly received: unknown[] = [];
  tell(message: unknown): void { this.received.push(message); }
}

/** One call the runtime's `setTimeout` received while it was recorded. */
type RecordedTimeout = {
  readonly callback: unknown;
  readonly delayMs: unknown;
  readonly handle: ReturnType<typeof setTimeout>;
};

/**
 * Run `arm` with the runtime's `setTimeout` recorded, and hand back every call
 * it received.  The calls still reach the real primitive; `gracefulStop` hands
 * the caller no handle to cancel with, so a case that stops short of the end
 * of a chain clears the recorded handle itself.
 */
function recordingTimeouts<T>(arm: () => T): { readonly result: T; readonly timeouts: readonly RecordedTimeout[] } {
  const realSetTimeout = globalThis.setTimeout;
  const timeouts: RecordedTimeout[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    timeouts.push({ callback: args[0], delayMs: args[1], handle });
    return handle;
  }) as typeof setTimeout;
  try {
    return { result: arm(), timeouts };
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

/**
 * Stand in for `timeout` elapsing: clear the real timer so it can never also
 * fire, then run its callback now, recording whatever that arms next.
 */
function elapse(timeout: RecordedTimeout | undefined): readonly RecordedTimeout[] {
  if (timeout === undefined) throw new Error('no timer was armed to elapse');
  clearTimeout(timeout.handle);
  return recordingTimeouts(() => { (timeout.callback as () => void)(); }).timeouts;
}

const delaysOf = (timeouts: readonly RecordedTimeout[]): unknown[] => timeouts.map((timeout) => timeout.delayMs);

const STILL_PENDING = Symbol('still pending');

/**
 * What `promise` has settled with, or {@link STILL_PENDING}.  A promise that
 * is already resolved wins the race, because its reaction is queued first.
 */
function settledValue<T>(promise: Promise<T>): Promise<T | typeof STILL_PENDING> {
  return Promise.race([promise, Promise.resolve(STILL_PENDING)]);
}

describe('gracefulStop on a ref it cannot watch, past the host timer ceiling', () => {
  test('has not given up on the wall clock long after the overflow would have', async () => {
    // The symptom as a caller met it.  An absence, so it needs a window, and
    // the window only has to outlast a millisecond-scale answer by a wide margin.
    const ref = new RemoteLikeRef();
    const { result: stopped, timeouts } = recordingTimeouts(() => gracefulStop(ref, CEILING_PLUS_ONE_MS));
    try {
      await assertDoesNotCompleteWithin(stopped, 150, 'gracefulStop(non-local ref, 2^31 ms)');
      // The stop itself is still delivered, budget or no budget.
      expect(ref.received).toEqual([PoisonPill.instance]);
    } finally {
      for (const timeout of timeouts) clearTimeout(timeout.handle);
    }
  });

  test('is a chain of host timers whose links add up to the budget', async () => {
    const ref = new RemoteLikeRef();
    const first = recordingTimeouts(() => gracefulStop(ref, CEILING_PLUS_ONE_MS));
    const stopped = first.result;
    let armed = first.timeouts;
    try {
      expect(delaysOf(armed)).toEqual([MAX_TIMER_DELAY_MS]);

      // 24.9 days on: a link elapsing is not the budget running out.
      armed = elapse(armed[0]);
      expect(delaysOf(armed)).toEqual([1]);
      expect(await settledValue(stopped)).toBe(STILL_PENDING);

      // The last millisecond is, and it arms nothing further.
      armed = elapse(armed[0]);
      expect(delaysOf(armed)).toEqual([]);
      expect(await stopped).toBe(false);
    } finally {
      for (const timeout of armed) clearTimeout(timeout.handle);
    }
  });

  test('a budget at the ceiling arms one host timer that gives up itself, as it always did', async () => {
    const ref = new RemoteLikeRef();
    const first = recordingTimeouts(() => gracefulStop(ref, MAX_TIMER_DELAY_MS));
    expect(delaysOf(first.timeouts)).toEqual([MAX_TIMER_DELAY_MS]);

    const next = elapse(first.timeouts[0]);
    expect(delaysOf(next)).toEqual([]);
    expect(await first.result).toBe(false);
  });
});
