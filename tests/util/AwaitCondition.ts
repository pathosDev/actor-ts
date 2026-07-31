/**
 * Condition-based waiting for async tests (#418).
 *
 * The suite's dominant flake shape is a fixed `sleep(N)` followed by an
 * assertion on state that some background step was *expected* to have
 * produced by then.  N is picked from a passing local run, so it encodes
 * the idle-machine latency of that step; under parallel load the step
 * takes longer and the assertion reads a value that was never written.
 * Raising N hides the flake and lengthens every run, including the
 * (overwhelming) majority that would have been fine with a fraction of it.
 *
 * {@link awaitCondition} inverts that trade-off: it polls the observable
 * state and returns as soon as it holds, so the fast path costs one poll
 * interval and the timeout can be set generously — it is a *failure*
 * budget, not the expected duration.  Which also makes the timeout a
 * useful diagnostic: reaching it means the condition genuinely never
 * became true, not that the machine was briefly busy.
 *
 * Wait on the strongest condition the test can actually observe — a probe
 * reply, a recovery callback, a spy array — not a proxy that a partially
 * completed step could already satisfy.
 */

/** Options for {@link awaitCondition}; every field has a usable default. */
export type AwaitConditionOptions = {
  /**
   * Failure budget, not an expected duration — a passing test returns as
   * soon as the predicate holds, so this only bounds the *broken* case.
   * Keep it comfortably above the worst plausible loaded latency, and
   * below Bun's per-test timeout (5 s) so the diagnostic message wins the
   * race against the runner's uninformative one.
   */
  timeoutMs?: number;
  /** Poll cadence.  Also the floor on a passing wait's cost. */
  intervalMs?: number;
  /** Named in the timeout message — describe the awaited state, not the call. */
  label?: string;
};

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_INTERVAL_MS = 5;

/**
 * Poll `predicate` until it returns true, then resolve.  Throws a
 * descriptive `Error` naming `label` if the timeout elapses first.
 *
 *   ref.tell({ kind: 'increment' });
 *   await awaitCondition(() => recoveredState !== null, {
 *     label: 'actor recovered from the encrypted snapshot',
 *   });
 *   expect(recoveredState).toEqual({ count: 2 });
 *
 * The predicate may be async (e.g. a backend `list()`); it is awaited and
 * never run concurrently with itself.  A predicate that *throws* fails the
 * wait immediately — a broken check is a test bug, not a slow condition,
 * so it should not be retried until the timeout buries the cause.
 */
export async function awaitCondition(
  predicate: () => boolean | Promise<boolean>,
  options: AwaitConditionOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const label = options.label ?? 'condition';
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`awaitCondition: timeoutMs must be a positive finite number, got ${timeoutMs}`);
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`awaitCondition: intervalMs must be a positive finite number, got ${intervalMs}`);
  }

  const start = performance.now();
  let polls = 0;
  // Check before the first sleep: a condition that already holds must not
  // pay an interval, which is what makes a generous timeout free.
  for (;;) {
    polls++;
    if (await predicate()) return;
    if (performance.now() - start >= timeoutMs) {
      throw new Error(
        `awaitCondition: ${label} did not become true within ${timeoutMs}ms ` +
        `(waited ${(performance.now() - start).toFixed(0)}ms, ${polls} polls)`,
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Portable `sleep` — `Bun.sleep` is re-declared per test file and does not
 * exist under the Node/Deno smoke runs.
 *
 * Prefer {@link awaitCondition}.  A bare sleep is only correct when the
 * elapsed time *is* the thing under test (a debounce window, a timer's
 * lower bound) or when the test must observe that nothing happened.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
