import type { Envelope } from '../internal/Mailbox.js';
import { RingBuffer } from '../util/RingBuffer.js';
import type { BoundedMailboxOverflow } from './BoundedMailboxOptions.js';
import {
  ControlAwareMailboxOptionsValidator,
  type ControlAwareMailboxOptions,
  type ControlAwareMailboxOptionsType,
} from './ControlAwareMailboxOptions.js';
import { DroppingMailbox, MailboxFullError } from './DroppingMailbox.js';

/**
 * A mailbox that lets **control** messages overtake queued bulk traffic: two
 * FIFO classes, every control message dequeued before every ordinary one,
 * arrival order kept inside each class (#1431).
 *
 * Opt-in, and a mailbox *type* rather than a lane in every mailbox.  The
 * framework's own rule is the opposite one — an envelope that comes through
 * the exempt door is undroppable, not early (see {@link Mailbox.enqueueSignal})
 * — and only a handful of messages could use a third lane without breaking an
 * ordering someone relies on.  So the capability lives where an actor that
 * wants it asks for it, and every other actor's queue and drain loop stay as
 * they are.  The predicate decides the class; the framework's own envelopes
 * are classified like any other message.
 *
 * ## Where each class lives
 *
 * The **ordinary** class is the base user queue, and that is load-bearing
 * rather than a convenience.  The protected eviction seams
 * {@link Mailbox.removeOldest} and {@link Mailbox.removeNewest} scan that
 * queue, so inheriting them means they keep answering — for the ordinary
 * class, the only one a bound may shed from — instead of returning
 * `undefined` forever over a store they never read, which is the trap
 * `PriorityMailbox` documents (#407) and a decorator around an inner mailbox
 * cannot avoid: it can delegate the public methods, but not a `protected` one.
 * The **control** class is a {@link RingBuffer} of its own, for the same
 * reason the base queue is one: a deep backlog must not make each delivery
 * cost a reindex.
 *
 * ## The bound
 *
 * A capacity counts ordinary messages only, and every overflow policy acts on
 * the ordinary class only.  A control message is admitted at any depth, never
 * evicted, never reported as a drop, and never makes `reject` throw: the
 * flood a bound sheds is the traffic the control message was overtaking, and
 * shedding the one message the mailbox was chosen for would invert it.  So
 * the bound is a ceiling on the ordinary class, and the control class is
 * bounded by whatever produces it — size it, and choose the predicate,
 * accordingly.
 *
 * ## The predicate
 *
 * Runs at every door — `enqueue`, `enqueueSignal` and `prependUser` — on the
 * caller's stack, and is contained there: a throw, or any answer but `true`,
 * classes the message ordinary and nothing escapes into the `tell`.  The same
 * argument as `PriorityMailbox.priorityOf` (#733): a sender is a bystander to
 * the receiver's mailbox configuration, and `PoisonPill` / `Kill` reach the
 * predicate as user messages with no fields.  Ordinary is also the right
 * fallback rather than merely the safe one — it is the class the message
 * would have had on any other mailbox.
 *
 * A replay re-runs it, so a stashed message rejoins whichever class the
 * predicate puts it in *now*; for a predicate that only reads the message's
 * shape, that is the class it left.
 */
export class ControlAwareMailbox<T = unknown> extends DroppingMailbox<T> {
  private readonly isControl: (message: T) => boolean;
  private readonly capacity: number | undefined;
  private readonly overflow: BoundedMailboxOverflow;
  /** The control class.  The ordinary class is the base user queue — see the class comment. */
  private readonly controlQueue = new RingBuffer<Envelope<T>>();

  constructor(options: ControlAwareMailboxOptions<T>) {
    // Read straight off the argument rather than from `settings`: the base
    // owns the field and has to be constructed before `settings` exists.
    super((options as Partial<ControlAwareMailboxOptionsType<T>>).deadLetterDrops);
    const settings = { ...(options as Partial<ControlAwareMailboxOptionsType<T>>) };
    new ControlAwareMailboxOptionsValidator<T>().validate(settings);
    this.isControl = settings.isControl!;
    this.capacity = settings.capacity;
    this.overflow = settings.overflow ?? 'reject';
    // The caller's hook is just the first observer — see `DroppingMailbox`.
    if (settings.onDrop !== undefined) this.observeDrops(settings.onDrop);
  }

  /**
   * Control to the control class, whatever the bound says; ordinary to the
   * ordinary class, under it.
   *
   * A `switch` with an exhaustive `never` rather than a `match`, for the
   * reason `BoundedMailbox.enqueue` gives: the policy is configuration fixed
   * at construction, not an incoming message, and this branch runs once per
   * shed message — at the moment the system is least able to afford a
   * matcher and a closure per arm (#974).
   */
  override enqueue(envelope: Envelope<T>): void {
    if (this.classesAsControl(envelope.message)) {
      this.controlQueue.push(envelope);
      return;
    }
    const capacity = this.capacity;
    if (capacity !== undefined && super.size >= capacity) {
      switch (this.overflow) {
        case 'drop-head': {
          // Ordinary only, by construction: the base eviction scans the base
          // queue, which is the ordinary class.  Undefined when everything
          // queued there is undroppable — the arrival is admitted anyway and
          // nothing is reported, exactly as on `BoundedMailbox` (#729).
          const dropped = super.removeOldest();
          if (dropped !== undefined) this.reportDrop('drop-head', dropped);
          super.enqueue(envelope);
          return;
        }
        case 'drop-new':
          this.reportDrop('drop-new', envelope);
          return;
        case 'reject':
          throw new MailboxFullError(capacity);
        default: {
          const _exhaustive: never = this.overflow;
          void _exhaustive;
          throw new MailboxFullError(capacity);
        }
      }
    }
    super.enqueue(envelope);
  }

