import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { Config } from '../config/Config.js';

/** Built-in default for {@link ConsumerControllerOptionsType.maxProducers}. */
export const DEFAULT_MAX_PRODUCERS = 1_024;
/** Built-in default for {@link ConsumerControllerOptionsType.producerIdleTtlMs}. */
export const DEFAULT_PRODUCER_IDLE_TTL_MS = 300_000;
/**
 * Built-in default for {@link ConsumerControllerOptionsType.maxOutOfOrder}.
 *
 * **A producer's window does not hold it back here, and the first version of
 * this note said it did.**  The claim was that a `ProducerController` holds at
 * most `windowSize` sends in flight (default 16) and dispatches from its queue
 * only once an acknowledgment frees a slot, so the most it can push past an
 * open gap is `windowSize - 1` — which would put 1 024 out of a stock
 * producer's reach entirely.  The premise ignores the last line of
 * `ConsumerController.handleDelivery`: an out-of-order delivery that is
 * *admitted* is also acknowledged, which frees the very slot that was supposed
 * to hold the producer back, so the stream keeps flowing past a gap that is
 * still open.  Measured on a stock producer — `tests/unit/delivery`, "a stock
 * producer runs past an open gap by its send count" — 64 sends past one
 * withheld sequence retained 63, not 15.  The set grows with what the caller
 * hands the producer, and this cap is the only thing that stops it.
 *
 * **1 024 stays, on the reason that survives.**  A gap closes within one
 * `resendTimeout` (default 500 ms) of whatever opened it clearing, because the
 * missing sequence is itself in the producer's window and is retransmitted on
 * that timer.  So a *transient* gap fills 1 024 slots only at roughly two
 * thousand sends a second and above, and a gap whose cause does not clear
 * fills them at any rate — in both cases the stall at the cap is the
 * backpressure this option exists to apply, not an accident, and it lifts the
 * moment the missing sequence lands.  Lowering the number would only move that
 * stall earlier for no gain in the bound it already gives; raising it buys a
 * longer run past a gap at a proportional cost in retained memory.
 *
 * The *floor* is a different quantity, and is what a caller with an unusual
 * window has to respect: a producer whose `windowSize` exceeds this cap stalls
 * on its very first gap with nothing queued at all, because that many sends
 * are already in flight when the gap opens.  1 024 leaves room for any window
 * a caller would plausibly configure.
 *
 * It is also {@link DEFAULT_MAX_PRODUCERS}, so the two halves of the dedup
 * budget read as one number: at most 1 024 producers × 1 024 retained
 * sequences, against a set that had no bound at all (#728).
 */
export const DEFAULT_MAX_OUT_OF_ORDER = 1_024;

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
  /**
   * Most out-of-order sequence numbers the consumer retains for one producer
   * while a gap in that producer's sequence stays open.  Default 1 024;
   * `Infinity` opts out of the cap.  At the cap a delivery that would grow
   * the set further is neither handled nor acknowledged, so the producer's
   * own window stalls until the gap closes.
   *
   * `contiguous` only advances when the missing predecessor arrives, so every
   * sequence above an open gap is retained one by one — and from a sender who
   * simply never sends that predecessor, without any limit at all before this
   * bound (#728).  {@link maxProducers} does not cover it transitively: that
   * bounds how many such sets exist, not the size of one, and the idle sweep
   * never reaches an actively flooding producer because every admitted
   * delivery re-stamps its timestamp.
   *
   * **Refusing is deliberately not dropping.**  Evicting the oldest retained
   * sequence would bound the same heap, and would cost a duplicate handler
   * invocation for a message this consumer had already handled *and*
   * acknowledged — a duplicate the sender has no way to see coming.  A stall
   * is visible, is what the producer's retransmit already recovers from, and
   * keeps the protocol's "no silent drop of a message" property true.  It
   * cannot deadlock either: the sequence that closes the gap is itself in the
   * producer's in-flight window and is being retransmitted, and a delivery
   * that would slide `contiguous` is admitted at the cap for exactly that
   * reason.
   *
   * Raising it costs retained memory per producer; lowering it stalls a
   * producer sooner under packet loss.  Keeping it above the largest
   * `windowSize` any producer talking to this consumer is configured with is a
   * **floor, not a bound**: that many sends are already in flight when a gap
   * opens, so a smaller cap stalls that producer on its first gap with nothing
   * queued behind it.  It does not make a larger cap unreachable — a producer
   * with any window at all runs past this one given enough traffic through an
   * open gap, because every out-of-order delivery admitted here is
   * acknowledged and frees the slot that would otherwise hold it back.  See
   * {@link DEFAULT_MAX_OUT_OF_ORDER} for how the default is sized against that.
   */
  readonly maxOutOfOrder?: number;
};

