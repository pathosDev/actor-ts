/**
 * Tuned values for `src/pattern/`.
 *
 * Rule 3 of the constants policy: neither of these is the default of an
 * `XOptionsType` field with an `XOptions.ts` to live in — `retry` takes a
 * plain `RetryOptions` bag and has no options family — and neither is fixed
 * by a codec or an algorithm chosen in the file it came from.  That leaves
 * the subsystem's own `Constants.ts`, which `src/pattern/` did not have while
 * sixteen sibling subsystems did.
 *
 * Both moved out of `Retry.ts` verbatim, JSDoc included.  Neither is on the
 * `pattern` barrel: they were module-private before the move and a relocation
 * is not the moment to widen a surface.
 *
 * Imports nothing from `src/pattern/`, so it cannot take part in a cycle.
 */

/**
 * The largest delay `setTimeout` — the primitive `setTimeoutSleep` in
 * `Retry.ts` picks — can actually represent.  Its argument is coerced to a
 * 32-bit signed integer, and anything larger silently becomes `1`, so an
 * exponential backoff that overflows does not wait longer: it stops waiting
 * altogether and turns into a hot loop against the dependency that is
 * already failing (#771).
 *
 * Clamping is therefore not a cap on what the caller may ask for, it is the
 * direction the failure has to fall in: "waits ~24.9 days" is a
 * misconfiguration an operator can see and fix, "waits 1 ms" looks like the
 * retry working.  It applies to an injected `sleep` too — a delay this large
 * is a bug wherever it is awaited, and making the clamp conditional would
 * make the one path that matters the one no test can observe.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Built-in default for `RetryOptions.maxDelayMs` (#771).
 *
 * The option used to default to `Number.POSITIVE_INFINITY`, on the reasoning
 * that a caller who wants a ceiling asks for one.  What that actually bought
 * was a schedule whose upper bound was {@link MAX_TIMER_DELAY_MS} — a retry
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
