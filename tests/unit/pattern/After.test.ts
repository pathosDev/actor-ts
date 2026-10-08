import { describe, expect, test } from 'bun:test';
import { after } from '../../../src/pattern/After.js';
import { MAX_TIMER_DELAY_MS } from '../../../src/util/Constants.js';
import { assertDoesNotCompleteWithin } from '../../util/AsyncAssertions.js';

/**
 * `after` with no scheduler waits a delay past the host timer ceiling in full
 * (found while #870).
 *
 * Without a scheduler it arms a host timer of its own, and `setTimeout` cannot
 * hold a delay above {@link MAX_TIMER_DELAY_MS} (~24.9 days): Bun and Node arm
 * one as 1 ms, Deno wraps it modulo 2^32.  On bun 1.4.2
 * `after(2 ** 31, factory)` ran the factory after 15.5 ms.  A scheduler
 * already chains such a delay; this is the branch that does not have one.
 *
 * Waiting 24.9 days is not a test, so the chain is proven on the runtime's own
 * timers with the global `setTimeout` recorded.  The chain looks the primitive
 * up when it arms a link, so a recorded global sees every link, and running a
 * link's callback by hand stands in for the link elapsing.
 */

/** 2^31 ms — one past the largest delay a host timer holds. */
const CEILING_PLUS_ONE_MS = MAX_TIMER_DELAY_MS + 1;

/** One call the runtime's `setTimeout` received while it was recorded. */
type RecordedTimeout = {
  readonly callback: unknown;
  readonly delayMs: unknown;
  readonly handle: ReturnType<typeof setTimeout>;
};

/**
 * Run `arm` with the runtime's `setTimeout` recorded, and hand back every call
 * it received.  The calls still reach the real primitive, because the handle
 * it returns is what a cancel has to clear — so every case that stops short of
 * the end of a chain cancels what it armed.
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

/** Run `act` with the runtime's `clearTimeout` recorded, and hand back every handle it was asked to clear. */
function recordingClears(act: () => void): readonly unknown[] {
  const realClearTimeout = globalThis.clearTimeout;
  const cleared: unknown[] = [];
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    cleared.push(handle);
    realClearTimeout(handle);
  }) as typeof clearTimeout;
  try {
    act();
    return cleared;
  } finally {
    globalThis.clearTimeout = realClearTimeout;
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

describe('after with no scheduler, past the host timer ceiling', () => {
  test('has not run the factory on the wall clock long after the overflow would have', async () => {
    // The symptom as a caller met it: 15.5 ms on bun 1.4.2.  An absence, so it
    // needs a window, and the window only has to outlast that by a wide margin.
    let ran = false;
    const pending = after(CEILING_PLUS_ONE_MS, async () => { ran = true; return 'late'; });
    // The cancel below rejects it; that rejection is the cleanup, not a result.
    pending.catch(() => {});
    try {
      await assertDoesNotCompleteWithin(pending, 150, 'after(2^31 ms) with no scheduler');
      expect(ran).toBe(false);
    } finally {
      pending.cancel();
    }
  });

  test('is armed as a chain of host timers whose links add up to the delay', async () => {
    let ran = 0;
    const first = recordingTimeouts(() => after(CEILING_PLUS_ONE_MS, async () => { ran++; return 'late'; }));
    const pending = first.result;
    pending.catch(() => {});
    try {
      expect(delaysOf(first.timeouts)).toEqual([MAX_TIMER_DELAY_MS]);

      // 24.9 days on: a link elapsing is not the delay elapsing.
      const second = elapse(first.timeouts[0]);
      expect(ran).toBe(0);
      expect(delaysOf(second)).toEqual([1]);

      // The last millisecond is, and it arms nothing further.
      const third = elapse(second[0]);
      expect(delaysOf(third)).toEqual([]);
      expect(await pending).toBe('late');
      expect(ran).toBe(1);
    } finally {
      pending.cancel();
    }
  });

  test('cancel clears whichever link is armed, the second one included', async () => {
    let ran = 0;
    const first = recordingTimeouts(() => after(CEILING_PLUS_ONE_MS, async () => { ran++; return 'late'; }));
    const pending = first.result;
    const outcome = pending.then(() => 'resolved', (error: Error) => error.message);

    const second = elapse(first.timeouts[0]);
    const [secondLink] = second;
    // `toEqual` reads `[undefined]` as `[]`, so this is what makes the clear
    // below an assertion about a link rather than about nothing.
    expect(secondLink).toBeDefined();
    const cleared = recordingClears(() => { pending.cancel(); });

    expect(cleared).toEqual([secondLink!.handle]);
    expect(await outcome).toBe('after: cancelled');
    expect(ran).toBe(0);
  });

  test('a delay that never runs out never runs the factory', () => {
    // `Infinity` used to run after 1 ms like every other overflowing delay.
    // Taken at its word it is a delay that only a cancel ends, as it is on a
    // scheduler: the chain keeps re-arming a ceiling-long link.
    let ran = 0;
    const first = recordingTimeouts(() => after(Number.POSITIVE_INFINITY, async () => { ran++; return 'never'; }));
    const pending = first.result;
    pending.catch(() => {});
    try {
      expect(delaysOf(first.timeouts)).toEqual([MAX_TIMER_DELAY_MS]);
      const second = elapse(first.timeouts[0]);
      expect(delaysOf(second)).toEqual([MAX_TIMER_DELAY_MS]);
      expect(ran).toBe(0);
    } finally {
      pending.cancel();
    }
  });
});

describe('after with no scheduler, at and below the ceiling', () => {
  test('a delay at the ceiling arms one host timer that runs the factory itself, as it always did', async () => {
    let ran = 0;
    const first = recordingTimeouts(() => after(MAX_TIMER_DELAY_MS, async () => { ran++; return 'on time'; }));
    expect(delaysOf(first.timeouts)).toEqual([MAX_TIMER_DELAY_MS]);

    const next = elapse(first.timeouts[0]);
    expect(delaysOf(next)).toEqual([]);
    expect(await first.result).toBe('on time');
    expect(ran).toBe(1);
  });

  test('a short delay still runs on the wall clock', async () => {
    expect(await after(1, async () => 'real')).toBe('real');
  });
});
