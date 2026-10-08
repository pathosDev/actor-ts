/**
 * Tuned values for `src/pattern/`.
 *
 * Rule 3 of the constants policy: this is not the default of an
 * `XOptionsType` field with an `XOptions.ts` to live in — `retry` takes a
 * plain `RetryOptions` bag and has no options family — and it is not fixed
 * by a codec or an algorithm chosen in the file it came from.  That leaves
 * the subsystem's own `Constants.ts`, which `src/pattern/` did not have while
 * sixteen sibling subsystems did.
 *
 * It moved out of `Retry.ts` verbatim, JSDoc included, and is not on the
 * `pattern` barrel: it was module-private before the move and a relocation
 * is not the moment to widen a surface.  `MAX_TIMER_DELAY_MS` moved out of
 * `Retry.ts` beside it and has since moved on to `src/util/Constants.ts`,
 * because `src/http/` bounds its deadlines by the same ceiling (#870).
 *
 * Imports nothing from `src/pattern/`, so it cannot take part in a cycle.
 */

/**
 * Built-in default for `RetryOptions.maxDelayMs` (#771).
 *
 * The option used to default to `Number.POSITIVE_INFINITY`, on the reasoning
 * that a caller who wants a ceiling asks for one.  What that actually bought
 * was a schedule whose upper bound was `MAX_TIMER_DELAY_MS` — a retry
 * loop that, having exhausted the operator's patience, went on waiting for
 * ~24.9 days per attempt.  Nobody configures that on purpose; it is what an
 * omitted cap plus `factor > 1` arrives at on its own, which makes it the
 * wrong thing for the *default* to mean.
 *
 * One minute is the ceiling the surrounding project already converged on for
 * a backoff a human is waiting behind (`exponentialBackoff` requires a finite
 * `maxMs`; the broker reconnect loop and the WebSocket client both cap at
 * 30 s), doubled because `retry` wraps a single call rather than a
 * reconnect loop and one lost minute is cheaper here than one lost hour.
 *
 * A caller who genuinely wants the old, uncapped schedule still has it —
 * `maxDelayMs: Number.POSITIVE_INFINITY` — and gets the timer clamp with it.
 */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
