import type { Envelope } from '../internal/Mailbox.js';
import { DroppingMailbox, MailboxFullError } from './DroppingMailbox.js';
import { BoundedMailboxOptionsValidator, type BoundedMailboxOptions, type BoundedMailboxOptionsType, type BoundedMailboxOverflow } from './BoundedMailboxOptions.js';

// Re-exported from its historical home so `import { MailboxFullError } from
// './BoundedMailbox.js'` keeps resolving — the class moved to
// `DroppingMailbox.ts` when `PriorityMailbox` became the second mailbox that
// can raise it (#647).
export { MailboxFullError } from './DroppingMailbox.js';

/**
 * Mailbox with a fixed upper bound on queued user messages.  Policy for
 * what happens when a message arrives on a full mailbox is configurable.
 */
export class BoundedMailbox<T = unknown> extends DroppingMailbox<T> {
  private readonly capacity: number;
  private readonly overflow: BoundedMailboxOverflow;

  constructor(options: BoundedMailboxOptions) {
    super();
    const settings = { ...(options as Partial<BoundedMailboxOptionsType>) };
    new BoundedMailboxOptionsValidator().validate(settings);
    this.capacity = settings.capacity!;
    this.overflow = settings.overflow ?? 'reject';
    // The caller's hook is just the first observer — see `DroppingMailbox`.
    if (settings.onDrop !== undefined) this.observeDrops(settings.onDrop);
  }

  /**
   * A `switch` rather than a `match`, deliberately.
   *
   * The pattern-matching convention governs dispatch of an incoming *message,
   * event or command*; `overflow` is none of those — it is a configuration
   * value fixed at construction, and this is the shape the codebase already
   * uses for a closed string-literal union (see `decodeCrdt` in
   * `crdt/DistributedData.ts`, which documents itself as the reference).
   *
   * It matters here because of *when* this branch runs.  A matcher plus one
   * closure per arm was being built for every message that arrived at a full
   * mailbox — that is, once per shed message, at the exact moment the system
   * is already past its capacity and least able to afford it (#974).
   * Exhaustiveness is not lost, only moved: the `never` assignment below fails
   * to compile if a fourth policy is added without an arm here.
   */
  override enqueue(env: Envelope<T>): void {
    if (this.size >= this.capacity) {
      switch (this.overflow) {
        case 'drop-head': {
          // `removeOldest` rather than `dequeueUser`: the latter returns
          // undefined while the mailbox is suspended, which used to make this
          // whole arm a no-op — the queue grew past capacity and the drop was
          // reported anyway.  Counting is gated on an actual removal so the
          // metric cannot claim a drop that did not happen.
          //
          // Since #729 it also returns undefined when everything queued is a
          // lifecycle notification that may not be dropped.  The arrival is
          // still admitted: the bound is a memory ceiling, and overshooting it
          // by the size of a watch set is a smaller price than blinding the
          // watcher.  Nothing is reported, because nothing was discarded.
          const dropped = super.removeOldest();
          if (dropped !== undefined) this.reportDrop('drop-head');
          super.enqueue(env);
          return;
        }
        case 'drop-new':
          this.reportDrop('drop-new');
          return;
        case 'reject':
          throw new MailboxFullError(this.capacity);
        default: {
          const _exhaustive: never = this.overflow;
          void _exhaustive;
          throw new MailboxFullError(this.capacity);
        }
      }
    }
    super.enqueue(env);
  }

  /**
   * A death notification is queued whatever the bound says — see
   * {@link Mailbox.enqueueSignal}.
   *
   * Straight to the base queue, past the capacity check, and that is the whole
   * override: every one of the three policies destroyed the notification
   * otherwise, each in its own way (#729).  `drop-head` evicted whatever sat
   * at the front, `drop-new` discarded the notification on arrival — the more
   * likely of the two, since a `Terminated` arrives *late* relative to the
   * flood that filled the queue — and `reject` was worse than either: it threw
   * `MailboxFullError` synchronously on the **sender's** stack, and the sender
   * is the dying cell's own watcher-notify loop.  That throw escaped
   * `finalizeTermination` mid-loop, so the remaining watchers went unnotified,
   * the parent was never told the child had stopped, and `terminate()` never
   * settled.  `reject` is also this class's constructor default, so the
   * documented `withMailbox(() => new BoundedMailbox({ capacity: n }))` shape
   * reached it without naming it.
   */
  override enqueueSignal(env: Envelope<T>): void {
    super.enqueue(env);
  }

