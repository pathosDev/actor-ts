/**
 * Options for {@link ActorContext.throttle} — the per-actor token-bucket
 * gate on user-message processing (#83).  Follows the repo's `XOptions.ts`
 * convention (type / builder / validator / union); the builder is purely
 * ADDITIVE — `context.throttle(...)` still accepts a plain options object
 * exactly as before.
 */
import { OptionsBuilder } from './util/OptionsBuilder.js';
import { OptionsValidator } from './util/OptionsValidator.js';

/**
 * What to do with a user message dequeued while the actor's
 * {@link ActorContext.throttle | throttle} bucket is empty.
 */
export type ThrottleOnExcess =
  /**
   * *(default)* Don't dequeue — pause the message-pump until tokens
   * replenish, then resume normally.  Natural backpressure: the
   * mailbox queues up, every message eventually processes, latency
   * grows under load.
   */
  | 'pause'
  /**
   * Dequeue the message and discard it (with a debug log).  Useful
   * for telemetry-style traffic where staleness is worse than loss.
   */
  | 'drop';

/** Plain options-object shape accepted by {@link ActorContext.throttle}. */
export type ThrottleOptionsType = {
  /**
   * Token-refill rate, tokens per second.  Must be `> 0`.  Pass
   * `Infinity` to remove the throttle entirely — equivalent to
   * {@link ActorContext.cancelThrottle}: an unlimited rate has no
   * bucket, so none is installed.
   */
  readonly qps: number;
  /** Bucket capacity.  Default: `qps` (one second of refill). */
  readonly burst?: number;
  /** What to do when the bucket is empty.  Default: `'pause'`. */
  readonly onExcess?: ThrottleOnExcess;
  /** Time source — pass a deterministic clock for tests.  Default: `Date.now`. */
  readonly now?: () => number;
};

/**
 * Fluent builder for {@link ThrottleOptionsType}:
 *
 *     const throttleOptions = ThrottleOptions.create()
 *       .withQps(10)
 *       .withBurst(2)
 *       .withOnExcess('drop');
 *     this.context.throttle(throttleOptions);
 */
export class ThrottleOptionsBuilder extends OptionsBuilder<ThrottleOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ThrottleOptionsBuilder()`. */
  static create(): ThrottleOptionsBuilder {
    return new ThrottleOptionsBuilder();
  }

  /** Token-refill rate, tokens per second (`> 0`).  `Infinity` removes the throttle. */
  withQps(qps: number): this {
    return this.set('qps', qps);
  }

  /** Bucket capacity.  Default: `qps` (one second of refill). */
  withBurst(burst: number): this {
    return this.set('burst', burst);
  }

  /** What to do when the bucket is empty.  Default: `'pause'`. */
  withOnExcess(onExcess: ThrottleOnExcess): this {
    return this.set('onExcess', onExcess);
  }

  /** Time source — pass a deterministic clock for tests.  Default: `Date.now`. */
  withNow(now: () => number): this {
    return this.set('now', now);
  }
}

/**
 * Validates resolved {@link ThrottleOptionsType} settings.
 *
 * `qps` legitimately admits `Infinity` — the documented "remove the
 * throttle" sentinel — which the generic `positiveNumber` helper rejects
 * (it requires `Number.isFinite`), so its rule is bespoke, the same shape
 * `ConsumerControllerOptionsValidator` uses for its unbounded-map opt-out.
 * `burst` is a real capacity (finite `> 0`); `onExcess` one of the two
 * known modes.  `now` is a callback and is not validated.
 */
export class ThrottleOptionsValidator extends OptionsValidator<ThrottleOptionsType> {
  constructor() {
    super('ThrottleOptions');
  }
  protected rules(s: Partial<ThrottleOptionsType>): void {
    const { qps } = s;
    if (
      qps !== undefined && qps !== Infinity &&
      (typeof qps !== 'number' || !Number.isFinite(qps) || qps <= 0)
    ) {
      this.fail('qps', 'must be a positive finite number or Infinity', qps);
    }
    this.positiveNumber('burst');
    this.oneOf('onExcess', ['pause', 'drop']);
  }
}

/**
 * Accepted input for {@link ActorContext.throttle}: the fluent
 * {@link ThrottleOptionsBuilder} OR a plain {@link ThrottleOptionsType}
 * object.  Non-`Partial` on purpose (unlike the broker/delivery options
 * unions) — `qps` is required and validated nowhere upstream, so
 * `throttle({})` / `throttle({ burst: 2 })` stay compile errors.
 */
export type ThrottleOptions = ThrottleOptionsBuilder | ThrottleOptionsType;
/** Value alias so `ThrottleOptions.create()` / `new ThrottleOptions()` resolve to the builder. */
export const ThrottleOptions = ThrottleOptionsBuilder;
