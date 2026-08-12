import type { Config } from '../config/Config.js';
import { OptionsError } from '../util/OptionsValidator.js';
import { sinkLeaf } from './SinkConfig.js';

/**
 * How a {@link BatchingSink} queues, batches, retries and sheds — the
 * settings every sink that talks to a file descriptor or a network
 * endpoint needs, defined once so nine sinks cannot each invent their own
 * spelling of "how many records may pile up".
 *
 * Embedded as a nested `delivery` field on each sink's options, with a
 * matching `delivery { … }` block in HOCON.
 */

/** Built-in default for {@link DeliveryOptionsType.maxBatchSize}. */
export const DEFAULT_DELIVERY_MAX_BATCH_SIZE = 100;
/** Built-in default for {@link DeliveryOptionsType.flushIntervalMs}. */
export const DEFAULT_DELIVERY_FLUSH_INTERVAL_MS = 2_000;
/** Built-in default for {@link DeliveryOptionsType.queueCapacity}. */
export const DEFAULT_DELIVERY_QUEUE_CAPACITY = 10_000;
/** Built-in default for {@link DeliveryOptionsType.overflow}. */
export const DEFAULT_DELIVERY_OVERFLOW: DeliveryOverflow = 'drop-new';
/** Built-in default for {@link DeliveryOptionsType.maxRetries}. */
export const DEFAULT_DELIVERY_MAX_RETRIES = 5;
/** Built-in default for {@link DeliveryOptionsType.minBackoffMs}. */
export const DEFAULT_DELIVERY_MIN_BACKOFF_MS = 1_000;
/** Built-in default for {@link DeliveryOptionsType.maxBackoffMs}. */
export const DEFAULT_DELIVERY_MAX_BACKOFF_MS = 30_000;
/** Built-in default for {@link DeliveryOptionsType.randomFactor}. */
export const DEFAULT_DELIVERY_RANDOM_FACTOR = 0.2;

/**
 * What happens to a record that arrives at a full queue.
 *
 * There is no `'reject'` here, unlike `BoundedMailbox`: a sink never
 * throws into the caller, so refusing loudly is not one of the options.
 * The choice is only *which* record to lose — the newest, or the oldest.
 */
export type DeliveryOverflow = 'drop-new' | 'drop-head';

/** Plain options-object shape for a batching sink's delivery settings. */
export type DeliveryOptionsType = {
  /** Most records in one `emitBatch` call.  Default 100. */
  readonly maxBatchSize?: number;
  /** How often the queue is drained, in milliseconds.  Default 2000. */
  readonly flushIntervalMs?: number;
  /**
   * Most records that may wait in memory.  Default 10 000 — high enough to
   * ride out a restarting collector, low enough that the backlog of a
   * permanently dead one is a bounded cost rather than the reason the
   * process dies.
   */
  readonly queueCapacity?: number;
  /** Which record to lose when the queue is full.  Default `drop-new`. */
  readonly overflow?: DeliveryOverflow;
  /** Retries after the first attempt fails.  Default 5; `0` disables retrying. */
  readonly maxRetries?: number;
  /** First retry delay, doubling per attempt.  Default 1000. */
  readonly minBackoffMs?: number;
  /** Ceiling for the retry delay.  Default 30 000. */
  readonly maxBackoffMs?: number;
  /** Jitter applied to each delay, as a fraction.  Default 0.2 (±20 %). */
  readonly randomFactor?: number;
  /**
   * Override `Math.random` for the jitter — the seam that makes a retry
   * schedule assertable in a test.
   */
  readonly random?: () => number;
};

/** Every delivery setting resolved to a value — what a sink actually runs on. */
export type ResolvedDeliveryOptions = Required<Omit<DeliveryOptionsType, 'random'>> & {
  readonly random: () => number;
};

/** Apply the built-in defaults to whatever the caller set. */
export function resolveDeliveryOptions(delivery: DeliveryOptionsType = {}): ResolvedDeliveryOptions {
  return {
    maxBatchSize: delivery.maxBatchSize ?? DEFAULT_DELIVERY_MAX_BATCH_SIZE,
    flushIntervalMs: delivery.flushIntervalMs ?? DEFAULT_DELIVERY_FLUSH_INTERVAL_MS,
    queueCapacity: delivery.queueCapacity ?? DEFAULT_DELIVERY_QUEUE_CAPACITY,
    overflow: delivery.overflow ?? DEFAULT_DELIVERY_OVERFLOW,
    maxRetries: delivery.maxRetries ?? DEFAULT_DELIVERY_MAX_RETRIES,
    minBackoffMs: delivery.minBackoffMs ?? DEFAULT_DELIVERY_MIN_BACKOFF_MS,
    maxBackoffMs: delivery.maxBackoffMs ?? DEFAULT_DELIVERY_MAX_BACKOFF_MS,
    randomFactor: delivery.randomFactor ?? DEFAULT_DELIVERY_RANDOM_FACTOR,
    random: delivery.random ?? Math.random,
  };
}

