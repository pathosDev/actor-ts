import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { LogLevel } from '../../../src/Logger.js';
import { BatchingSink, SinkDeliveryError } from '../../../src/logging/BatchingSink.js';
import { validateDeliveryOptions, type DeliveryOptionsType } from '../../../src/logging/DeliveryOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import type { LogRecord } from '../../../src/logging/LogRecord.js';

/**
 * A sink whose delivery the test drives: it records the batches it was
 * given and fails on demand, so the queue, batching, retry and drop
 * behaviour can be asserted without a network.
 */
class FakeBatchedSink extends BatchingSink {
  readonly batches: LogRecord[][] = [];
  /** Errors to throw on the next N attempts, consumed one per attempt. */
  readonly failures: unknown[] = [];
  transportOpened = 0;
  transportClosed = 0;
  /** Resolve manually to hold a delivery open. */
  gate: (() => void) | undefined;

  constructor(delivery?: DeliveryOptionsType) {
    super('fake', LogLevel.Debug, delivery);
  }

  protected async emitBatch(records: readonly LogRecord[]): Promise<void> {
    if (this.gate !== undefined) {
      await new Promise<void>((resolve) => { this.gate = resolve; });
    }
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    this.batches.push([...records]);
  }

  protected override openTransport(): void { this.transportOpened += 1; }
  protected override async closeTransport(): Promise<void> { this.transportClosed += 1; }
}

let record: (message: string) => LogRecord;
let consoleErrors: unknown[][] = [];
const originalError = console.error;

beforeEach(() => {
  consoleErrors = [];
  console.error = ((...args: unknown[]) => { consoleErrors.push(args); }) as typeof console.error;
  record = (message) => ({ timestampMs: 1_000, level: LogLevel.Info, message, fields: {} });
});
afterEach(() => { console.error = originalError; });

/** Delivery settings that make retry timing fast enough to assert on. */
const FAST_RETRY: DeliveryOptionsType = { minBackoffMs: 1, maxBackoffMs: 4, randomFactor: 0 };

