import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import type { Config } from '../config/Config.js';
import type { ActorRef } from '../ActorRef.js';
import type { Delivery } from './Messages.js';
import { MAX_DELIVERY_IDENTIFIER_LENGTH } from './Constants.js';

/** Built-in default for {@link ProducerControllerOptionsType.resendTimeout}. */
export const DEFAULT_RESEND_TIMEOUT_MS = 500;
/** Built-in default for {@link ProducerControllerOptionsType.windowSize}. */
export const DEFAULT_WINDOW_SIZE = 16;

/** Plain options-object shape accepted by a {@link ProducerController}. */
export type ProducerControllerOptionsType<T> = {
  readonly consumer: ActorRef<Delivery<T>>;
  /**
   * How long to wait for an Acknowledgment before re-sending.  Default
   * {@link DEFAULT_RESEND_TIMEOUT_MS} (500 ms).
   */
  readonly resendTimeout?: number;
  /**
   * Flow-control window: at most `windowSize` messages may be in-flight
   * (un-acked) at any moment.  Additional Sends queue until room opens up.
   * Default {@link DEFAULT_WINDOW_SIZE} (16).
   */
  readonly windowSize?: number;
  /**
   * Stable identifier the consumer keys its dedup state on.  Generated when
   * omitted — randomly, and freshly per construction, so leaving it unset
   * means there is no identity to be stable *about*: pin it whenever anything
   * downstream is supposed to recognise this producer across a restart.
   *
   * The generated form is deliberately not derivable from anything else.  An
   * id that a peer can enumerate is half of the `(producerId, seq)` pair an
   * `Acknowledgment` carries (#730), and a shared one silently corrupts the
   * consumer's dedup window when two producers that both left this unset
   * reach the same consumer.
   *
   * It deliberately does **not** carry a dedup *window* across a producer
   * restart.  Each incarnation of the controller stamps its own token onto
   * every delivery, and the consumer resets the window when that token
   * changes — which is what stops a restarted producer's messages being
   * absorbed as duplicates (#726).  What a stable id buys is that two
   * distinct producers stay distinguishable, and that a recovered producer
   * keeps one identity in logs, metrics and the consumer's map.
   */
  readonly producerId?: string;
};

/**
 * Fluent builder for {@link ProducerControllerOptionsType}.  The
 * `consumer` ref is required — pass it via {@link withConsumer} before
 * `build()`; the remaining fields default (resend 500 ms, window 16,
 * generated producer id) when left unset.
 *
 *     ProducerControllerOptions.create<Command>()
 *       .withConsumer(consumerRef)
 *       .withWindowSize(32);
 */
export class ProducerControllerOptionsBuilder<T> extends OptionsBuilder<ProducerControllerOptionsType<T>> {
  /** Start a fresh builder.  Equivalent to `new ProducerControllerOptionsBuilder<T>()`. */
  static create<T>(): ProducerControllerOptionsBuilder<T> {
    return new ProducerControllerOptionsBuilder<T>();
  }

  /** Consumer that receives the deliveries and Acks back.  Required. */
  withConsumer(consumer: ActorRef<Delivery<T>>): this {
    return this.set('consumer', consumer);
  }

  /** How long to wait for an Acknowledgment before re-sending, in ms.  Default 500. */
  withResendTimeout(ms: number): this {
    return this.set('resendTimeout', ms);
  }

  /** Flow-control window: max in-flight (un-acked) messages.  Default 16. */
  withWindowSize(size: number): this {
    return this.set('windowSize', size);
  }

  /** Stable identifier the consumer keys its dedup state on.  Generated when omitted. */
  withProducerId(producerId: string): this {
    return this.set('producerId', producerId);
  }
}

/** Validates resolved {@link ProducerControllerOptionsType} settings. */
export class ProducerControllerOptionsValidator<T> extends OptionsValidator<ProducerControllerOptionsType<T>> {
  constructor() {
    super('ProducerControllerOptions');
  }
  protected rules(s: Partial<ProducerControllerOptionsType<T>>): void {
    this.positiveNumber('resendTimeout');
    this.positiveInt('windowSize');
    this.nonEmptyString('producerId');
    // The consumer refuses an identifier longer than this, so accepting one
    // here would turn every delivery into a silent dead letter.  A cap is
    // only useful where it fails loudly, and that is at construction.
    if (s.producerId !== undefined && s.producerId.length > MAX_DELIVERY_IDENTIFIER_LENGTH) {
      this.fail(
        'producerId',
        `must be at most ${MAX_DELIVERY_IDENTIFIER_LENGTH} characters`,
        s.producerId.length,
      );
    }
  }
}

/**
 * Read `actor-ts.reliable-delivery.producer.*` into the shape
 * {@link ReliableDelivery.producer} layers under the caller's options.  Only
 * keys actually present are returned, so an absent one falls through to the
 * built-in default instead of landing as an explicit `undefined` — the rule
 * `mergeOptions` encodes.
 *
 * The return type deliberately drops the generic.  `consumer` and
 * `producerId` have no leaf — the first is an actor reference HOCON cannot
 * express, the second is per-producer identity that one shared leaf would
 * corrupt (see {@link ProducerControllerOptionsType.producerId}) — and those
 * two are the only reason the options type is generic at all.  Picking the
 * two tunables off `<never>` gives a plain `{ resendTimeout?, windowSize? }`
 * that composes with any `T` at the merge site.
 */
export function readProducerControllerOptionsFromConfig(
  config: Config,
): Partial<Pick<ProducerControllerOptionsType<never>, 'resendTimeout' | 'windowSize'>> {
  const keys = ConfigKeys.reliableDelivery.producer;
  const out: { -readonly [K in 'resendTimeout' | 'windowSize']?: number } = {};
  if (config.hasPath(keys.resendTimeout)) out.resendTimeout = config.getDuration(keys.resendTimeout);
  if (config.hasPath(keys.windowSize)) out.windowSize = config.getInt(keys.windowSize);
  return out;
}

/**
 * Accepted input for a {@link ProducerController}: the fluent
 * {@link ProducerControllerOptionsBuilder} OR a plain
 * {@link ProducerControllerOptionsType} object.
 */
export type ProducerControllerOptions<T> =
  | ProducerControllerOptionsBuilder<T>
  | Partial<ProducerControllerOptionsType<T>>;
/** Value alias so `ProducerControllerOptions.create()` / `new ProducerControllerOptions()` resolve to the builder. */
export const ProducerControllerOptions = ProducerControllerOptionsBuilder;
