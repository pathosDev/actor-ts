import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { ActorRef } from '../ActorRef.js';
import type { Delivery } from './Messages.js';
import type { ProducerControllerSettings } from './ProducerController.js';

/**
 * Fluent builder for {@link ProducerControllerSettings}.  The
 * `consumer` ref is required — pass it via {@link withConsumer} before
 * `build()`; the remaining fields default (resend 500 ms, window 16,
 * generated producer id) when left unset.
 *
 *     ProducerControllerOptions.create<Cmd>()
 *       .withConsumer(consumerRef)
 *       .withWindowSize(32);
 */
export class ProducerControllerOptions<T> extends OptionsBuilder<ProducerControllerSettings<T>> {
  /** Start a fresh builder.  Equivalent to `new ProducerControllerOptions<T>()`. */
  static create<T>(): ProducerControllerOptions<T> {
    return new ProducerControllerOptions<T>();
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
