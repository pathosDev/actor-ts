/**
 * A Dispatcher schedules the execution of actor message-processing units.
 * In a single-threaded JS runtime we pick between the microtask queue and
 * setImmediate to balance throughput against fairness with I/O.
 */
export interface Dispatcher {
  readonly id: string;
  /** Schedule a unit of work to be executed asynchronously. */
  execute(fn: () => void | Promise<void>): void;
}

function runSafely(fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((err) => {
        console.error('[actor-ts] unhandled dispatcher error:', err);
      });
    }
  } catch (err) {
    console.error('[actor-ts] unhandled dispatcher error:', err);
  }
}

/**
 * Runs work on the microtask queue. Fastest, but can starve I/O and timers
 * under sustained actor load because microtasks always run before macrotasks.
 */
export class MicrotaskDispatcher implements Dispatcher {
  readonly id = 'microtask-dispatcher';
  execute(fn: () => void | Promise<void>): void {
    queueMicrotask(() => runSafely(fn));
  }
}

/**
 * Runs work via setImmediate (or setTimeout(0) in browsers). Lets I/O and
 * timers interleave between messages, so it is the default.
 */
export class ImmediateDispatcher implements Dispatcher {
  readonly id = 'immediate-dispatcher';
  execute(fn: () => void | Promise<void>): void {
    if (typeof setImmediate === 'function') {
      setImmediate(() => runSafely(fn));
    } else {
      setTimeout(() => runSafely(fn), 0);
    }
  }
}

/**
 * Processes up to `throughput` queued units synchronously before yielding.
 * Useful when actors exchange many small messages and you want less
 * scheduling overhead.  Be aware that you can starve the event loop if
 * throughput is set high.
 */
export class ThroughputDispatcher implements Dispatcher {
  readonly id: string;
  private queue: Array<() => void | Promise<void>> = [];
  private scheduled = false;

  constructor(public readonly throughput: number = 16, id: string = 'throughput-dispatcher') {
    this.id = id;
  }

  execute(fn: () => void | Promise<void>): void {
    this.queue.push(fn);
    if (!this.scheduled) {
      this.scheduled = true;
      if (typeof setImmediate === 'function') {
        setImmediate(() => this.drain());
      } else {
        setTimeout(() => this.drain(), 0);
      }
    }
  }

  private drain(): void {
    this.scheduled = false;
    let processed = 0;
    while (processed < this.throughput && this.queue.length > 0) {
      const fn = this.queue.shift()!;
      runSafely(fn);
      processed++;
    }
    if (this.queue.length > 0) {
      this.scheduled = true;
      if (typeof setImmediate === 'function') {
        setImmediate(() => this.drain());
      } else {
        setTimeout(() => this.drain(), 0);
      }
    }
  }
}

export const Dispatchers = {
  Immediate: () => new ImmediateDispatcher(),
  Microtask: () => new MicrotaskDispatcher(),
  Throughput: (throughput: number = 16) => new ThroughputDispatcher(throughput),
};
