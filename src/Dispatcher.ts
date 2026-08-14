import { DEFAULT_DISPATCHER_THROUGHPUT } from './Constants.js';

/**
 * Where a dispatcher reports a unit of work that threw.
 *
 * A dispatcher cannot reach the system logger on its own: it is
 * constructed by whoever wants one — `ActorSystemOptions.withDispatcher`,
 * `ActorOptions.withDispatcher`, a bare `new ImmediateDispatcher()` in a
 * test — and none of those has a system, let alone a logger.  So the sink
 * is a slot the owner fills in: `ActorSystem` assigns one when it adopts a
 * dispatcher, and everything the framework logs about a failed unit flows
 * through that assignment (#410).
 *
 * `dispatcherId` rather than the dispatcher itself, because the sink is a
 * reporting hook, not a handle: a report must not be able to schedule more
 * work on the queue that just failed.
 */
export type DispatcherErrorSink = (error: unknown, dispatcherId: string) => void;

/**
 * A Dispatcher schedules the execution of actor message-processing units.
 * In a single-threaded JS runtime we pick between the microtask queue and
 * setImmediate to balance throughput against fairness with I/O.
 */
export interface Dispatcher {
  readonly id: string;
  /** Schedule a unit of work to be executed asynchronously. */
  execute(task: () => void | Promise<void>): void;
  /**
   * Where a unit of work that threw is reported.  Optional so a
   * third-party dispatcher stays a two-member implementation: an unset
   * sink falls back to `console.error`, which is what every dispatcher
   * did before the slot existed.
   *
   * `ActorSystem` fills it in with `??=`, so a sink the owner set
   * deliberately survives being handed to a system.
   */
  onError?: DispatcherErrorSink;
}

function runSafely(dispatcher: Dispatcher, task: () => void | Promise<void>): void {
  try {
    const result = task();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((error) => reportDispatcherError(dispatcher, error));
    }
  } catch (error) {
    reportDispatcherError(dispatcher, error);
  }
}

/**
 * Report a failed unit through the dispatcher's sink, or — when nothing
 * wired one, and only then — on the console.
 *
 * The console branch is the documented last resort, not a second channel.
 * It exists because a dispatcher is usable without a system at all, and a
 * failure that reaches nobody is worse than one that reaches a terminal.
 * The sink is called inside its own guard for the same reason: a sink that
 * throws has destroyed the only report of the original error, so the
 * fallback takes over and prints what the sink was handed.  The sink's own
 * failure is printed *after* it — an operator who wired a sink and sees
 * console output anyway is owed the reason, but the original error is
 * still the one nobody else is holding.
 */
function reportDispatcherError(dispatcher: Dispatcher, error: unknown): void {
  const sink = dispatcher.onError;
  if (sink === undefined) {
    console.error('[actor-ts] unhandled dispatcher error:', error);
    return;
  }
  try {
    sink(error, dispatcher.id);
  } catch (sinkFailure) {
    console.error('[actor-ts] unhandled dispatcher error:', error);
    console.error('[actor-ts] the dispatcher error sink failed too:', sinkFailure);
  }
}

/**
 * Runs work on the microtask queue. Fastest, but can starve I/O and timers
 * under sustained actor load because microtasks always run before macrotasks.
 */
export class MicrotaskDispatcher implements Dispatcher {
  readonly id = 'microtask-dispatcher';
  onError?: DispatcherErrorSink;
  execute(task: () => void | Promise<void>): void {
    queueMicrotask(() => runSafely(this, task));
  }
}

/**
 * Runs work via setImmediate (or setTimeout(0) in browsers). Lets I/O and
 * timers interleave between messages, so it is the default.
 */
export class ImmediateDispatcher implements Dispatcher {
  readonly id = 'immediate-dispatcher';
  onError?: DispatcherErrorSink;
  execute(task: () => void | Promise<void>): void {
    if (typeof setImmediate === 'function') {
      setImmediate(() => runSafely(this, task));
    } else {
      setTimeout(() => runSafely(this, task), 0);
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
  onError?: DispatcherErrorSink;
  private queue: Array<() => void | Promise<void>> = [];
  private scheduled = false;

  constructor(
    public readonly throughput: number = DEFAULT_DISPATCHER_THROUGHPUT,
    id: string = 'throughput-dispatcher',
  ) {
    this.id = id;
  }

  execute(task: () => void | Promise<void>): void {
    this.queue.push(task);
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
      const task = this.queue.shift()!;
      runSafely(this, task);
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
  Throughput: (throughput: number = DEFAULT_DISPATCHER_THROUGHPUT) => new ThroughputDispatcher(throughput),
};
