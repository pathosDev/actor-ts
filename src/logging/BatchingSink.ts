import type { LogLevel } from '../Logger.js';
import { exponentialBackoff } from '../pattern/BackoffPolicy.js';
import type { Cancellable, Scheduler } from '../Scheduler.js';
import {
  resolveDeliveryOptions,
  type DeliveryOptionsType,
  type ResolvedDeliveryOptions,
} from './DeliveryOptions.js';
import type { LogRecord } from './LogRecord.js';
import type { LogSink, LogSinkContext } from './LogSink.js';
import { SinkReporter } from './SinkReporter.js';

/**
 * What a sink throws out of `emitBatch` to say whether the batch is worth
 * trying again.
 *
 * The distinction is the whole point.  A 503 from a restarting collector
 * deserves a retry; a 401 from a wrong API key deserves none, and retrying
 * it five times with backoff only delays the moment somebody notices.
 * `retryAfterMs` carries a server-supplied delay (an HTTP `Retry-After`,
 * say) so a sink honours what it was told instead of guessing.
 *
 * An error that is *not* a `SinkDeliveryError` is treated as retryable:
 * that is what a socket reset or a `fetch` `TypeError` looks like, and
 * those are exactly the failures that pass on their own.
 */
export class SinkDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SinkDeliveryError';
  }
}

/**
 * Base class for every sink that writes somewhere slower than memory: a
 * file, an HTTP endpoint, a socket.
 *
 * Subclasses implement one method — `emitBatch(records)` — and inherit the
 * machinery that is identical for all of them and easy to get subtly
 * wrong: a bounded queue, batching, retry with jittered backoff, drop
 * accounting, and a drain on close.  This is deliberately framework
 * infrastructure rather than a per-sink concern; the alternative is nine
 * sinks with nine slightly different answers to "what happens when the
 * endpoint is down".
 *
 * **Records are never allowed to accumulate without limit.**  When the
 * queue is full something is dropped — the newest by default, the oldest
 * on request — the count is kept, and the loss is reported on the console
 * through a rate limiter.  An unbounded buffer only moves the failure from
 * "some logs were lost" to "the process died", which is strictly worse,
 * and it hides the problem until it is fatal.
 *
 * **`write` returns immediately.**  It appends to the queue and, at most,
 * arms a timer.  The delivery happens on the flush tick, on a full batch,
 * or on `flush()` / `close()`.
 */
export abstract class BatchingSink implements LogSink {
  readonly name: string;
  readonly minLevel: LogLevel;
  protected readonly delivery: ResolvedDeliveryOptions;
  protected readonly reporter: SinkReporter;
  /** System context, once attached — `{}` for a standalone sink. */
  protected context: LogSinkContext = {};

  private readonly queue: LogRecord[] = [];
  private scheduler: Scheduler | undefined;
  private ticker: Cancellable | undefined;
  private fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  /** During the final drain: one attempt per batch, no waiting on backoff. */
  private finalDrain = false;
  private closeRequested: (() => void) | undefined;
  private closeSignal: Promise<void> | undefined;
  private dropped = 0;

  protected constructor(name: string, minLevel: LogLevel, delivery?: DeliveryOptionsType) {
    this.name = name;
    this.minLevel = minLevel;
    this.delivery = resolveDeliveryOptions(delivery);
    this.reporter = new SinkReporter(name);
  }

  /** Records lost so far — queue overflow plus batches that failed for good. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Records waiting to be delivered. */
  get queuedCount(): number {
    return this.queue.length;
  }

  write(record: LogRecord): void {
    if (this.closed) {
      // Nothing would ever drain it.  Counting is the honest answer;
      // queueing would be a slow leak that looks like success.
      this.drop(1, 'sink closed');
      return;
    }
    if (this.queue.length >= this.delivery.queueCapacity) {
      if (this.delivery.overflow === 'drop-new') {
        this.drop(1, 'queue full');
        return;
      }
      this.queue.shift();
      this.drop(1, 'queue full');
    }
    this.queue.push(record);
    if (this.queue.length >= this.delivery.maxBatchSize) {
      // A full batch does not wait for the tick: under load that would add
      // a whole flush interval of latency to every record after the first.
      void this.flush();
      return;
    }
    this.armTicker();
  }

  attach(context: LogSinkContext): void {
    this.context = context;
    this.scheduler = context.scheduler;
    if (this.scheduler !== undefined && this.ticker === undefined) {
      // Through the framework scheduler so `scheduler.shutdown()` clears it
      // — an armed interval otherwise keeps the process alive after the
      // system terminates (#641) — and so `ManualScheduler` can drive it.
      this.ticker = this.scheduler.scheduleAtFixedRateFunction(
        this.delivery.flushIntervalMs,
        this.delivery.flushIntervalMs,
        () => { if (this.queue.length > 0) void this.flush(); },
      );
      this.clearFallbackTimer();
    }
    try {
      this.openTransport?.(context);
    } catch (error) {
      this.reporter.report('transport setup failed', error);
    }
  }

