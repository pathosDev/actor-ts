import type { ActorRef } from '../ActorRef.js';

/**
 * Wire-shape sent from Producer to Consumer.  Each envelope carries the
 * producer id (used by consumers to dedup across producers) and a
 * monotonically increasing sequence number per producer-consumer pair.
 */
export interface Delivery<T> {
  readonly kind: 'reliable-delivery.delivery';
  readonly producerId: string;
  readonly seq: number;
  readonly body: T;
  /** Reply address — the consumer Acks back here. */
  readonly replyTo: ActorRef<Ack>;
}

/** Sent from Consumer back to Producer after successful handling. */
export interface Ack {
  readonly kind: 'reliable-delivery.ack';
  readonly producerId: string;
  readonly seq: number;
}

/** Delivery callback handed to the producer — resolves once the consumer Acks. */
export type ConfirmationCallback = (err: Error | null) => void;