/**
 * Fluent builder for {@link ConsumerControllerOptionsType}.  The `handler`
 * is required — pass it via {@link withHandler} before `build()`; the
 * resource bounds default (1 024 producers, 5-minute idle TTL, 1 024 retained
 * out-of-order sequences per producer) when left unset.
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

  /** Cap on out-of-order seqs retained per producer.  `Infinity` opts out.  Default 1 024. */
  withMaxOutOfOrder(maxOutOfOrder: number): this {
    return this.set('maxOutOfOrder', maxOutOfOrder);
  }
}

/**
 * Validates resolved {@link ConsumerControllerOptionsType} settings.
 *
 * All three bounds legitimately admit `Infinity` (unbounded map / sweep off /
 * unbounded out-of-order window), which the generic `positiveInt` /
 * `positiveNumber` helpers reject, so the rules are bespoke — the same shape
 * `InMemoryCacheOptionsValidator` uses for the same reason.
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
    const { maxProducers, producerIdleTtlMs, maxOutOfOrder } = s;
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
    if (
      maxOutOfOrder !== undefined && maxOutOfOrder !== Infinity &&
      (typeof maxOutOfOrder !== 'number' || !Number.isInteger(maxOutOfOrder) || maxOutOfOrder < 1)
    ) {
      this.fail('maxOutOfOrder', 'must be a positive integer or Infinity', maxOutOfOrder);
    }
  }
}

/**
 * `0` is how this block spells "no bound", because `Infinity` — the opt-out
 * both fields document — is not writable in HOCON at all: `getInt` accepts
 * only a number or a `/^-?\d+(\.\d+)?$/` string, and `parseDuration` throws
 * outright on a non-finite one.  `0` is also what the rest of the reference
 * config already uses for it (`cluster.max-members`, `cluster.max-tombstones`,
 * `sharding.max-entities`), so an operator meets one spelling rather than two.
 *
 * Nothing else in either field's range collides: a cap of zero producers and
 * a zero-millisecond idle lifetime are both states the validator rejects, so
 * the sentinel costs no reachable configuration.
 */
const unboundedWhenZero = (value: number): number => (value === 0 ? Infinity : value);

/**
 * Read `actor-ts.reliable-delivery.consumer.*` into the shape
 * {@link ReliableDelivery.consumer} layers under the caller's options.  Only
 * keys actually present are returned, so an absent one falls through to the
 * built-in default instead of landing as an explicit `undefined` — the rule
 * `mergeOptions` encodes.
 *
 * `handler` has no leaf: it is a function, which HOCON cannot express, and it
 * is the one required field rather than a tunable.  `maxOutOfOrder` has none
 * either — it is a per-producer retention bound whose sibling keys landed
 * after this block was specified, and it is tracked as its own follow-up
 * rather than shipped unspecified.
 *
 * The return type drops the generic for the same reason the producer's does:
 * `handler` is what makes the options type generic, and it is not read here.
 */
export function readConsumerControllerOptionsFromConfig(
  config: Config,
): Partial<Pick<ConsumerControllerOptionsType<never>, 'maxProducers' | 'producerIdleTtlMs'>> {
  const keys = ConfigKeys.reliableDelivery.consumer;
  const out: { -readonly [K in 'maxProducers' | 'producerIdleTtlMs']?: number } = {};
  if (config.hasPath(keys.maxProducers)) {
    out.maxProducers = unboundedWhenZero(config.getInt(keys.maxProducers));
  }
  if (config.hasPath(keys.producerIdleTimeToLive)) {
    out.producerIdleTtlMs = unboundedWhenZero(config.getDuration(keys.producerIdleTimeToLive));
  }
  return out;
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
