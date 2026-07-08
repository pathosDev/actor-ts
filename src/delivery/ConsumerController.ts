import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { Ack, Delivery } from './Messages.js';

export interface ConsumerControllerOptionsType<T> {
  /**
   * Invoked for every successfully delivered (un-duplicated) message.  The
   * controller Acks AFTER the handler returns — if the handler returns a
   * Promise, the Ack is delayed until it settles.
   */
  readonly handler: (body: T) => void | Promise<void>;
}

interface DedupState {
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
  private readonly dedup = new Map<string, DedupState>();

  constructor(public readonly options: ConsumerControllerOptionsType<T>) { super(); }

  override onReceive(msg: Delivery<T>): void {
    if (msg.kind !== 'reliable-delivery.delivery') return;
    void this.handleDelivery(msg);
  }

  private async handleDelivery(msg: Delivery<T>): Promise<void> {
    const state = this.dedupStateFor(msg.producerId);
    if (msg.seq <= state.contiguous || state.above.has(msg.seq)) {
      // Duplicate — re-ack so the producer can release its slot, but don't
      // re-run the user handler.
      this.sendAck(msg);
      return;
    }
    try {
      await this.options.handler(msg.body);
    } catch (err) {
      this.log.warn(`consumer handler threw on seq=${msg.seq}`, err);
      // Do NOT ack — let the producer retry.
      return;
    }
    this.markDelivered(state, msg.seq);
    this.sendAck(msg);
  }

  private dedupStateFor(producerId: string): DedupState {
    let s = this.dedup.get(producerId);
    if (!s) { s = { contiguous: 0, above: new Set() }; this.dedup.set(producerId, s); }
    return s;
  }

  private markDelivered(state: DedupState, seq: number): void {
    if (seq === state.contiguous + 1) {
      state.contiguous++;
      // Slide the contiguous window as far up as the above-set lets us.
      while (state.above.delete(state.contiguous + 1)) state.contiguous++;
    } else {
      state.above.add(seq);
    }
  }

  private sendAck(msg: Delivery<T>): void {
    const ack: Ack = { kind: 'reliable-delivery.ack', producerId: msg.producerId, seq: msg.seq };
    (msg.replyTo as ActorRef<Ack>).tell(ack);
  }
}
