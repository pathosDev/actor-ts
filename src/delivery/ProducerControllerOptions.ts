import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type { ActorRef } from '../ActorRef.js';
import type { Delivery } from './Messages.js';

/** Plain settings-object shape accepted by a {@link ProducerController}. */
export interface ProducerControllerOptionsType<T> {
  readonly consumer: ActorRef<Delivery<T>>;
  /**
   * How long to wait for an Ack before re-sending.  Default 500ms.
   */
  readonly resendTimeout?: number;
  /**
   * Flow-control window: at most `windowSize` messages may be in-flight
   * (un-acked) at any moment.  Additional Sends queue until room opens up.
   * Default: 16.
   */
  readonly windowSize?: number;
  /** Stable identifier used by consumers to dedup across restarts. */
  readonly producerId?: string;
}

/**
 * Fluent builder for {@link ProducerControllerOptionsType}.  The
 * `consumer` ref is required — pass it via {@link withConsumer} before
 * `build()`; the remaining fields default (resend 500 ms, window 16,
 * generated producer id) when left unset.
 *
 *     ProducerControllerOptions.create<Cmd>()
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

  /** How long to wait for an Ack before re-sending, in ms.  Default 500. */
  withResendTimeout(ms: number): this {
    return this.set('resendTimeout', ms);
  }

  /** Flow-control window: max in-flight (un-acked) messages.  Default 16. */
  withWindowSize(size: number): this {
    return this.set('windowSize', size);
  }

  /** Stable identifier used by consumers to dedup across restarts. */
  withProducerId(producerId: string): this {
    return this.set('producerId', producerId);
  }
}

/** Validates resolved {@link ProducerControllerOptionsType} settings. */
export class ProducerControllerOptionsValidator<T> extends OptionsValidator<ProducerControllerOptionsType<T>> {
  constructor() {
    super('ProducerControllerOptions');
  }
  protected rules(_s: Partial<ProducerControllerOptionsType<T>>): void {
    this.positiveNumber('resendTimeout');
    this.positiveInt('windowSize');
  }
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
