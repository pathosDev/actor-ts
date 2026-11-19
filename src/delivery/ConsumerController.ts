import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { Cancellable } from '../Scheduler.js';
import { DeadLetter } from '../SystemMessages.js';
import type { Acknowledgment, Delivery } from './Messages.js';
import {
  ConsumerControllerOptionsValidator,
  DEFAULT_MAX_INCARNATIONS_PER_PRODUCER,
  DEFAULT_MAX_OUT_OF_ORDER,
  DEFAULT_MAX_PRODUCERS,
  DEFAULT_PRODUCER_IDLE_TTL_MS,
} from './ConsumerControllerOptions.js';
import type { ConsumerControllerOptions, ConsumerControllerOptionsType } from './ConsumerControllerOptions.js';
import {
  DEDUPLICATION_REPORT_INTERVAL_MS,
  MAX_DELIVERY_IDENTIFIER_LENGTH,
  UNHANDLED_REPORT_INTERVAL_MS,
} from './Constants.js';

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
   * When a delivery under this incarnation was last admitted, on
   * `system.clock`.
   *
   * Read for one decision: whether this incarnation has gone quiet for
   * `producerIdleTtlMs`.  For the live incarnation that is the evidence a
   * newer one may be promoted over it (#1237); for a held one, that its slot
   * may be released.
   */
  lastSeenAtMs: number;
};

/**
 * Everything the consumer holds for one `producerId`: the live incarnation's
 * window, and the windows of incarnations seen since that are not promoted yet.
 */
type ProducerDeduplication = {
  /** The incarnation whose window is authoritative for this producer. */
  current: DeduplicationState;
  /**
   * Incarnations seen while {@link current} was still talking, by incarnation,
   * each deduplicated in its own window.  At most `maxIncarnationsPerProducer`
   * minus one of them.
   */
  readonly held: Map<string, DeduplicationState>;
  /**
   * When a delivery under *any* of this producer's incarnations was last
   * admitted, on `system.clock`.
   *
   * Read by the idle sweep, which is the only mechanism that releases an
   * entry while nothing is arriving — the LRU cap only reclaims when a *new*
   * producer needs the slot, so a consumer that saw a burst and then went
   * quiet would hold all of it forever (#728).
   */
  lastSeenAtMs: number;
};

