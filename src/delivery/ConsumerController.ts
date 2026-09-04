import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { Cancellable } from '../Scheduler.js';
import { DeadLetter } from '../SystemMessages.js';
import type { Acknowledgment, Delivery } from './Messages.js';
import {
  ConsumerControllerOptionsValidator,
  DEFAULT_MAX_OUT_OF_ORDER,
  DEFAULT_MAX_PRODUCERS,
  DEFAULT_PRODUCER_IDLE_TTL_MS,
} from './ConsumerControllerOptions.js';
import type { ConsumerControllerOptions, ConsumerControllerOptionsType } from './ConsumerControllerOptions.js';
import { DEDUPLICATION_REPORT_INTERVAL_MS, MAX_DELIVERY_IDENTIFIER_LENGTH } from './Constants.js';

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
  /**
   * When a delivery from this producer was last admitted, from `Date.now()`.
   *
   * Read by the idle sweep, which is the only mechanism that releases an
   * entry while nothing is arriving — the LRU cap only reclaims when a *new*
   * producer needs the slot, so a consumer that saw a burst and then went
   * quiet would hold all of it forever (#728).
   */
  lastSeenAtMs: number;
};

/**
 * Consumer side of the reliable-delivery protocol.  Accepts Delivery
 * envelopes, dedups them per (producerId, incarnation, seq), invokes the user
 * handler, and Acks back to the producer.  Handles out-of-order redelivery
 * correctly by tracking each delivered seq, not just the highest one.
 *
 * The dedup state is on a **resource budget** rather than kept forever, in
 * both of its dimensions.  The map holds at most `maxProducers` entries,
 * least-recently-used evicted, with entries idle for `producerIdleTtlMs`
 * swept out; and each entry retains at most `maxOutOfOrder` sequences above
 * an open gap.  Retaining the map forever made its size a function of how
 * many distinct `producerId`s had ever arrived — sender-chosen from the wire,
 * and freshly random per anonymous producer even with no sender in the
 * picture — while the per-entry set grew for as long as a sender withheld one
 * sequence and kept sending the ones after it (#728).  The budget is what
 * turns both into a bounded cost.  What it costs in exchange is at-least-once
 * duplicates around an eviction, which the protocol already permits, and a
 * stalled producer at the out-of-order cap, which its own retransmit
 * recovers from.
 */
export class ConsumerController<T> extends Actor<Delivery<T>> {
  /**
   * producerId → dedup state for its current incarnation, in
   * least-recently-used order.
   *
   * The ordering is load-bearing, not incidental: a `Map` iterates in
   * insertion order and `set` on a key it already holds does not move it, so
   * {@link touch} deletes before re-inserting.  That makes the first key the
   * eviction victim AND makes the map ascending by `lastSeenAtMs`, which is
   * what lets {@link sweepIdleProducers} stop at the first entry it finds
   * still fresh instead of walking the whole map every tick.
   */
  private readonly deduplication = new Map<string, DeduplicationState>();

  private readonly maxProducers: number;
  private readonly producerIdleTtlMs: number;
  private readonly maxOutOfOrder: number;
  private idleSweepTimer: Cancellable | null = null;
  /** Evictions not yet named in a warning — see {@link reportEvictions}. */
  private evictedSinceReport = 0;
  private lastEvictionReportAtMs = 0;
  /**
   * Out-of-order refusals not yet named in a warning — see
   * {@link reportOutOfOrderRefusals}.  Counted separately from the evictions
   * above, and paced off its own timestamp, so a flood of one kind cannot
   * suppress the first sighting of the other.
   */
  private refusedSinceReport = 0;
  private lastRefusalReportAtMs = 0;

  public readonly options: ConsumerControllerOptionsType<T>;

