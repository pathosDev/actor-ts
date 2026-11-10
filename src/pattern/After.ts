import { armChainedTimeout, type Cancellable, type Scheduler } from '../Scheduler.js';
import { MAX_TIMER_DELAY_MS } from '../util/Constants.js';

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
 *   test advance past it instead of waiting it out (#1424).  Either way a delay
 *   longer than one host timer holds (~24.9 days) is waited out in full.
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
    // A `Cancellable` when a scheduler or a chain armed it, a host handle otherwise.
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
    if (scheduler !== null) {
      timer = scheduler.scheduleOnceFunction(delayMs, fire);
    } else if (delayMs > MAX_TIMER_DELAY_MS) {
      // `setTimeout` fires a delay past its ceiling early — after 1 ms on Bun
      // and Node, wrapped modulo 2^32 on Deno — so such a delay is a chain of
      // host timers, as a scheduler arms it.  The comparison is all a shorter
      // delay pays.
      timer = armChainedTimeout(fire, delayMs);
    } else {
      timer = setTimeout(fire, delayMs);
    }
  }) as CancellablePromise<T>;

  wrapped.cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    disarm();
    rejectOuter?.(new Error('after: cancelled'));
  };
  return wrapped;
}
