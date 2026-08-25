import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Built-in default for {@link ConsumerControllerOptionsType.maxProducers}. */
export const DEFAULT_MAX_PRODUCERS = 1_024;
/** Built-in default for {@link ConsumerControllerOptionsType.producerIdleTtlMs}. */
export const DEFAULT_PRODUCER_IDLE_TTL_MS = 300_000;

/** Plain options-object shape accepted by a {@link ConsumerController}. */
export type ConsumerControllerOptionsType<T> = {
  /**
   * Invoked for every successfully delivered (un-duplicated) message.  The
   * controller Acks AFTER the handler returns — if the handler returns a
   * Promise, the Acknowledgment is delayed until it settles.
   */
  readonly handler: (body: T) => void | Promise<void>;
  /**
   * Most producers the consumer keeps dedup state for at once.  Default
   * 1 024; `Infinity` opts out of the cap.  Past it the least-recently-used
   * producer's entry is evicted.
   *
   * The map is keyed by a `producerId` the *sender* chooses, and before this
   * bound existed every distinct one ever seen cost a permanent entry (#728).
   * That is a leak with no attacker in it: a `ProducerController` whose caller
   * left `producerId` unset mints a fresh random one per construction, so a
   * long-lived consumer served by short-lived producers accumulates an entry
   * per producer and never sheds one.  From the cluster port the same path is
   * an amplifier — one delivery per key, retained.
   *
   * Eviction is not free, which is why it is reported rather than silent:
   * dropping an entry drops that producer's duplicate suppression, so a
   * retransmit arriving afterwards runs the handler a second time.  This
   * protocol is at-least-once and already permits that; unbounded growth is
   * not something it permits.
   */
  readonly maxProducers?: number;
  /**
   * How long (ms) a producer's dedup entry survives with no delivery from it.
   * Default 300 000 (5 minutes); `Infinity` disables the sweep.
   *
   * {@link maxProducers} alone only reclaims under pressure — a consumer that
   * saw a burst of producers and then went quiet holds every one of them for
   * as long as it lives.  Age is the other half of the budget, and the only
   * one that releases memory while nothing is arriving.
   *
   * Keep it well above the producers' `resendTimeout` (default 500 ms).  An
   * entry dropped while its producer is still retransmitting the same seq
   * costs one duplicate handler invocation, and the default leaves three
   * orders of magnitude of headroom.  The sweep runs on this same interval,
   * so an idle entry is released somewhere between one and two of them.
   */
  readonly producerIdleTtlMs?: number;
};

/**
 * Fluent builder for {@link ConsumerControllerOptionsType}.  The `handler`
 * is required — pass it via {@link withHandler} before `build()`; the
 * resource bounds default (1 024 producers, 5-minute idle TTL) when left
 * unset.
 *
 *     ConsumerControllerOptions.create<Command>()
 *       .withHandler(async (body) => { … })
 *       .withMaxProducers(64);
 */
export class ConsumerControllerOptionsBuilder<T> extends OptionsBuilder<ConsumerControllerOptionsType<T>> {
  /** Start a fresh builder.  Equivalent to `new ConsumerControllerOptionsBuilder<T>()`. */
  static create<T>(): ConsumerControllerOptionsBuilder<T> {
    return new ConsumerControllerOptionsBuilder<T>();
  }

  /** Handler invoked for every delivered (un-duplicated) message.  Required. */
  withHandler(handler: (body: T) => void | Promise<void>): this {
    return this.set('handler', handler);
  }

  /** Cap on producers held in the dedup map.  `Infinity` opts out.  Default 1 024. */
  withMaxProducers(maxProducers: number): this {
    return this.set('maxProducers', maxProducers);
  }

  /** Idle lifetime (ms) of a producer's dedup entry.  `Infinity` disables the sweep.  Default 300 000. */
  withProducerIdleTtlMs(producerIdleTtlMs: number): this {
    return this.set('producerIdleTtlMs', producerIdleTtlMs);
  }
}

/**
 * Validates resolved {@link ConsumerControllerOptionsType} settings.
 *
 * Both bounds legitimately admit `Infinity` (unbounded map / sweep off),
 * which the generic `positiveInt` / `positiveNumber` helpers reject, so the
 * rules are bespoke — the same shape `InMemoryCacheOptionsValidator` uses for
 * the same reason.
 *
 * `handler` is deliberately *not* asserted here.  It is required rather than
 * bounded, and making a missing one fail at construction instead of as an
 * endless silent retransmit loop is #1234, which owns that change on both
 * delivery options types at once.
 */
export class ConsumerControllerOptionsValidator<T> extends OptionsValidator<ConsumerControllerOptionsType<T>> {
  constructor() {
    super('ConsumerControllerOptions');
  }
  protected rules(s: Partial<ConsumerControllerOptionsType<T>>): void {
    const { maxProducers, producerIdleTtlMs } = s;
    if (
      maxProducers !== undefined && maxProducers !== Infinity &&
      (typeof maxProducers !== 'number' || !Number.isInteger(maxProducers) || maxProducers < 1)
    ) {
      this.fail('maxProducers', 'must be a positive integer or Infinity', maxProducers);
    }
    if (
      producerIdleTtlMs !== undefined && producerIdleTtlMs !== Infinity &&
      (typeof producerIdleTtlMs !== 'number' || !Number.isFinite(producerIdleTtlMs) || producerIdleTtlMs <= 0)
    ) {
      this.fail('producerIdleTtlMs', 'must be a positive finite number or Infinity', producerIdleTtlMs);
    }
  }
}

/**
 * Accepted input for a {@link ConsumerController}: the fluent
 * {@link ConsumerControllerOptionsBuilder} OR a plain
 * {@link ConsumerControllerOptionsType} object.
 */
export type ConsumerControllerOptions<T> =
  | ConsumerControllerOptionsBuilder<T>
  | Partial<ConsumerControllerOptionsType<T>>;
/** Value alias so `ConsumerControllerOptions.create()` / `new ConsumerControllerOptions()` resolve to the builder. */
export const ConsumerControllerOptions = ConsumerControllerOptionsBuilder;