describe('BatchingSink batching', () => {
  it('queues without delivering until something flushes', async () => {
    const sink = new FakeBatchedSink();
    sink.write(record('a'));
    sink.write(record('b'));

    expect(sink.batches).toHaveLength(0);
    expect(sink.queuedCount).toBe(2);

    await sink.flush();
    expect(sink.batches).toEqual([[record('a'), record('b')]]);
    expect(sink.queuedCount).toBe(0);
  });

  it('splits a drain into batches of maxBatchSize', async () => {
    const sink = new FakeBatchedSink({ maxBatchSize: 2, queueCapacity: 10 });
    // Five records, but a full batch flushes eagerly, so drive it by hand.
    for (const message of ['a', 'b', 'c', 'd', 'e']) sink.write(record(message));
    await sink.flush();

    expect(sink.batches.map((batch) => batch.map((r) => r.message))).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('flushes eagerly on a full batch instead of waiting for the tick', async () => {
    const sink = new FakeBatchedSink({ maxBatchSize: 2, queueCapacity: 10 });
    sink.write(record('a'));
    expect(sink.batches).toHaveLength(0);
    sink.write(record('b'));

    // The write triggered the flush; give the microtask queue a turn.
    await sink.flush();
    expect(sink.batches).toEqual([[record('a'), record('b')]]);
  });

  it('coalesces concurrent flushes into one drain', async () => {
    const sink = new FakeBatchedSink();
    sink.write(record('a'));

    await Promise.all([sink.flush(), sink.flush(), sink.flush()]);

    expect(sink.batches).toHaveLength(1);
  });

  it('drains records enqueued while a flush is in flight', async () => {
    const sink = new FakeBatchedSink();
    sink.gate = () => {};              // hold the first delivery open
    sink.write(record('a'));
    const flushing = sink.flush();
    await Promise.resolve();
    sink.write(record('b'));           // arrives mid-flight
    sink.gate!();
    sink.gate = undefined;
    await flushing;

    expect(sink.batches.flat().map((r) => r.message)).toEqual(['a', 'b']);
  });
});

describe('BatchingSink overflow', () => {
  it('drops the newest record when the queue is full (default)', async () => {
    const sink = new FakeBatchedSink({ queueCapacity: 2, maxBatchSize: 2 });
    // Hold the delivery open, otherwise the eager flush keeps emptying the
    // queue and it never reaches capacity.
    sink.gate = () => {};
    sink.write(record('a'));
    const flushing = sink.flush();
    await Promise.resolve();
    sink.write(record('b'));
    sink.write(record('c'));
    sink.write(record('d'));           // queue is full — dropped
    sink.gate!();
    sink.gate = undefined;
    await flushing;

    expect(sink.batches.flat().map((r) => r.message)).toEqual(['a', 'b', 'c']);
    expect(sink.droppedCount).toBe(1);
  });

  it('drops the oldest record with drop-head', async () => {
    const sink = new FakeBatchedSink({ queueCapacity: 2, maxBatchSize: 2, overflow: 'drop-head' });
    sink.gate = () => {};
    sink.write(record('a'));
    const flushing = sink.flush();
    await Promise.resolve();
    sink.write(record('b'));
    sink.write(record('c'));
    sink.write(record('d'));           // pushes 'b' out
    sink.gate!();
    sink.gate = undefined;
    await flushing;

    expect(sink.batches.flat().map((r) => r.message)).toEqual(['a', 'c', 'd']);
    expect(sink.droppedCount).toBe(1);
  });

  it('reports overflow once per interval, not once per record', () => {
    const sink = new FakeBatchedSink({ queueCapacity: 1, maxBatchSize: 1 });
    sink.gate = () => {};
    sink.write(record('a'));
    for (let i = 0; i < 100; i += 1) sink.write(record(`overflow-${i}`));

    expect(sink.droppedCount).toBeGreaterThan(50);
    expect(consoleErrors).toHaveLength(1);
    expect(String(consoleErrors[0]?.[0])).toContain('queue full');
    expect(String(consoleErrors[0]?.[0])).toContain('lost in total');
  });

  it('drops writes that arrive after close', async () => {
    const sink = new FakeBatchedSink();
    await sink.close();
    sink.write(record('too late'));

    expect(sink.droppedCount).toBe(1);
    expect(sink.queuedCount).toBe(0);
  });
});

describe('BatchingSink retry', () => {
  it('retries a retryable failure and succeeds', async () => {
    const sink = new FakeBatchedSink(FAST_RETRY);
    sink.failures.push(new SinkDeliveryError('503', true));
    sink.write(record('a'));

    await sink.flush();

    expect(sink.batches).toHaveLength(1);
    expect(sink.droppedCount).toBe(0);
  });

  it('treats an unknown error as retryable — that is what a socket reset looks like', async () => {
    const sink = new FakeBatchedSink(FAST_RETRY);
    sink.failures.push(new TypeError('fetch failed'));
    sink.write(record('a'));

    await sink.flush();

    expect(sink.batches).toHaveLength(1);
  });

  it('drops a non-retryable failure immediately', async () => {
    const sink = new FakeBatchedSink(FAST_RETRY);
    sink.failures.push(new SinkDeliveryError('401 unauthorized', false));
    sink.failures.push(new SinkDeliveryError('should not be reached', false));
    sink.write(record('a'));

    await sink.flush();

    expect(sink.batches).toHaveLength(0);
    expect(sink.droppedCount).toBe(1);
    // The second failure was never consumed — there was only one attempt.
    expect(sink.failures).toHaveLength(1);
    expect(String(consoleErrors[0]?.[0])).toContain('delivery rejected');
  });

  it('gives up after maxRetries and counts the loss', async () => {
    const sink = new FakeBatchedSink({ ...FAST_RETRY, maxRetries: 2 });
    for (let i = 0; i < 5; i += 1) sink.failures.push(new SinkDeliveryError('503', true));
    sink.write(record('a'));

    await sink.flush();

    expect(sink.batches).toHaveLength(0);
    expect(sink.droppedCount).toBe(1);
    // One initial attempt plus two retries consumed three failures.
    expect(sink.failures).toHaveLength(2);
    expect(String(consoleErrors[0]?.[0])).toContain('delivery failed after 3 attempt(s)');
  });

  it('honours a server-supplied retry delay', async () => {
    const sink = new FakeBatchedSink({ ...FAST_RETRY, minBackoffMs: 10_000, maxBackoffMs: 10_000 });
    sink.failures.push(new SinkDeliveryError('429', true, 5));
    sink.write(record('a'));

    const startedAt = Date.now();
    await sink.flush();

    // The 5 ms Retry-After won over the 10 s backoff.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(sink.batches).toHaveLength(1);
  });

  it('follows the configured backoff schedule with jitter disabled', async () => {
    const delays: number[] = [];
    const sink = new FakeBatchedSink({ minBackoffMs: 2, maxBackoffMs: 8, randomFactor: 0, maxRetries: 3 });
    for (let i = 0; i < 3; i += 1) sink.failures.push(new SinkDeliveryError('503', true));
    sink.write(record('a'));

    let previous = Date.now();
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      if (ms !== undefined) delays.push(ms);
      return originalTimeout(handler, ms);
    }) as typeof globalThis.setTimeout;
    try {
      await sink.flush();
    } finally {
      globalThis.setTimeout = originalTimeout;
      previous = Date.now();
    }

    // min × 2^attempt, clamped at max: 2, 4, 8.
    expect(delays).toEqual([2, 4, 8]);
    expect(previous).toBeGreaterThan(0);
  });
});

