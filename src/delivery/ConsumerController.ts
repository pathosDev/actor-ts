import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { Acknowledgment, Delivery } from './Messages.js';
import type { ConsumerControllerOptions, ConsumerControllerOptionsType } from './ConsumerControllerOptions.js';

interface DeduplicationState {
  /**
   * Highest seq that has been delivered AND every seq below it has also
   * been delivered — everything <= this number is implicitly a duplicate.
   */
  contiguous: number;
  /** Out-of-order seqs already delivered but above `contiguous`. */
  readonly above: Set<number>;
}

/**
 * Consumer side of the reliable-delivery protocol.  Accepts Delivery
 * envelopes, dedups them per (producerId, seq), invokes the user handler,
 * and Acks back to the producer.  Handles out-of-order redelivery
 * correctly by tracking each delivered seq, not just the highest one.
 */
export class ConsumerController<T> extends Actor<Delivery<T>> {
  /** producerId → dedup state. */
  private readonly deduplication = new Map<string, DeduplicationState>();

  public readonly options: ConsumerControllerOptionsType<T>;

  constructor(options: ConsumerControllerOptions<T>) {
    super();
    this.options = options as ConsumerControllerOptionsType<T>;
  }

  override onReceive(message: Delivery<T>): void {
    if (message.kind !== 'reliable-delivery.delivery') return;
    void this.handleDelivery(message);
  }

  private async handleDelivery(message: Delivery<T>): Promise<void> {
    const state = this.dedupStateFor(message.producerId);
    if (message.seq <= state.contiguous || state.above.has(message.seq)) {
      // Duplicate — re-ack so the producer can release its slot, but don't
      // re-run the user handler.
      this.sendAcknowledgment(message);
      return;
    }
    try {
      await this.options.handler(message.body);
    } catch (err) {
      this.log.warn(`consumer handler threw on seq=${message.seq}`, err);
      // Do NOT ack — let the producer retry.
      return;
    }
    this.markDelivered(state, message.seq);
    this.sendAcknowledgment(message);
  }

  private dedupStateFor(producerId: string): DeduplicationState {
    let deduplicationState = this.deduplication.get(producerId);
    if (!deduplicationState) { deduplicationState = { contiguous: 0, above: new Set() }; this.deduplication.set(producerId, deduplicationState); }
    return deduplicationState;
  }

  private markDelivered(state: DeduplicationState, seq: number): void {
    if (seq === state.contiguous + 1) {
      state.contiguous++;
      // Slide the contiguous window as far up as the above-set lets us.
      while (state.above.delete(state.contiguous + 1)) state.contiguous++;
    } else {
      state.above.add(seq);
    }
  }

  private sendAcknowledgment(message: Delivery<T>): void {
    const ack: Acknowledgment = { kind: 'reliable-delivery.ack', producerId: message.producerId, seq: message.seq };
    (message.replyTo as ActorRef<Acknowledgment>).tell(ack);
  }
}
