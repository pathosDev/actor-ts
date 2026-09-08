import type { Cancellable, Scheduler } from '../Scheduler.js';

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

/**
 * @param scheduler Where the delay is armed.  Omitted, a host timer is used and
 *   the delay is real; pass `system.scheduler` and a `ManualScheduler` lets a
 *   test advance past it instead of waiting it out (#1424).
 */
export function after<T>(
  delayMs: number,
  factory: () => Promise<T>,
  scheduler: Scheduler | null = null,
): CancellablePromise<T> {
  let timer: Cancellable | ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let rejectOuter: ((err: Error) => void) | null = null;

  const disarm = (): void => {
    if (timer === null) return;
    // A `Cancellable` when a scheduler armed it, a host handle otherwise.
    if (typeof (timer as Cancellable).cancel === 'function') (timer as Cancellable).cancel();
    else clearTimeout(timer as ReturnType<typeof setTimeout>);
    timer = null;
  };

  const wrapped = new Promise<T>((resolve, reject) => {
    rejectOuter = reject;
    const fire = (): void => {
      timer = null;
      if (cancelled) return;
      factory().then(resolve, reject);
    };
    timer = scheduler === null
      ? setTimeout(fire, delayMs)
      : scheduler.scheduleOnceFunction(delayMs, fire);
  }) as CancellablePromise<T>;

  wrapped.cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    disarm();
    rejectOuter?.(new Error('after: cancelled'));
  };
  return wrapped;
}