  /**
   * Drain the queue.  Concurrent callers share one drain, and the drain
   * runs until the queue is empty — so a `flush()` that overlaps an
   * in-flight one still resolves only when everything queued is gone.
   */
  flush(): Promise<void> {
    if (this.flushing !== undefined) return this.flushing;
    this.clearFallbackTimer();
    this.flushing = this.drain().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.stopTicker();
    this.closing = this.runClose();
    return this.closing;
  }

  /**
   * Deliver one batch.  Throw {@link SinkDeliveryError} to say whether it
   * is worth retrying; any other throw is treated as retryable.
   */
  protected abstract emitBatch(records: readonly LogRecord[]): Promise<void>;

  /** Optional: acquire a socket, open a file, resolve a runtime module. */
  protected openTransport?(context: LogSinkContext): void | Promise<void>;

  /** Optional: release whatever `openTransport` acquired. */
  protected closeTransport?(): Promise<void>;

  private async runClose(): Promise<void> {
    // Let an in-flight flush finish its current attempt, then stop waiting
    // on backoff: whoever called close is already holding a deadline.
    this.closeRequested?.();
    await this.flushing?.catch(() => {});
    this.finalDrain = true;
    try {
      await this.drain();
    } catch (error) {
      this.reporter.report('final drain failed', error);
    }
    try {
      await this.closeTransport?.();
    } catch (error) {
      this.reporter.report('transport close failed', error);
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      // Closed mid-drain: hand the rest to the final drain rather than
      // keep looping.  `deliver` puts an interrupted batch back on the
      // queue, so continuing here would re-take it and spin.
      if (this.closed && !this.finalDrain) return;
      const batch = this.queue.splice(0, this.delivery.maxBatchSize);
      await this.deliver(batch);
    }
  }

  /**
   * One batch, with retries.  Never throws: a delivery that cannot be
   * completed ends as a counted, reported drop, because the caller is
   * either a timer tick or a shutdown and neither has anywhere to put an
   * exception.
   */
  private async deliver(batch: readonly LogRecord[]): Promise<void> {
    const maxRetries = this.finalDrain ? 0 : this.delivery.maxRetries;
    const backoff = exponentialBackoff({
      minMs: this.delivery.minBackoffMs,
      maxMs: this.delivery.maxBackoffMs,
      randomFactor: this.delivery.randomFactor,
      random: this.delivery.random,
    });

    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.emitBatch(batch);
        return;
      } catch (error) {
        const retryable = error instanceof SinkDeliveryError ? error.retryable : true;
        if (!retryable) {
          this.drop(batch.length, 'delivery rejected', error);
          return;
        }
        if (attempt >= maxRetries) {
          this.drop(batch.length, `delivery failed after ${attempt + 1} attempt(s)`, error);
          return;
        }
        const retryAfterMs = error instanceof SinkDeliveryError ? error.retryAfterMs : undefined;
        await this.pause(retryAfterMs ?? backoff.delayFor(attempt));
        if (this.closed && !this.finalDrain) {
          // Closed while we were waiting: the final drain will take it.
          this.queue.unshift(...batch);
          return;
        }
      }
    }
  }

  /**
   * Wait, but wake early if the sink is closing.  A raw `setTimeout`
   * rather than the scheduler: this also runs during shutdown, when the
   * scheduler is already down, and it is awaited immediately so it cannot
   * outlive the call.
   */
  private pause(delayMs: number): Promise<void> {
    if (this.closeSignal === undefined) {
      this.closeSignal = new Promise<void>((resolve) => { this.closeRequested = resolve; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sleep = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, delayMs);
    });
    return Promise.race([sleep, this.closeSignal]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /**
   * Make sure something will drain the queue.  With a scheduler the fixed
   * ticker already does; without one — a sink used standalone, or before
   * the system attached — arm a single timer for this batch.
   *
   * That timer *is* `unref`'d, unlike the shutdown deadlines: it exists to
   * ship logs eventually, and a program with nothing left to do should be
   * allowed to exit rather than being held open by a logging timer.  The
   * records are not lost — `close()` drains them.
   */
  private armTicker(): void {
    if (this.ticker !== undefined || this.fallbackTimer !== undefined || this.closed) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = undefined;
      if (this.queue.length > 0) void this.flush();
    }, this.delivery.flushIntervalMs);
    (this.fallbackTimer as unknown as { unref?: () => void }).unref?.();
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer === undefined) return;
    clearTimeout(this.fallbackTimer);
    this.fallbackTimer = undefined;
  }

  private stopTicker(): void {
    this.ticker?.cancel();
    this.ticker = undefined;
    this.clearFallbackTimer();
  }

  /**
   * Count a loss and say so, once per reason per minute.
   *
   * The running total goes in the *detail*, never in the reason: the
   * reporter rate-limits per reason string, so a total baked into it would
   * make every message a new key — no throttling at all, and a map entry
   * per dropped record.
   */
  private drop(count: number, reason: string, detail?: unknown): void {
    this.dropped += count;
    const total = `${this.dropped} record(s) lost in total`;
    const cause = detail instanceof Error ? detail.message
      : detail !== undefined ? String(detail)
      : undefined;
    this.reporter.report(reason, cause === undefined ? total : `${cause} (${total})`);
  }
}
