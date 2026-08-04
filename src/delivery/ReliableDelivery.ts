import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import { SystemGroups } from '../internal/SystemPaths.js';
import { ConsumerController } from './ConsumerController.js';
import type { ConsumerControllerOptionsType } from './ConsumerControllerOptions.js';
import type { ConfirmationCallback, Delivery } from './Messages.js';
import {
  ProducerController,
  type ProducerSend,
} from './ProducerController.js';
import type { ProducerControllerOptions } from './ProducerControllerOptions.js';
import { randomId } from '../util/RandomString.js';

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
    options: ConsumerControllerOptionsType<T>,
    name?: string,
  ): ConsumerHandle {
    const ref = system._spawnSystemActor(
      () => new ConsumerController<T>(options) as unknown as import('../Actor.js').Actor<Delivery<unknown>>,
      SystemGroups.delivery,
      name ?? generatedName('consumer', ++counter),
    );
    return { ref, stop(): void { ref.stop(); } };
  }

  /** Spawn a ProducerController aimed at `options.consumer`. */
  static producer<T>(
    system: ActorSystem,
    options: ProducerControllerOptions<T>,
    name?: string,
  ): ProducerHandle<T> {
    const ref = system._spawnSystemActor(
      () => new ProducerController<T>(options) as unknown as import('../Actor.js').Actor<ProducerSend<T>>,
      SystemGroups.delivery,
      name ?? generatedName('producer', ++counter),
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

/**
 * Names a controller the caller did not name.
 *
 * Was `${role}-${++counter}` on a module-global counter, which had both
 * problems the `ask` reply refs were moved off in #120.  These names become
 * actor names under `/system/delivery/`, so they become paths — and a path is
 * an address: `/system/delivery/consumer-1` is the first one of every run.  And
 * the counter was per *module*, not per system, so two `ActorSystem`s in one
 * process drew from the same sequence.
 *
 * The counter is kept ahead of the random half, as anonymous actor names do
 * (#895), so spawn order stays legible in a log line and in the actor tree.
 */
const generatedName = (role: string, ordinal: number): string =>
  `${role}-${ordinal}-${randomId(12)}`;

let counter = 0;
