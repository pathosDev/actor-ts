import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { Props } from '../Props.js';
import {
  ConsumerController,
  type ConsumerControllerSettings,
} from './ConsumerController.js';
import type { ConfirmationCallback, Delivery } from './Messages.js';
import {
  ProducerController,
  type ProducerControllerSettings,
  type ProducerSend,
} from './ProducerController.js';
import type { ProducerControllerOptions } from './ProducerControllerOptions.js';

/**
 * Handle returned to the publishing user code.  `tell` enqueues a message
 * for reliable delivery; an optional `confirm` callback fires once the
 * consumer has Acked (or on producer shutdown with an Error).
 */
export interface ProducerHandle<T> {
  tell(body: T, confirm?: ConfirmationCallback): void;
  /** Underlying actor ref — mostly for testing / inspection. */
  readonly ref: ActorRef<ProducerSend<T>>;
  stop(): void;
}

export interface ConsumerHandle {
  readonly ref: ActorRef<Delivery<unknown>>;
  stop(): void;
}

/**
 * Point-to-point at-least-once delivery between a Producer and a Consumer.
 * Messages are assigned monotonic sequence numbers; the consumer Acks back
 * after handling, the producer retries on timeout, and duplicates are
 * silently absorbed on the consumer side.
 *
 * For work-pulling (multiple consumers, one producer) see the WorkPulling
 * companion (follow-up feature).
 */
export class ReliableDelivery {
  /** Spawn a ConsumerController — pass the returned ref to a ProducerController. */
  static consumer<T>(
    system: ActorSystem,
    settings: ConsumerControllerSettings<T>,
    name?: string,
  ): ConsumerHandle {
    const ref = system.spawn(
      Props.create(() => new ConsumerController<T>(settings) as unknown as import('../Actor.js').Actor<Delivery<unknown>>),
      name ?? `reliable-consumer-${++counter}`,
    );
    return { ref, stop(): void { ref.stop(); } };
  }

  /** Spawn a ProducerController aimed at `settings.consumer`. */
  static producer<T>(
    system: ActorSystem,
    options: ProducerControllerOptions<T> | Partial<ProducerControllerSettings<T>>,
    name?: string,
  ): ProducerHandle<T> {
    const ref = system.spawn(
      Props.create(() => new ProducerController<T>(options) as unknown as import('../Actor.js').Actor<ProducerSend<T>>),
      name ?? `reliable-producer-${++counter}`,
    );
    return {
      ref,
      tell(body: T, confirm?: ConfirmationCallback): void {
        ref.tell({ kind: 'reliable-delivery.send', body, confirm });
      },
      stop(): void { ref.stop(); },
    };
  }
}

let counter = 0;
