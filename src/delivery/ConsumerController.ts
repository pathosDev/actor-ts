import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import { DeadLetter } from '../SystemMessages.js';
import type { Acknowledgment, Delivery } from './Messages.js';
import type { ConsumerControllerOptions, ConsumerControllerOptionsType } from './ConsumerControllerOptions.js';
import { MAX_DELIVERY_IDENTIFIER_LENGTH } from './Constants.js';

type DeduplicationState = {
  /**
   * The producer incarnation this state belongs to.  Dedup is keyed on
   * `producerId` alone in the map, but a `producerId` is stable across
   * producer restarts while the sequence numbering is not — so the entry has
   * to record *which* incarnation the counters below describe, or a restarted
   * producer's seq 1 is indistinguishable from a retransmit of the original
   * (#726).
   */
  readonly incarnation: string;
  /**
   * Highest seq that has been delivered AND every seq below it has also
   * been delivered — everything <= this number is implicitly a duplicate.
   */
  contiguous: number;
  /** Out-of-order seqs already delivered but above `contiguous`. */
  readonly above: Set<number>;
};

/**
 * Consumer side of the reliable-delivery protocol.  Accepts Delivery
 * envelopes, dedups them per (producerId, incarnation, seq), invokes the user
 * handler, and Acks back to the producer.  Handles out-of-order redelivery
 * correctly by tracking each delivered seq, not just the highest one.
 */
export class ConsumerController<T> extends Actor<Delivery<T>> {
  /** producerId → dedup state for its current incarnation. */
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
    if (!this.isAdmissible(message)) {
      this.deadLetter(message);
      return;
    }
    const state = this.deduplicationStateFor(message.producerId, message.incarnation);
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

  /**
   * Admission check for an envelope that came off the wire.
   *
   * Every field checked here is declared non-optional on {@link Delivery},
   * which is exactly why nothing guarded them: a peer that simply omits
   * `replyTo` satisfies the type at compile time and dereferences to
   * `undefined` at run time.  Because the handling below is detached from
   * `onReceive`, that `TypeError` used to settle as a rejected promise no
   * `try` was watching and took the whole process with it — an actor fault
   * would at least have been supervised (#727).  `producerId` becoming a
   * `Map` key and `seq` becoming arithmetic before anything has looked at
   * either is the same shape of exposure (#728).
   *
   * A refusal is a dead letter rather than a fault: a malformed envelope is
   * bad *input*, and faulting the consumer on it would restart the actor and
   * take its whole dedup window with it, converting one bad message into lost
   * duplicate-suppression for every healthy producer on the node.
   */
  private isAdmissible(message: Delivery<T>): boolean {
    if (!this.isIdentifier(message.producerId)) return false;
    if (!this.isIdentifier(message.incarnation)) return false;
    if (!Number.isSafeInteger(message.seq) || message.seq <= 0) return false;
    // The declared type says this is always an ActorRef; the wire disagrees.
    const replyTo = message.replyTo as ActorRef<Acknowledgment> | undefined;
    return typeof replyTo?.tell === 'function';
  }

  private isIdentifier(value: string): boolean {
    return typeof value === 'string'
      && value.length > 0
      && value.length <= MAX_DELIVERY_IDENTIFIER_LENGTH;
  }

  private deadLetter(message: Delivery<T>): void {
    this.log.warn(`consumer refused a malformed delivery (seq=${String(message?.seq)})`);
    this.system.deadLetters.tell(new DeadLetter(message, this.sender.toNullable(), this.self));
  }

  /**
   * Dedup state for a producer, replaced whenever the incarnation changes.
   *
   * **Replaced, not accumulated.** A new incarnation could have been given its
   * own map entry, but the map is already unbounded (#728) and one entry per
   * restart would make that strictly worse; keying on `producerId` and
   * swapping the value keeps it at one entry per producer, which is better
   * than before.  The cost is that a delivery from the *previous* incarnation
   * still in flight when the new one starts sending resets the window again,
   * so a handful of already-handled seqs can be handled a second time.  That
   * is a genuine at-least-once duplicate, which this protocol declares
   * tolerable — and it is bounded by the changeover window, where absorbing
   * the post-restart prefix was not bounded at all.
   */
  private deduplicationStateFor(producerId: string, incarnation: string): DeduplicationState {
    const existing = this.deduplication.get(producerId);
    if (existing !== undefined && existing.incarnation === incarnation) return existing;
    const fresh: DeduplicationState = { incarnation, contiguous: 0, above: new Set() };
    this.deduplication.set(producerId, fresh);
    return fresh;
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

  /**
   * The `tell` is guarded because this method runs on a detached promise: a
   * throw out of it — a remote `replyTo` whose transport send fails, a ref
   * whose cell is already gone — would otherwise escape as an unhandled
   * rejection rather than as anything the framework can supervise (#727).
   *
   * Swallowing it is the right answer specifically for an *acknowledgment*.
   * The ack is best-effort by design: losing one costs a retransmit, which is
   * the mechanism the protocol already has for exactly this.  Faulting
   * instead would restart the consumer, and since `deduplication` is a field
   * initialiser the restart would discard the dedup window — so a failing ack
   * would cost duplicate handler invocations for every producer on the node,
   * and then loop, because the retransmit arrives and fails to ack again.
   */
  private sendAcknowledgment(message: Delivery<T>): void {
    const ack: Acknowledgment = {
      kind: 'reliable-delivery.ack',
      producerId: message.producerId,
      incarnation: message.incarnation,
      seq: message.seq,
    };
    try {
      message.replyTo.tell(ack);
    } catch (err) {
      this.log.warn(`consumer could not acknowledge seq=${message.seq}; the producer will retransmit`, err);
    }
  }
}
