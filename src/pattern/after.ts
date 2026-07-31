/**
 * Wait for `delayMs`, then execute `factory()` and return its eventual
 * value.  The delay is cancellable via the returned Promise's `.cancel()`
 * method — useful for building retry/timeout helpers.
 *
 * `factory` is called once after the delay; if you need to re-evaluate on
 * each retry, pass a function that returns a fresh Promise each time.
 */
export interface CancellablePromise<T> extends Promise<T> {
  cancel(): void;
}

export function after<T>(delayMs: number, factory: () => Promise<T>): CancellablePromise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let rejectOuter: ((err: Error) => void) | null = null;

  const wrapped = new Promise<T>((resolve, reject) => {
    rejectOuter = reject;
    timer = setTimeout(() => {
      timer = null;
      if (cancelled) return;
      factory().then(resolve, reject);
    }, delayMs);
  }) as CancellablePromise<T>;

  wrapped.cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (timer) { clearTimeout(timer); timer = null; }
    rejectOuter?.(new Error('after: cancelled'));
  };
  return wrapped;
}