/** The window a delivery is checked against, and the producer entry it belongs to. */
type AdmittedWindow = {
  readonly entry: ProducerDeduplication;
  readonly state: DeduplicationState;
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
 *
 * **What the window is bound to (#1237).**  The key is the `producerId`, and
 * within it the `incarnation` — both written by whoever built the envelope,
 * neither authenticated.  So an incarnation the consumer has not seen is
 * never allowed to *replace* the live one's window: it is held beside it, in
 * a window of its own, and promoted only once the live incarnation has gone
 * quiet for `producerIdleTtlMs`.  At most `maxIncarnationsPerProducer` are
 * held per producer; past that a delivery under another one is refused.
 */
export class ConsumerController<T> extends Actor<Delivery<T>> {
  /**
   * producerId → dedup state for its incarnations, in least-recently-used
   * order.
   *
   * The ordering is load-bearing, not incidental: a `Map` iterates in
   * insertion order and `set` on a key it already holds does not move it, so
   * {@link touch} deletes before re-inserting.  That makes the first key the
   * eviction victim AND makes the map ascending by `lastSeenAtMs`, which is
   * what lets {@link sweepIdleProducers} stop at the first entry it finds
   * still fresh instead of walking the whole map every tick.
   */
  private readonly deduplication = new Map<string, ProducerDeduplication>();

  private readonly maxProducers: number;
  private readonly producerIdleTtlMs: number;
  private readonly maxOutOfOrder: number;
  private readonly maxIncarnationsPerProducer: number;
  private idleSweepTimer: Cancellable | null = null;
  /**
   * Evictions not yet named in a warning — see {@link reportEvictions}.
   *
   * Every "last reported at" below starts at `-Infinity` for the reason
   * {@link lastUnhandledReportAtMs} gives: they are read off `system.clock`,
   * and a virtual clock starts at 0.
   */
  private evictedSinceReport = 0;
  private lastEvictionReportAtMs = Number.NEGATIVE_INFINITY;
  /** Incarnation refusals not yet named in a warning — see {@link reportIncarnationRefusals}. */
  private refusedIncarnationsSinceReport = 0;
  private lastIncarnationRefusalReportAtMs = Number.NEGATIVE_INFINITY;
  /**
   * Out-of-order refusals not yet named in a warning — see
   * {@link reportOutOfOrderRefusals}.  Counted separately from the evictions
   * above, and paced off its own timestamp, so a flood of one kind cannot
   * suppress the first sighting of the other.
   */
  private refusedSinceReport = 0;
  private lastRefusalReportAtMs = Number.NEGATIVE_INFINITY;
  /** Declines not yet named in a warning — see {@link reportUnhandled}. */
  private unhandledSinceReport = 0;
  /**
   * When the last decline warning went out, on `system.clock`.
   *
   * `-Infinity` rather than 0, so the first decline is always reported: a
   * virtual clock starts at 0, where a zero here would read as "reported a
   * moment ago" and swallow the one line the pacing exists to let through.
   */
  private lastUnhandledReportAtMs = Number.NEGATIVE_INFINITY;

  public readonly options: ConsumerControllerOptionsType<T>;

  constructor(options: ConsumerControllerOptions<T>) {
    super();
    const resolvedOptions = options as ConsumerControllerOptionsType<T>;
    new ConsumerControllerOptionsValidator<T>().validate(resolvedOptions);
    this.options = resolvedOptions;
    this.maxProducers = resolvedOptions.maxProducers ?? DEFAULT_MAX_PRODUCERS;
    this.producerIdleTtlMs = resolvedOptions.producerIdleTtlMs ?? DEFAULT_PRODUCER_IDLE_TTL_MS;
    this.maxOutOfOrder = resolvedOptions.maxOutOfOrder ?? DEFAULT_MAX_OUT_OF_ORDER;
    this.maxIncarnationsPerProducer = resolvedOptions.maxIncarnationsPerProducer
      ?? DEFAULT_MAX_INCARNATIONS_PER_PRODUCER;
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
    return this.deduplication.get(producerId)?.current.above.size ?? 0;
  }

  /**
   * Incarnations of `producerId` this consumer holds a window for, the live
   * one included, or 0 when nothing is tracked for it.
   *
   * 1 is the steady state.  2 means a new incarnation is being held beside
   * the live one — a producer restart waiting out the idle TTL, or a delivery
   * that named this producer under an incarnation it is not running (#1237).
   * Parked at `maxIncarnationsPerProducer`, a further incarnation is refused.
   */
  incarnationsHeldFor(producerId: string): number {
    const entry = this.deduplication.get(producerId);
    return entry === undefined ? 0 : 1 + entry.held.size;
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
   *
   * The `kind` is read through optional chaining because the declared type is
   * what the sender promised, not what arrived: a `null` used to throw on
   * this line, and a throw is a supervised fault whose restart discards every
   * producer's deduplication window.
   */
  override onReceive(message: Delivery<T>): void | Promise<void> {
    const kind: unknown = (message as { readonly kind?: unknown } | null | undefined)?.kind;
    if (kind !== 'reliable-delivery.delivery') {
      this.onUnhandled(message);
      return;
    }
    return this.handleDelivery(message);
  }

  /**
   * Decline a message that is not a delivery, and keep the window.
   *
   * This used to be a bare `return`: no dead letter, no metric, no log line.
   * The consumer's ref is not private — every producer delivering here holds
   * it, a handler can pass it on, and a controller under `/user` is
   * addressable from a cluster peer — so whatever reached it and was not a
   * delivery vanished without a trace.  The first message work-pulling needs
   * (#1470) travels between the two controllers, and a consumer that predates
   * it would have swallowed every one in silence.
   *
   * `this.unhandled` makes the decline visible everywhere but the log: a dead
   * letter naming this consumer, and `actor_unhandled_total{class}` for the
   * rate.  The warning is the log's share, paced by {@link reportUnhandled}.
   * Nothing else moves — the deduplication state and the handler are not
   * consulted — which is `ProducerController.onUnhandled`'s contract as well.
   */
  private onUnhandled(message: unknown): void {
    this.reportUnhandled();
    this.unhandled(message);
  }

  /**
   * Name declines in the log at most once per
   * {@link UNHANDLED_REPORT_INTERVAL_MS}, each line carrying how many it
   * stands for — the producer's pacing, and for the producer's reason: the ref
   * that reaches this consumer can reach it at message rate, and a line per
   * decline would hand that party this process's log.
   *
   * Nothing from the message is in the line.  Its `kind` would be the most
   * useful word there, and it is text the sender chose with nothing bounding
   * its length; the dead letter carries the whole message to whoever
   * subscribes to it.
   *
   * Timed on `system.clock` and not the wall clock, so the interval is
   * virtual time under a `ManualScheduler` and a test reaches its far edge
   * without holding still for a minute.
   */
  private reportUnhandled(): void {
    this.unhandledSinceReport++;
    const now = this.system.clock.now();
    if (now - this.lastUnhandledReportAtMs < UNHANDLED_REPORT_INTERVAL_MS) return;
    this.lastUnhandledReportAtMs = now;
    const count = this.unhandledSinceReport;
    this.unhandledSinceReport = 0;
    this.log.warn(
      `consumer declined ${count} message${count === 1 ? ' that was' : 's that were'} not a delivery — `
      + 'each one is a dead letter now, and the deduplication state and the handler are untouched.  '
      + 'A sender may speak a newer delivery protocol than this consumer',
    );
  }

  private async handleDelivery(message: Delivery<T>): Promise<void> {
    if (!this.isAdmissible(message)) {
      this.deadLetter(message);
      return;
    }
    const admitted = this.windowFor(message.producerId, message.incarnation);
    if (admitted === null) {
      this.refuseIncarnation(message);
      return;
    }
    const { entry, state } = admitted;
    this.raiseFloor(state, (message.floor as number | undefined) ?? 1);
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
      // Do NOT ack — let the producer retry.  No re-stamp either: nothing was
      // marked delivered, so an entry the sweep took while the handler was
      // running has no window worth restoring, and the retransmit this refusal
      // invites is supposed to re-enter the handler.
      return;
    }
    // Re-stamp before the write.  `touch` ran on *arrival*, so the handler's
    // own duration is not part of the idle TTL it was measured against — and
    // {@link sweepIdleProducers} runs from a raw scheduler callback rather than
    // through the mailbox, making it the one thing that can delete this entry
    // while the `await` above is outstanding.  Then `markDelivered` writes to
    // an object the map no longer reaches, the sequence is not in the live
    // window, and the producer's retransmit runs the handler a second time.
    //
    // Re-inserting cannot breach `maxProducers`: deliveries are serialised, so
    // no new producer can be admitted while this one is awaited, and the sweep
    // only ever removes — the map can therefore only be smaller than it was
    // when this entry was admitted.  Nor can it promote or release one of this
    // producer's incarnations: those happen only on admission, which is
    // serialised behind this await too.
    this.touch(message.producerId, entry, state);
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
    if (!this.isFloorAdmissible(message)) return false;
    // The declared type says this is always an ActorRef; the wire disagrees.
    // Shape is all this can ask of it, and deliberately so: binding `replyTo`
    // to an authenticated identity is refused in writing on
    // {@link sendAcknowledgment}, because a delivery carries none.
    const replyTo = message.replyTo as ActorRef<Acknowledgment> | undefined;
    return typeof replyTo?.tell === 'function';
  }

  /**
   * A floor is absent (a producer that predates #1862, read as 1) or a
   * positive safe integer no greater than the envelope's own seq.  An honest
   * producer stamps the lowest seq it still has in flight, and the seq being
   * sent is in flight, so a floor above it is malformed by construction —
   * and admitting one would let a single envelope declare its own seq a
   * duplicate, acknowledged without the handler ever running.
   */
  private isFloorAdmissible(message: Delivery<T>): boolean {
    const floor = message.floor as number | undefined;
    if (floor === undefined) return true;
    return Number.isSafeInteger(floor) && floor > 0 && floor <= message.seq;
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
   * The window a delivery under (`producerId`, `incarnation`) is checked
   * against, or `null` when that incarnation is one too many to hold.
   *
   * **Held beside, then promoted — never replaced on sight (#1237).**  This
   * used to swap the producer's window for a fresh one whenever the
   * incarnation differed.  Neither field is authenticated, so one envelope
   * naming a live producer under an invented incarnation emptied that
   * producer's window, and its next retransmit of a sequence already handled
   * ran the handler again — at a rate the sender chose, since one envelope per
   * honest delivery kept the window empty for good.
   *
   * So an unfamiliar incarnation is *held*: it gets a window of its own beside
   * the live one, and the live window is untouched.  It is *promoted* — made
   * the live window, the old one dropped — only on a delivery that arrives
   * once the live incarnation has gone quiet for `producerIdleTtlMs`.  That
   * is the evidence the idle sweep already takes as "this producer is gone",
   * so a forger who names a new incarnation gets no further than one who
   * waits for the sweep, and a real restart converges: the old incarnation
   * stops sending, and the new one's next delivery after the TTL promotes it,
   * carrying its own window across.
   *
   * **A held incarnation is deduplicated in its own window rather than held
   * back.**  Withholding its deliveries — no handler, no acknowledgment —
   * would also keep at-least-once, since its producer retransmits, but it
   * would stall every restarted producer for a whole idle TTL, five minutes
   * by default, on the chance that the restart is a forgery.  Its own window
   * gives a real restart at-least-once *with* duplicate suppression from its
   * first delivery, and costs the live producer nothing; a forger it serves
   * gets its own messages handled once each, which is what any sender of a
   * new `producerId` gets anyway.
   *
   * What the changeover still costs is the old case's: a delivery of the old
   * incarnation still in flight after the promotion is an unfamiliar
   * incarnation again, gets a fresh window, and may run the handler a second
   * time — an at-least-once duplicate bounded by the changeover, now one idle
   * TTL after the old incarnation's last word rather than at once.
   *
   * Only a `producerId` the map has never held costs a slot in it, so that is
   * the one path that evicts.
   */
  private windowFor(producerId: string, incarnation: string): AdmittedWindow | null {
    const entry = this.deduplication.get(producerId);
    if (entry === undefined) {
      this.evictForNewProducer();
      const created: ProducerDeduplication = {
        current: this.freshWindow(incarnation),
        held: new Map(),
        lastSeenAtMs: 0,
      };
      return this.touch(producerId, created, created.current);
    }
    if (entry.current.incarnation === incarnation) return this.touch(producerId, entry, entry.current);
    const now = this.system.clock.now();
    if (this.hasGoneQuiet(entry.current, now)) {
      return this.touch(producerId, entry, this.promote(entry, incarnation, now));
    }
    const held = entry.held.get(incarnation);
    if (held !== undefined) return this.touch(producerId, entry, held);
    this.releaseQuietIncarnations(entry, now);
    if (1 + entry.held.size >= this.maxIncarnationsPerProducer) return null;
    const window = this.freshWindow(incarnation);
    entry.held.set(incarnation, window);
    return this.touch(producerId, entry, window);
  }

  /**
   * Make `incarnation` the producer's live window, dropping the old one.
   *
   * A held window is carried across as it is — its producer's deliveries have
   * been deduplicated in it all along — and only an incarnation never seen
   * starts empty.  Held incarnations that have gone quiet themselves are
   * released on the way: nothing will promote them now.
   */
  private promote(entry: ProducerDeduplication, incarnation: string, now: number): DeduplicationState {
    const promoted = entry.held.get(incarnation) ?? this.freshWindow(incarnation);
    entry.held.delete(incarnation);
    entry.current = promoted;
    this.releaseQuietIncarnations(entry, now);
    return promoted;
  }

  /** Release every held incarnation that has gone quiet for the idle TTL, freeing its slot. */
  private releaseQuietIncarnations(entry: ProducerDeduplication, now: number): void {
    for (const [incarnation, window] of entry.held) {
      if (this.hasGoneQuiet(window, now)) entry.held.delete(incarnation);
    }
  }

  /**
   * Whether an incarnation has sent nothing for `producerIdleTtlMs`.
   *
   * The same boundary the sweep draws, so "promotable" and "swept" never
   * disagree about one instant.  An infinite TTL makes nothing quiet, which is
   * what that setting already means for the sweep.
   */
  private hasGoneQuiet(window: DeduplicationState, now: number): boolean {
    return now - window.lastSeenAtMs >= this.producerIdleTtlMs;
  }

  /**
   * A window nothing has been delivered in yet.  The zero timestamp is a
   * placeholder it never leaves with: every caller hands it to {@link touch},
   * the only writer of `lastSeenAtMs`.
   */
  private freshWindow(incarnation: string): DeduplicationState {
    return { incarnation, contiguous: 0, above: new Set(), lastSeenAtMs: 0 };
  }

  /**
   * Stamp a window and its producer's entry as just-used, and move the entry
   * to the most-recently-used end.
   *
   * The `delete` is what does the moving — `set` on a key the map already
   * holds updates the value and leaves the key where it was — and it is a
   * harmless no-op for a key that is genuinely new.
   */
  private touch(producerId: string, entry: ProducerDeduplication, state: DeduplicationState): AdmittedWindow {
    const now = this.system.clock.now();
    state.lastSeenAtMs = now;
    entry.lastSeenAtMs = now;
    this.deduplication.delete(producerId);
    this.deduplication.set(producerId, entry);
    return { entry, state };
  }

  /**
   * Refuse a delivery under one incarnation more than
   * `maxIncarnationsPerProducer` allows: a dead letter, no handler call and no
   * acknowledgment, so its producer keeps it and retransmits until a held
   * incarnation goes quiet and frees a slot.  Refusing rather than evicting a
   * held window is the trade `maxOutOfOrder` makes — an eviction would re-run
   * the handler for messages already acknowledged, a refusal only delays them.
   *
   * Not through {@link deadLetter}: that warns once per envelope, and this is
   * the path a sender minting incarnations drives at message rate.
   */
  private refuseIncarnation(message: Delivery<T>): void {
    this.reportIncarnationRefusals();
    this.system.deadLetters.tell(new DeadLetter(message, this.sender.toNullable(), this.self));
  }

  /**
   * Name incarnation refusals at most once per
   * {@link DEDUPLICATION_REPORT_INTERVAL_MS}, each line carrying how many it
   * stands for.  The incarnation and the `producerId` are peer-supplied text
   * and stay out of the line, as they do in {@link reportEvictions}.
   */
  private reportIncarnationRefusals(): void {
    this.refusedIncarnationsSinceReport++;
    const now = this.system.clock.now();
    if (now - this.lastIncarnationRefusalReportAtMs < DEDUPLICATION_REPORT_INTERVAL_MS) return;
    this.lastIncarnationRefusalReportAtMs = now;
    const count = this.refusedIncarnationsSinceReport;
    this.refusedIncarnationsSinceReport = 0;
    this.log.warn(
      `consumer refused ${count} deliver${count === 1 ? 'y' : 'ies'} under one producer incarnation too many `
      + `(maxIncarnationsPerProducer=${this.maxIncarnationsPerProducer}); each is a dead letter, unhandled and `
      + 'unacknowledged, and is admitted on retransmit once a held incarnation has gone quiet for '
      + `producerIdleTtlMs=${this.producerIdleTtlMs}`,
    );
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
    const now = this.system.clock.now();
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
    const cutoff = this.system.clock.now() - this.producerIdleTtlMs;
    let swept = 0;
    for (const [producerId, entry] of this.deduplication) {
      if (entry.lastSeenAtMs > cutoff) break;
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
    const now = this.system.clock.now();
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

  /**
   * Raise a window to the producer's low-water mark (#1862): every seq below
   * `floor` has been acknowledged, so the handler has run for it and it will
   * not be sent again.
   *
   * This is what lets a window the consumer dropped — swept, evicted, demoted
   * by a promotion, or lost with a restart — pick its producer up at N+1.
   * Without it the fresh window waited at 0 for seqs 1..N, parked everything
   * from N+1 in `above`, and refused the producer for good at
   * `maxOutOfOrder`.
   *
   * It moves only `state`, the window of the incarnation the envelope names,
   * so a floor under an incarnation the consumer has not seen lands in that
   * incarnation's held window and never in the live one — the boundary #1237
   * drew.  It never lowers `contiguous`, so a reordered envelope carrying an
   * older floor changes nothing.  Retained seqs at or below the new mark are
   * released before sliding on, or they would count against `maxOutOfOrder`
   * for good.
   */
  private raiseFloor(state: DeduplicationState, floor: number): void {
    if (floor - 1 <= state.contiguous) return;
    state.contiguous = floor - 1;
    for (const seq of state.above) {
      if (seq <= state.contiguous) state.above.delete(seq);
    }
    while (state.above.delete(state.contiguous + 1)) state.contiguous++;
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
   * What a forged `replyTo` can reach is wider than this note used to claim.
   * It argued that an `ActorRef` has no wire representation, so only a party
   * already holding a ref in this process could name its actor.  It has one:
   * `cluster/RefCodec.ts` encodes a ref inside a message body as an address
   * marker, and the receiving node decodes the marker back into a live ref —
   * a local actor when it names this node — which {@link isAdmissible} then
   * accepts like any other.  `ConsumerReplyToAcrossNodes.test.ts` in
   * `tests/unit/delivery` pins it across two nodes: a delivery a peer wrote
   * with `replyTo` naming a `/user` actor on the consumer's node is handled,
   * and the `Acknowledgment` reaches that actor.  So a peer able to send to a
   * consumer under `/user` chooses where the acknowledgment goes — within the
   * trust checks the decoder applies to a same-node marker, which are the ones
   * an envelope's own target goes through (#1572): a `/system` actor, or a
   * `/user` actor off the `untrusted-mode` allow-list, decodes to `Nobody`.
   * That is the decoder's decision, and nothing here repeats it.
   *
   * What reaches that target is one `Acknowledgment` per delivery, carrying
   * four fields the sender wrote itself; and a real producer on the receiving
   * end discards it, because the incarnation will not match.  That echo is
   * what actually authenticates an acknowledgment, and it stays where it can
   * be checked against something unguessable — on the producer, not here.
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