/**
 * Validate a sink's nested `delivery` block.
 *
 * A free function rather than an `OptionsValidator` subclass because it
 * checks a *nested* field of someone else's options type: the field-name
 * helpers on the base class are typed against the outer type, and the
 * errors have to name a dotted path (`delivery.maxBatchSize`) so the
 * message points at the block the reader actually wrote.
 */
export function validateDeliveryOptions(optionsName: string, delivery: DeliveryOptionsType | undefined): void {
  if (delivery === undefined) return;
  const fail = (field: string, reason: string, value: unknown): never => {
    throw new OptionsError(
      `${optionsName}: delivery.${field} ${reason} (got ${JSON.stringify(value) ?? String(value)})`,
      optionsName,
      `delivery.${field}`,
      value,
    );
  };
  const positiveInt = (field: keyof DeliveryOptionsType, value: unknown): void => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      fail(field, 'must be an integer >= 1', value);
    }
  };
  const nonNegativeInt = (field: keyof DeliveryOptionsType, value: unknown): void => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      fail(field, 'must be an integer >= 0', value);
    }
  };

  positiveInt('maxBatchSize', delivery.maxBatchSize);
  positiveInt('flushIntervalMs', delivery.flushIntervalMs);
  positiveInt('queueCapacity', delivery.queueCapacity);
  nonNegativeInt('maxRetries', delivery.maxRetries);
  nonNegativeInt('minBackoffMs', delivery.minBackoffMs);
  nonNegativeInt('maxBackoffMs', delivery.maxBackoffMs);
  if (delivery.overflow !== undefined && delivery.overflow !== 'drop-new' && delivery.overflow !== 'drop-head') {
    fail('overflow', 'must be one of drop-new, drop-head', delivery.overflow);
  }
  if (delivery.randomFactor !== undefined
    && (typeof delivery.randomFactor !== 'number' || !(delivery.randomFactor >= 0 && delivery.randomFactor <= 1))) {
    fail('randomFactor', 'must be a number in [0, 1]', delivery.randomFactor);
  }
  if (delivery.minBackoffMs !== undefined && delivery.maxBackoffMs !== undefined
    && delivery.maxBackoffMs < delivery.minBackoffMs) {
    fail('maxBackoffMs', `must be >= delivery.minBackoffMs (${delivery.minBackoffMs})`, delivery.maxBackoffMs);
  }
  if (delivery.maxBatchSize !== undefined && delivery.queueCapacity !== undefined
    && delivery.maxBatchSize > delivery.queueCapacity) {
    // A batch larger than the queue can never be filled, so the sink would
    // only ever flush on the timer — silently ignoring maxBatchSize.
    fail('maxBatchSize', `must be <= delivery.queueCapacity (${delivery.queueCapacity})`, delivery.maxBatchSize);
  }
}

/**
 * Read a `delivery { … }` block from under a sink's config root.  Only
 * keys actually present are returned, so an absent one falls through to
 * the built-in default rather than landing as an explicit `undefined`.
 *
 * `random` has no leaf: it is a test seam, not a tunable.
 */
export function readDeliveryOptionsFromConfig(config: Config, blockRoot: string): DeliveryOptionsType | undefined {
  const root = sinkLeaf(blockRoot, 'delivery');
  const out: { -readonly [K in keyof DeliveryOptionsType]?: DeliveryOptionsType[K] } = {};
  const path = (leaf: string): string => sinkLeaf(root, leaf);
  if (config.hasPath(path('max-batch-size'))) out.maxBatchSize = config.getInt(path('max-batch-size'));
  if (config.hasPath(path('flush-interval'))) out.flushIntervalMs = config.getDuration(path('flush-interval'));
  if (config.hasPath(path('queue-capacity'))) out.queueCapacity = config.getInt(path('queue-capacity'));
  if (config.hasPath(path('overflow'))) out.overflow = config.getString(path('overflow')) as DeliveryOverflow;
  if (config.hasPath(path('max-retries'))) out.maxRetries = config.getInt(path('max-retries'));
  if (config.hasPath(path('min-backoff'))) out.minBackoffMs = config.getDuration(path('min-backoff'));
  if (config.hasPath(path('max-backoff'))) out.maxBackoffMs = config.getDuration(path('max-backoff'));
  // getNumber, not getInt: the jitter factor is a fraction.
  if (config.hasPath(path('random-factor'))) out.randomFactor = config.getNumber(path('random-factor'));
  return Object.keys(out).length > 0 ? out : undefined;
}
