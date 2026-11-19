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
  /**
   * The producer's low-water mark: the lowest seq this incarnation still
   * holds unacknowledged when the envelope is sent, so never above `seq`.
   * Everything below it has been acknowledged, which means a consumer has
   * already run its handler for it and the producer will not send it again.
   *
   * The consumer raises its window to `floor - 1` on admission.  Without that,
   * a consumer that has dropped a producer's window (the idle sweep, an LRU
   * eviction, a promotion over its incarnation, or its own restart) started the
   * next one at 0.  The producer carried on at N+1, so every delivery went out
   * of order, waiting for seqs 1..N that would never come again, and after
   * `maxOutOfOrder` of them the producer stalled for good (#1862).
   *
   * An envelope without one, from a producer that predates the field, counts
   * as floor 1: the old behaviour, stall included.
   */
  readonly floor: number;
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

/**
 * Delivery callback handed to the producer, called once per send: with `null`
 * once the consumer has acknowledged it, or with an `Error`
 * (`producer stopped`) when the producer stops before that acknowledgment
 * arrives.  If the process dies first, it is never called.
 *
 * It runs on the producer's turn.  A throw from it, or the rejection of a
 * promise it returns, is caught and logged at error level, naming the producer
 * and the send, and goes no further: the producer is not restarted and every
 * other send is still settled (#1230).  That holds for any value thrown or
 * rejected with — one the logger cannot render, such as an error whose
 * `message` getter throws, is left out of the line rather than allowed to
 * escape through it.  A returned promise is not awaited.
 */
export type ConfirmationCallback = (err: Error | null) => void;
