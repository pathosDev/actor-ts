import { DEFAULT_DISPATCHER_THROUGHPUT, DEFAULT_HYBRID_DISPATCHER_YIELD_UNITS } from './Constants.js';
import { RingBuffer } from './util/RingBuffer.js';

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
 * Wakes actors on the microtask queue, and spends every
 * {@link DEFAULT_HYBRID_DISPATCHER_YIELD_UNITS}-th unit on a macrotask so the
 * event loop still advances.  **This is the default dispatcher.**
 *
 * {@link MicrotaskDispatcher} is the fast half on its own, and unusable on its
 * own: microtasks drain completely before the loop reaches timers or I/O, so
 * two actors volleying re-queue a microtask from inside a microtask forever and
 * nothing else ever runs.  That is not hypothetical — it is the shape of the
 * throttle-resume livelock in #1167.  {@link ImmediateDispatcher} is the fair
 * half, at ~2.4 µs a hop, which an alternating request/response pays per
 * message because there is never a second message in the mailbox to amortise it
 * across.
 *
 * The budget is what joins them.  Consecutive units scheduled as microtasks are
 * counted, and on reaching the budget one unit goes through `setImmediate`
 * instead, resetting the count — so no chain of actor turns can outrun the
 * event loop by more than the budget, and in the worst case this dispatcher
 * behaves exactly like the immediate one rather than like something new.
 *
 * **The count is per dispatcher, not per actor**, because the microtask chain
 * is the union across every actor scheduled here: two cells volleying would
 * each see a count of 1 forever under a per-cell budget, which is exactly the
 * case the budget exists to bound.  The system's default dispatcher is a single
 * shared instance, so the counter sees the whole chain.
 *
 * It counts rather than clocks deliberately: a `performance.now()` per
 * `execute` would put back, on the scheduling path, the same kind of
 * unconditional clock read #411 removed from the receive path.
 */
export class HybridDispatcher implements Dispatcher {
  readonly id = 'hybrid-dispatcher';
  onError?: DispatcherErrorSink;
  /**
   * Units scheduled as microtasks since the last macrotask yield.  Reset when
   * the budget is spent rather than when the loop actually turns: detecting a
   * real turn needs a macrotask of its own, and arming one per burst would cost
   * more than the occasional early yield it saves.
   */
  private microtaskBurst = 0;

  /**
   * Units handed over while a yield is in flight.
   *
   * They exist to keep this dispatcher FIFO, which every other one here is.
   * Without them the yield would reorder: the unit that spends the budget goes
   * on a macrotask, the next arrival starts a fresh burst on a microtask, and
   * microtasks all run before the loop reaches the macrotask — so the later
   * unit overtakes the earlier one, once per budget, forever.  Per-actor
   * ordering would survive that (a cell has at most one unit queued at a time),
   * but *between* actors the turn order would invert at every boundary, and a
   * default scheduler that reorders is how a test starts failing six months
   * later with nobody able to say why.
   */
  private pending: Array<() => void | Promise<void>> = [];
  private yielding = false;

  constructor(public readonly yieldEvery: number = DEFAULT_HYBRID_DISPATCHER_YIELD_UNITS) {}

  execute(task: () => void | Promise<void>): void {
    // A yield is already in flight: queue behind it rather than jumping it.
    if (this.yielding) {
      this.pending.push(task);
      return;
    }
    if (this.microtaskBurst >= this.yieldEvery) {
      this.yielding = true;
      this.pending.push(task);
      const flush = (): void => {
        this.yielding = false;
        this.microtaskBurst = 0;
        const queued = this.pending;
        this.pending = [];
        // Re-entered with a fresh budget and in arrival order.  Re-entrant by
        // construction: if `queued` is longer than one budget, the unit that
        // exhausts it sets `yielding` again and the rest of this very loop
        // lands back in `pending`, still in order, behind the next yield.
        for (const queuedTask of queued) this.execute(queuedTask);
      };
      if (typeof setImmediate === 'function') {
        setImmediate(flush);
      } else {
        setTimeout(flush, 0);
      }
      return;
    }
    this.microtaskBurst++;
    queueMicrotask(() => runSafely(this, task));
  }
}

/**
 * Processes up to `throughput` queued units synchronously before yielding.
 *
 * **A unit is one actor's turn, not one message, and the queue holds units
 * from many actors** — so this batches *across* actors.  The distinction is
 * not pedantry: a cell may have at most one unit queued at a time
 * (`ActorCell.schedule` returns early while it is already processing), so
 * pointing a `ThroughputDispatcher` at a single actor via
 * `ActorOptions.withDispatcher` gives a drain of exactly one unit per tick and
 * no batching whatsoever.  The per-actor batch is a separate knob —
 * `ActorOptions.withThroughput` / `actor-ts.actor.throughput` (#409) — and it
 * is the one that amortises the scheduling round trip for a single busy actor.
 *
 * Reach for this one when *many* actors exchange small messages and the
 * per-tick scheduling overhead across them is what costs; reach for the
 * per-actor budget when one actor is the bottleneck.  Either way a high value
 * starves the event loop, since nothing else runs until the drain yields.
 */
export class ThroughputDispatcher implements Dispatcher {
  readonly id: string;
  onError?: DispatcherErrorSink;
  /**
   * A ring rather than an array for the same reason the mailbox is one
   * (#408): this queue is drained from the front `throughput` times per
   * tick, and `Array.prototype.shift()` reindexes everything still queued.
   * The backlog here is every actor's pending unit, so it is deepest
   * precisely when the system is busiest.
   */
  private readonly queue = new RingBuffer<() => void | Promise<void>>();
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
  Hybrid: (yieldEvery: number = DEFAULT_HYBRID_DISPATCHER_YIELD_UNITS) => new HybridDispatcher(yieldEvery),
  Throughput: (throughput: number = DEFAULT_DISPATCHER_THROUGHPUT) => new ThroughputDispatcher(throughput),
};
