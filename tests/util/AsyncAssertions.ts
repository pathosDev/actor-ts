/**
 * Async-test helpers — focused on diagnostic-quality of timeouts.
 *
 * Bun's `test()` has its own per-test timeout (default 5s), but when
 * it fires the failure message is "test timed out after 5000ms".
 * That tells you NOTHING about what step was slow.  These helpers
 * carry a `label` so the failure pinpoints the awaited operation.
 */

/**
 * Await `promise` with a bounded timeout.  On timeout, rejects with
 * a descriptive `Error` that names `label` and how long was waited.
 *
 *   const reply = await assertCompletesWithin(
 *     actor.ask(GetState),
 *     500,
 *     'GetState should complete fast',
 *   );
 *
 * On timeout (the inner Promise didn't settle in `ms` ms), throws:
 *
 *   Error: GetState should complete fast: did not complete within
 *   500ms (waited 502ms)
 */
export async function assertCompletesWithin<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`assertCompletesWithin: ms must be a positive finite number, got ${ms}`);
  }
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            `${label}: did not complete within ${ms}ms ` +
            `(waited ${(performance.now() - start).toFixed(0)}ms)`,
          ));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Inverse of `assertCompletesWithin` — assert the promise does NOT
 * resolve within `ms`.  Useful for "this should block" tests
 * (backpressure, mutex, etc.).
 *
 *   await assertDoesNotCompleteWithin(
 *     queue.offer(value),
 *     100,
 *     'offer should block while buffer full',
 *   );
 *
 * If the promise resolves before `ms` elapses, throws.  If it
 * doesn't, returns normally after `ms`.
 */
export async function assertDoesNotCompleteWithin<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`assertDoesNotCompleteWithin: ms must be a positive finite number, got ${ms}`);
  }
  const start = performance.now();
  // Whichever resolves first decides the outcome.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settledEarly = false;
  let earlyValue: T | undefined;
  await Promise.race([
    promise.then(
      (v) => { settledEarly = true; earlyValue = v; },
      () => { settledEarly = true; },  // rejection counts as "completed early"
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (settledEarly) {
    const elapsed = (performance.now() - start).toFixed(0);
    throw new Error(
      `${label}: settled within ${elapsed}ms (expected to not complete within ${ms}ms)` +
      (earlyValue !== undefined ? ` — settled with: ${String(earlyValue)}` : ''),
    );
  }
}