  /**
   * A replay meets the bound, the same way an arrival does (#772).
   *
   * Until this override existed the base `prependUser` wrote straight to the
   * queue, so `unstashAll()` unshifted a whole stash — up to
   * `DEFAULT_STASH_CAPACITY` envelopes — past the capacity check, past the
   * `switch` above and past the drop accounting.  A `reject` mailbox never
   * threw, a `drop-head` / `drop-new` mailbox never dropped, and
   * `droppedCount` / `actor_mailbox_dropped_total` under-reported by exactly
   * the batch.  The advertised memory ceiling was not one: `capacity: 10`
   * could become 1034.
   *
   * **Which end sheds.** The policy is unchanged, only the geometry is: an
   * arrival lands at the tail and `drop-head` makes room at the head, a
   * replay lands at the head and so makes room at the *tail*.  Both read as
   * "admit the arrival, evict a queued message from the far end", and the
   * other choice is indefensible here — evicting the head under a prepend
   * would discard the messages the replay just put back, which is not a bound
   * but a way of making `unstashAll()` a no-op.
   *
   * **Which reason is reported.** `drop-head` when a queued message was
   * evicted, `drop-new` when the arrival itself was refused — the closed
   * two-value vocabulary of `MailboxDropReason`, applied by what actually
   * happened rather than by which policy is configured.  So a
   * `drop-head` mailbox does report `drop-new` for the tail of a batch bigger
   * than its capacity: once the queue holds nothing droppable, there is no
   * room to make and the arrival is what goes.  That is where this diverges
   * from `enqueue`, which admits and overshoots by one in the same situation
   * — one envelope over a bound is the arrival rate, a whole stash over it is
   * the defect.
   *
   * **What `reject` does.** It throws `MailboxFullError`, and it throws
   * *before admitting anything*: all-or-nothing, so a caller that catches it
   * knows the batch is entirely still its own.  The throw lands on the
   * actor's own stack, inside its `unstashAll()`, rather than on a remote
   * sender's — and that is the closest thing to a sender a replay has.  It is
   * also not a message lost: `ActorCell.unstashAll` puts the batch back into
   * the stash before the error travels on, so the envelopes stay parked and
   * `deadLetterStash` still sees them if supervision then restarts or stops
   * the actor.  Choosing `reject` says "refuse, do not lose", and refusing
   * the replay of a stash that no longer fits is what that means here.
   *
   * An {@link Envelope.undroppable} envelope is admitted whatever the policy
   * says and is never counted, exactly as {@link enqueueSignal} admits one at
   * the tail: a `Terminated` that round-tripped through a stash must not
   * become droppable on the way back in (#729).
   */
  override prependUser(envelopes: Array<Envelope<T>>): void {
    if (envelopes.length === 0) return;
    // Read once into a local: the policy is fixed at construction, and the
    // local is what lets the `never` check below narrow after the `reject`
    // arm has returned.
    const overflow = this.overflow;
    if (overflow === 'reject') {
      let droppable = 0;
      for (const envelope of envelopes) if (envelope.undroppable !== true) droppable++;
      // `Math.max` because the queue may already sit above capacity — that is
      // what an exempt `enqueueSignal` does — and a batch of pure
      // notifications must still get in rather than be refused for a bound it
      // is not subject to.
      if (droppable > Math.max(0, this.capacity - this.size)) {
        throw new MailboxFullError(this.capacity);
      }
      super.prependUser(envelopes);
      return;
    }
    const admitted: Array<Envelope<T>> = [];
    for (const envelope of envelopes) {
      // `this.size + admitted.length` rather than a running counter: eviction
      // moves `size` underneath the loop, and a counter that has to be kept in
      // step with it is a bug waiting for the first policy that evicts twice.
      if (envelope.undroppable === true || this.size + admitted.length < this.capacity) {
        admitted.push(envelope);
        continue;
      }
      switch (overflow) {
        case 'drop-head': {
          const evicted = super.removeNewest();
          if (evicted === undefined) {
            // Nothing queued may be dropped, so there is no room to make and
            // the arrival is the one discarded — which is `drop-new`, whatever
            // the policy is called.
            this.reportDrop('drop-new');
            break;
          }
          this.reportDrop('drop-head');
          admitted.push(envelope);
          break;
        }
        case 'drop-new':
          this.reportDrop('drop-new');
          break;
        default: {
          const _exhaustive: never = overflow;
          void _exhaustive;
          throw new MailboxFullError(this.capacity);
        }
      }
    }
    // One bulk move for whatever survived, so the base keeps its non-spread
    // insert and the batch is still O(admitted) rather than O(queue).
    super.prependUser(admitted);
  }
}