  constructor(options: ConsumerControllerOptions<T>) {
    super();
    const resolvedOptions = options as ConsumerControllerOptionsType<T>;
    new ConsumerControllerOptionsValidator<T>().validate(resolvedOptions);
    this.options = resolvedOptions;
    this.maxProducers = resolvedOptions.maxProducers ?? DEFAULT_MAX_PRODUCERS;
    this.producerIdleTtlMs = resolvedOptions.producerIdleTtlMs ?? DEFAULT_PRODUCER_IDLE_TTL_MS;
    this.maxOutOfOrder = resolvedOptions.maxOutOfOrder ?? DEFAULT_MAX_OUT_OF_ORDER;
  }

  /**
   * Producers this consumer currently holds dedup state for.
   *
   * The growth this bounds used to have no symptom short of the OOM — no log
   * line and no counter anywhere (#728).  This is the counter: read it from a
   * metrics tap that holds the instance, and it should sit near the number of
   * producers actually talking to this consumer rather than climbing with the
   * message count.
   */
  get trackedProducers(): number {
    return this.deduplication.size;
  }

  /**
   * Out-of-order seqs currently retained for `producerId`'s live incarnation,
   * or 0 when nothing is tracked for it.
   *
   * The companion to {@link trackedProducers}, for the same reason: what
   * `maxOutOfOrder` bounds also had no symptom short of the OOM.  It sits at
   * 0 for a producer whose stream is arriving in order, and rises only while
   * a gap is open; parked at `maxOutOfOrder` it means that producer is
   * stalled — this consumer is refusing to acknowledge past the cap while it
   * waits for a sequence that has not arrived.
   */
  outOfOrderFor(producerId: string): number {
    return this.deduplication.get(producerId)?.above.size ?? 0;
  }

  /**
   * Arm the idle sweep.  In `preStart` rather than a field initialiser
   * because `this.system` is not readable from one, and re-armed after a
   * restart for free — the default `postRestart` calls `preStart` and the
   * default `preRestart` calls `postStop`.
   */
  override preStart(): void {
    if (!Number.isFinite(this.producerIdleTtlMs)) return;
    this.idleSweepTimer = this.system.scheduler.scheduleAtFixedRateFunction(
      this.producerIdleTtlMs,
      this.producerIdleTtlMs,
      () => this.sweepIdleProducers(),
    );
  }

  override postStop(): void {
    this.idleSweepTimer?.cancel();
    this.idleSweepTimer = null;
    this.deduplication.clear();
  }

  /**
   * Hands the delivery's promise back to the cell, which is what makes the
   * handler run one at a time.
   *
   * `void this.handleDelivery(message)` returned `undefined`, and
   * `ActorCell.run` awaits only what a receive actually returns — so the cell
   * dequeued the next delivery while the user handler was still running, and
   * a queued burst became that many overlapping invocations (#643).  Two
   * things this class documents rest on the serialisation and were untrue
   * without it.  `ConsumerControllerOptionsType.handler` promises the
   * acknowledgment happens *after* the handler returns.  And the duplicate
   * check in {@link handleDelivery} reads a window that
   * {@link markDelivered} only writes once the handler has returned, so a
   * retransmit arriving in between was read-check-act against state its own
   * predecessor had not written yet, and re-entered the handler for a
   * sequence still in flight.
   */
  override onReceive(message: Delivery<T>): void | Promise<void> {
    if (message.kind !== 'reliable-delivery.delivery') return;
    return this.handleDelivery(message);
  }

