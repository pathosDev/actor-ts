import type { ActorRef } from '../ActorRef.js';

/**
 * Wire-shape sent from Producer to Consumer.  Each envelope carries the
 * producer id (used by consumers to dedup across producers), the sending
 * incarnation of that producer, and a monotonically increasing sequence
 * number per producer-consumer pair.
 */
export type Delivery<T> = {
  readonly kind: 'reliable-delivery.delivery';
  readonly producerId: string;
  /**
   * Identifies the *incarnation* of `producerId` that sent this envelope —
   * crypto-random, minted once per `ProducerController` construction.
   *
   * `producerId` on its own is not enough to key dedup state on, because it
   * is deliberately stable across restarts while the sequence counter is
   * not: a restarted producer re-sends seq 1, which every consumer holding
   * a dedup entry for that id would absorb as a duplicate (#726).  Pairing
   * the two makes a new incarnation distinguishable from a retransmit.
   */
  readonly incarnation: string;
  readonly seq: number;
  readonly body: T;
  /** Reply address — the consumer Acks back here. */
  readonly replyTo: ActorRef<Acknowledgment>;
};

/** Sent from Consumer back to Producer after successful handling. */
export type Acknowledgment = {
  readonly kind: 'reliable-delivery.ack';
  readonly producerId: string;
  /**
   * Echoed back from the {@link Delivery} being acknowledged.  This is what
   * authenticates the acknowledgment: `producerId` and `seq` are both
   * enumerable, so a three-field ack could be manufactured by anything able
   * to reach the producer, cancelling its retransmit and reporting success
   * for a message the consumer never saw (#730).  The incarnation travels
   * only on the deliveries this producer actually sent, so echoing it is
   * evidence of having received one.
   */
  readonly incarnation: string;
  readonly seq: number;
};

/** Delivery callback handed to the producer — resolves once the consumer Acks. */
export type ConfirmationCallback = (err: Error | null) => void;