describe('BatchingSink lifecycle', () => {
  it('ticks on the system scheduler once attached', async () => {
    const scheduler = new ManualScheduler();
    const sink = new FakeBatchedSink({ flushIntervalMs: 500 });
    sink.attach({ scheduler, systemName: 'app' });
    sink.write(record('a'));

    expect(sink.batches).toHaveLength(0);
    scheduler.advance(499);
    expect(sink.batches).toHaveLength(0);

    scheduler.advance(1);
    await sink.flush();
    expect(sink.batches.flat().map((r) => r.message)).toEqual(['a']);
  });

  it('keeps ticking for later batches', async () => {
    const scheduler = new ManualScheduler();
    const sink = new FakeBatchedSink({ flushIntervalMs: 100 });
    sink.attach({ scheduler });

    sink.write(record('a'));
    scheduler.advance(100);
    await sink.flush();
    sink.write(record('b'));
    scheduler.advance(100);
    await sink.flush();

    expect(sink.batches.flat().map((r) => r.message)).toEqual(['a', 'b']);
  });

  it('opens the transport on attach and closes it on close', async () => {
    const sink = new FakeBatchedSink();
    sink.attach({ systemName: 'app' });
    expect(sink.transportOpened).toBe(1);

    await sink.close();
    expect(sink.transportClosed).toBe(1);
  });

  it('drains what is queued when it closes', async () => {
    const sink = new FakeBatchedSink();
    sink.write(record('a'));
    sink.write(record('b'));

    await sink.close();

    expect(sink.batches.flat().map((r) => r.message)).toEqual(['a', 'b']);
  });

  it('is idempotent on close', async () => {
    const sink = new FakeBatchedSink();
    await Promise.all([sink.close(), sink.close()]);
    await sink.close();

    expect(sink.transportClosed).toBe(1);
  });

  it('does not retry during the final drain', async () => {
    const sink = new FakeBatchedSink({ ...FAST_RETRY, maxRetries: 5 });
    for (let i = 0; i < 5; i += 1) sink.failures.push(new SinkDeliveryError('503', true));
    sink.write(record('a'));

    await sink.close();

    // A shutdown drain gets one attempt: whoever is closing holds a deadline.
    expect(sink.failures).toHaveLength(4);
    expect(sink.droppedCount).toBe(1);
  });

  it('stops the scheduler ticker on close', async () => {
    const scheduler = new ManualScheduler();
    const sink = new FakeBatchedSink({ flushIntervalMs: 100 });
    sink.attach({ scheduler });
    await sink.close();

    sink.write(record('after close'));
    scheduler.advance(1_000);

    expect(sink.batches).toHaveLength(0);
    expect(sink.droppedCount).toBe(1);
  });

  it('flushes an unattached sink on its own timer', async () => {
    const sink = new FakeBatchedSink({ flushIntervalMs: 5 });
    sink.write(record('a'));

    // The elapsed time IS the assertion: 40 ms outlasts the 5 ms flush interval
    // several times over, which is what makes the sink's own timer the only
    // possible cause of the batch.  A poll on "one batch so far" would leave the
    // exact-array assertion below unable to see a second one.
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(sink.batches.flat().map((r) => r.message)).toEqual(['a']);
  });

  it('wakes out of a backoff when asked to close', async () => {
    const sink = new FakeBatchedSink({ minBackoffMs: 5_000, maxBackoffMs: 5_000, randomFactor: 0 });
    sink.failures.push(new SinkDeliveryError('503', true));
    sink.write(record('a'));
    void sink.flush();
    await Promise.resolve();

    const startedAt = Date.now();
    await sink.close();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // The interrupted batch was handed to the final drain, which retried once.
    expect(sink.batches.flat().map((r) => r.message)).toEqual(['a']);
  });
});

describe('validateDeliveryOptions', () => {
  it('accepts an absent block', () => {
    expect(() => validateDeliveryOptions('FileSinkOptions', undefined)).not.toThrow();
  });

  it('names the dotted path of the offending field', () => {
    expect(() => validateDeliveryOptions('FileSinkOptions', { maxBatchSize: 0 }))
      .toThrow(/delivery\.maxBatchSize must be an integer >= 1/);
  });

  it('rejects an unknown overflow policy', () => {
    expect(() => validateDeliveryOptions('FileSinkOptions', { overflow: 'reject' as 'drop-new' }))
      .toThrow(OptionsError);
  });

  it('rejects a backoff ceiling below the floor', () => {
    expect(() => validateDeliveryOptions('FileSinkOptions', { minBackoffMs: 1_000, maxBackoffMs: 500 }))
      .toThrow(/delivery\.maxBackoffMs must be >= delivery\.minBackoffMs/);
  });

  it('rejects a batch larger than the queue it is drawn from', () => {
    expect(() => validateDeliveryOptions('FileSinkOptions', { maxBatchSize: 100, queueCapacity: 10 }))
      .toThrow(/delivery\.maxBatchSize must be <= delivery\.queueCapacity/);
  });

  it('rejects a jitter factor outside [0, 1]', () => {
    expect(() => validateDeliveryOptions('FileSinkOptions', { randomFactor: 1.5 })).toThrow(OptionsError);
  });
});