  private async handleDelivery(message: Delivery<T>): Promise<void> {
    if (!this.isAdmissible(message)) {
      this.deadLetter(message);
      return;
    }
    const state = this.deduplicationStateFor(message.producerId, message.incarnation);
    if (message.seq <= state.contiguous || state.above.has(message.seq)) {
      // Duplicate — re-ack so the producer can release its slot, but don't
      // re-run the user handler.  Ahead of the out-of-order cap below on
      // purpose: a duplicate costs the set nothing, and refusing to re-ack one
      // at the cap would strand a producer whose acknowledgment was lost.
      this.sendAcknowledgment(message);
      return;
    }
    if (!this.hasOutOfOrderRoom(state, message.seq)) {
      this.reportOutOfOrderRefusals(state);
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
   * `undefined` at run time.  `producerId` becoming a `Map` key and `seq`
   * becoming arithmetic before anything has looked at either is the same
   * shape of exposure (#728).
   *
   * What that `TypeError` *costs* is no longer what this check was first
   * written against.  While the handling below was detached from
   * `onReceive`, it settled as a rejected promise no `try` was watching and
   * took the whole process with it (#727); now that the promise is returned
   * to the cell (#643) the same throw is an ordinary supervised fault.  So
   * the crash argument is spent, and the reason the check has to stay is the
   * one in the next paragraph, which was always the stronger half.
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
    // Shape is all this can ask of it, and deliberately so: binding `replyTo`
    // to an authenticated identity is refused in writing on
    // {@link sendAcknowledgment}, because a delivery carries none.
    const replyTo = message.replyTo as ActorRef<Acknowledgment> | undefined;
    return typeof replyTo?.tell === 'function';
  }

  private isIdentifier(value: string): boolean {
    return typeof value === 'string'
      && value.length > 0
      && value.length <= MAX_DELIVERY_IDENTIFIER_LENGTH;
  }

  private deadLetter(message: Delivery<T>): void {
    this.log.warn(`consumer refused a malformed delivery (seq=${String(message.seq)})`);
    this.system.deadLetters.tell(new DeadLetter(message, this.sender.toNullable(), this.self));
  }

  /**
   * Dedup state for a producer, replaced whenever the incarnation changes.
   *
   * **Replaced, not accumulated.** A new incarnation could have been given its
   * own map entry, but one entry per restart would spend the map's budget on
   * producers that no longer exist; keying on `producerId` and swapping the
   * value keeps it at one entry per producer.  The cost is that a delivery
   * from the *previous* incarnation still in flight when the new one starts
   * sending resets the window again, so a handful of already-handled seqs can
   * be handled a second time.  That is a genuine at-least-once duplicate,
   * which this protocol declares tolerable — and it is bounded by the
   * changeover window, where absorbing the post-restart prefix was not
   * bounded at all.
   *
   * Only a `producerId` the map has never held costs a slot, so that is the
   * one path that evicts: swapping an incarnation leaves the size alone.
   */
  private deduplicationStateFor(producerId: string, incarnation: string): DeduplicationState {
    const existing = this.deduplication.get(producerId);
    if (existing !== undefined && existing.incarnation === incarnation) {
      this.touch(producerId, existing);
      return existing;
    }
    if (existing === undefined) this.evictForNewProducer();
    // The zero is a placeholder the entry never leaves with: `touch` stamps
    // `lastSeenAtMs` on the next line, and it is the only writer of that field.
    const fresh: DeduplicationState = { incarnation, contiguous: 0, above: new Set(), lastSeenAtMs: 0 };
    this.touch(producerId, fresh);
    return fresh;
  }

  /**
   * Stamp an entry as just-used and move it to the most-recently-used end.
   *
   * The `delete` is what does the moving — `set` on a key the map already
   * holds updates the value and leaves the key where it was — and it is a
   * harmless no-op for a key that is genuinely new.
   */
  private touch(producerId: string, state: DeduplicationState): void {
    state.lastSeenAtMs = Date.now();
    this.deduplication.delete(producerId);
    this.deduplication.set(producerId, state);
  }

  /**
   * Make room for a producer the map has never held, least-recently-used
   * first.
   *
   * A loop where one eviction would do, because the cap is then a
   * post-condition of this method rather than an inductive claim about every
   * path that ever inserts.  `Infinity` is the documented opt-out and is the
   * only value that leaves the map unbounded.
   */
  private evictForNewProducer(): void {
    if (!Number.isFinite(this.maxProducers)) return;
    let evicted = 0;
    while (this.deduplication.size >= this.maxProducers) {
      const leastRecentlyUsed = this.deduplication.keys().next().value as string | undefined;
      if (leastRecentlyUsed === undefined) break;
      this.deduplication.delete(leastRecentlyUsed);
      evicted++;
    }
    if (evicted > 0) this.reportEvictions(evicted);
  }

  /**
   * Surface eviction instead of losing dedup windows quietly, paced so the
   * report cannot become the next exhaustion vector.
   *
   * Eviction is a real loss — the evicted producer's duplicate suppression is
   * gone, so its next retransmit runs the handler again — and an operator who
   * never hears about it has no way to tell a `maxProducers` that is too low
   * from one that is doing its job against a flood.  But the flood is
   * precisely when this fires on every message, so the line is paced by
   * {@link DEDUPLICATION_REPORT_INTERVAL_MS} and carries the count it stands for.
   *
   * The victim's id is deliberately not in the message: it is peer-supplied
   * text, and length is the only thing admission checks about it.
   */
  private reportEvictions(evicted: number): void {
    this.evictedSinceReport += evicted;
    const now = Date.now();
    if (now - this.lastEvictionReportAtMs < DEDUPLICATION_REPORT_INTERVAL_MS) return;
    this.lastEvictionReportAtMs = now;
    this.log.warn(
      `consumer evicted ${this.evictedSinceReport} least-recently-used producer dedup `
      + `entr${this.evictedSinceReport === 1 ? 'y' : 'ies'} (maxProducers=${this.maxProducers}) — `
      + 'each one loses duplicate suppression for that producer, so a later retransmit '
      + 'from it runs the handler again',
    );
    this.evictedSinceReport = 0;
  }

  /**
   * Drop every entry whose producer has gone quiet for longer than
   * `producerIdleTtlMs`.
   *
   * The `break` is the whole reason {@link touch} re-inserts: the map is in
   * ascending `lastSeenAtMs` order, so the first entry still fresh is proof
   * every entry after it is too.  A sweep therefore costs what it actually
   * releases, not the size of the map, which matters because it runs on a
   * timer for the life of the consumer.
   */
  private sweepIdleProducers(): void {
    const cutoff = Date.now() - this.producerIdleTtlMs;
    let swept = 0;
    for (const [producerId, state] of this.deduplication) {
      if (state.lastSeenAtMs > cutoff) break;
      this.deduplication.delete(producerId);
      swept++;
    }
    if (swept > 0) {
      this.log.debug(
        `consumer dropped ${swept} producer dedup entries idle for more than `
        + `${this.producerIdleTtlMs} ms`,
      );
    }
  }

  /**
   * Whether `seq` can be admitted without pushing this producer's
   * out-of-order set past `maxOutOfOrder`.
   *
   * A seq that closes the gap is admissible however full the set is: it
   * slides `contiguous` and drains from the set rather than adding to it, and
   * it is the *only* thing that ever releases the set — refusing it would
   * turn a recoverable stall into a deadlock.  `Infinity` needs no branch of
   * its own, since every finite size is below it.
   *
   * The check is here, before the handler, and {@link markDelivered} inserts
   * after it — which is only a reliable pairing because `onReceive` hands the
   * cell the delivery's promise (#643).  Detached, every in-flight delivery
   * passed this check before any of them had inserted, so the set overshot
   * the cap by the concurrency.
   */
  private hasOutOfOrderRoom(state: DeduplicationState, seq: number): boolean {
    if (seq === state.contiguous + 1) return true;
    return state.above.size < this.maxOutOfOrder;
  }

  /**
   * Surface a delivery refused at the out-of-order cap, paced the same way
   * {@link reportEvictions} is and for the same reason.
   *
   * Refusing means no handler call *and* no acknowledgment, which is the
   * maintainer's choice over the alternative of evicting the oldest retained
   * sequence.  Both bound the heap; they differ in what they spend.  A drop
   * re-runs the handler for a message this consumer had already handled and
   * acknowledged — an at-least-once duplicate the sender cannot anticipate —
   * whereas withholding the acknowledgment leaves the send in the producer's
   * own window, where it is already being retransmitted.  The stall
   * propagates back to the sender, which is where the missing sequence is,
   * and the protocol's "no silent drop of a message" property survives.
   *
   * The awaited seq is in the message because it is the number an operator
   * needs and it is a bounded integer by {@link isAdmissible}.  The
   * `producerId` is not, for the same reason {@link reportEvictions} omits
   * it: it is peer-supplied text.
   */
  private reportOutOfOrderRefusals(state: DeduplicationState): void {
    this.refusedSinceReport++;
    const now = Date.now();
    if (now - this.lastRefusalReportAtMs < DEDUPLICATION_REPORT_INTERVAL_MS) return;
    this.lastRefusalReportAtMs = now;
    this.log.warn(
      `consumer refused ${this.refusedSinceReport} out-of-order deliver`
      + `${this.refusedSinceReport === 1 ? 'y' : 'ies'} with a full out-of-order window `
      + `(maxOutOfOrder=${this.maxOutOfOrder}); it is waiting for seq ${state.contiguous + 1} and `
      + 'will not acknowledge past the cap until that arrives, so the producer stalls rather '
      + 'than this consumer retaining sequences without bound',
    );
    this.refusedSinceReport = 0;
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
   * The `tell` is guarded because an acknowledgment is best-effort by design
   * and a `replyTo` that cannot be reached is not this consumer's failure: a
   * remote ref whose transport send fails, or one whose cell is already gone,
   * throws here for reasons that have nothing to do with the message the
   * handler just processed successfully.
   *
   * The swallow used to be justified by detachment — this ran on a promise
   * nobody held, so a throw escaped as an unhandled rejection instead of as
   * anything the framework could supervise (#727).  That reason is gone:
   * `onReceive` returns the promise and the cell awaits it (#643), so a throw
   * here would now fault the actor properly.  The swallow survives on the
   * reason that actually holds, which is what supervision would *do*.  Losing
   * an ack costs a retransmit, which is the mechanism the protocol already
   * has for exactly this.  Faulting instead restarts the consumer, and since
   * `deduplication` is a field initialiser the restart discards every
   * producer's dedup window — so one unreachable reply address would cost
   * duplicate handler invocations across the whole node, and then loop,
   * because the retransmit arrives and fails to ack again.
   *
   * **The address is `message.replyTo`, and #730's fourth suggested fix — "on
   * the consumer side, refuse to acknowledge to a `replyTo` other than the
   * envelope's authenticated sender" — is refused rather than implemented.**
   * There is no authenticated sender to compare it against on any path this
   * protocol has.  A `ProducerController` ships a delivery with
   * `consumer.tell(delivery)`, one argument, so `this.sender` is `None` for
   * every legitimate delivery — pinned by "a delivery carries no authenticated
   * sender" in `tests/unit/delivery`, which fails the moment a producer starts
   * telling with one.  The cluster's generic path resolution attaches no
   * sender either (`cluster/EnvelopeTrust.ts` says so in its module header),
   * and it cannot reach a controller under `/system/delivery/` by name in the
   * first place.  Enforcing the clause literally would refuse every
   * acknowledgment this protocol will ever send, which is the same ground the
   * sibling clause was refused on one file over — see
   * `ProducerController.onAcknowledgment`.
   *
   * Nothing else on a `Delivery` is unforgeable either.  `producerId`,
   * `incarnation`, `seq` and `replyTo` are all written by whoever built the
   * envelope, so binding the reply target to the first `replyTo` seen for an
   * incarnation would pin it to a value the same party chose: trust on first
   * use, not authentication.
   *
   * And it would protect nothing reachable.  An `ActorRef` has no wire
   * representation — `serialization/JsonTree.ts` has no tag for one, and
   * {@link isAdmissible} refuses an envelope whose `replyTo` did not arrive as
   * a live ref — so a `replyTo` naming a foreign actor can only be written by
   * a party already holding that actor's ref in this process, which can `tell`
   * it directly.  Reflecting an `Acknowledgment` through here is one message
   * in and one out, carrying four fields that party wrote itself, to an actor
   * it can already reach; and a real producer on the receiving end discards it,
   * because the incarnation will not match.  That echo is what actually
   * authenticates an acknowledgment, and it stays where it can be checked
   * against something unguessable — on the producer, not here.
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