  /**
   * The exempt door classifies too — see {@link Mailbox.enqueueSignal}.
   *
   * An undroppable **ordinary** envelope — a `Terminated` this predicate
   * leaves ordinary, a WebSocket `close` — is admitted past the bound at the
   * tail of the ordinary class, which is exactly the position the framework's
   * rule gives it on every other mailbox: death watch keeps its order here
   * unless the predicate says otherwise.  An undroppable **control** envelope
   * joins the control class, which no bound sheds anyway.
   */
  override enqueueSignal(envelope: Envelope<T>): void {
    if (this.classesAsControl(envelope.message)) this.controlQueue.push(envelope);
    else super.enqueue(envelope);
  }

  /**
   * A replay goes back to the head of each envelope's own class — a stash's
   * `unstashAll()`, and the cell's throttle re-park, which hands back the
   * envelope it just dequeued.  Back at the head of the ordinary class, a
   * re-parked control message would be overtaken by the very traffic it had
   * overtaken.
   *
   * The ordinary half meets the bound under `BoundedMailbox.prependUser`'s
   * rules (#772), restated in {@link admitOrdinaryReplay}.  The control half
   * is never bounded.  Under `reject` the decision is taken before anything is
   * admitted, the control half included: `ActorCell.unstashAll` puts a refused
   * batch back into the stash, and a control envelope admitted on the way to
   * the throw would then be queued and stashed at once — delivered twice.
   */
  override prependUser(envelopes: Array<Envelope<T>>): void {
    if (envelopes.length === 0) return;
    const control: Array<Envelope<T>> = [];
    const ordinary: Array<Envelope<T>> = [];
    for (const envelope of envelopes) {
      if (this.classesAsControl(envelope.message)) control.push(envelope);
      else ordinary.push(envelope);
    }
    const admitted = this.admitOrdinaryReplay(ordinary);
    this.controlQueue.unshiftAll(control);
    super.prependUser(admitted);
  }

  /**
   * The ordinary half of a replay, bounded the way `BoundedMailbox.prependUser`
   * bounds a whole one (#772) — read that override for the reasoning; this is
   * the same rule over the ordinary class.
   *
   * The replay lands at the head, so `drop-head` makes room at the *tail*
   * ({@link Mailbox.removeNewest}), and reports `drop-new` for an arrival it
   * cannot make room for.  `reject` throws before admitting anything.  An
   * {@link Envelope.undroppable} envelope is admitted whatever the policy says
   * and is never counted (#729), which is also why `reject` counts only the
   * droppable ones against the room left.
   */
  private admitOrdinaryReplay(envelopes: Array<Envelope<T>>): Array<Envelope<T>> {
    const capacity = this.capacity;
    if (capacity === undefined || envelopes.length === 0) return envelopes;
    // Read once into a local: the policy is fixed at construction, and the
    // local is what lets the `never` check below narrow after the `reject`
    // arm has returned.
    const overflow = this.overflow;
    if (overflow === 'reject') {
      let droppable = 0;
      for (const envelope of envelopes) if (envelope.undroppable !== true) droppable++;
      // `Math.max` because the ordinary class may already sit above capacity —
      // that is what an exempt `enqueueSignal` does.
      if (droppable > Math.max(0, capacity - super.size)) throw new MailboxFullError(capacity);
      return envelopes;
    }
    const admitted: Array<Envelope<T>> = [];
    for (const envelope of envelopes) {
      if (envelope.undroppable === true || super.size + admitted.length < capacity) {
        admitted.push(envelope);
        continue;
      }
      switch (overflow) {
        case 'drop-head': {
          const evicted = super.removeNewest();
          if (evicted === undefined) {
            // Nothing queued may be dropped, so there is no room to make and
            // the arrival is the one discarded — `drop-new`, whatever the
            // policy is called.
            this.reportDrop('drop-new', envelope);
            break;
          }
          this.reportDrop('drop-head', evicted);
          admitted.push(envelope);
          break;
        }
        case 'drop-new':
          this.reportDrop('drop-new', envelope);
          break;
        default: {
          const _exhaustive: never = overflow;
          void _exhaustive;
          throw new MailboxFullError(capacity);
        }
      }
    }
    return admitted;
  }

  /** Control first — the whole point — then the ordinary class, FIFO inside each. */
  override dequeueUser(): Envelope<T> | undefined {
    if (this.suspended) return undefined;
    return this.controlQueue.shift() ?? super.dequeueUser();
  }

  /**
   * Both classes.  The cell reads this for the high-water warning and the
   * depth metrics, and a backlog of control messages is a backlog.  The bound
   * reads the ordinary class alone, through the base getter.
   */
  override get size(): number { return this.controlQueue.length + super.size; }

  override hasUserMessages(): boolean { return this.controlQueue.length > 0 || super.hasUserMessages(); }

  override hasMessages(): boolean {
    return super.hasMessages() || (!this.suspended && this.controlQueue.length > 0);
  }

  /** Control, then ordinary — the order they would have been delivered in. */
  override drainUser(): Envelope<T>[] {
    const control = this.controlQueue.drain();
    const ordinary = super.drainUser();
    return control.length === 0 ? ordinary : control.concat(ordinary);
  }

  /**
   * The contained classification.  `=== true` rather than truthiness, so an
   * answer of `1`, `'yes'` or an object — what a predicate that returns a
   * field rather than a comparison produces — cannot promote a message by
   * accident.
   */
  private classesAsControl(message: T): boolean {
    try {
      return this.isControl(message) === true;
    } catch {
      return false;
    }
  }
}
