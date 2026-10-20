import { match } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { Cancellable } from '../Scheduler.js';
import {
  DEFAULT_RESEND_TIMEOUT_MS,
  DEFAULT_WINDOW_SIZE,
  ProducerControllerOptionsValidator,
} from './ProducerControllerOptions.js';
import type { ProducerControllerOptions, ProducerControllerOptionsType } from './ProducerControllerOptions.js';
import type { Acknowledgment, ConfirmationCallback, Delivery } from './Messages.js';
import { GENERATED_PRODUCER_ID_LENGTH, PRODUCER_INCARNATION_LENGTH, UNHANDLED_REPORT_INTERVAL_MS } from './Constants.js';
import { randomId } from '../util/RandomString.js';

/**
 * Mints the `producerId` for a controller whose caller did not supply one.
 *
 * The `producer-` prefix is kept because this string is read far more often
 * than it is compared — a log line, a metric label, a key in the consumer's
 * dedup map — and a bare hex blob there says nothing about what it names.
 * Only the counter that used to follow it is gone; see
 * {@link GENERATED_PRODUCER_ID_LENGTH} for why an enumerable, process-shared
 * id was the wrong default (#730).
 */
const nextProducerId = (): string => `producer-${randomId(GENERATED_PRODUCER_ID_LENGTH)}`;

/** Message sent to the ProducerController by the publishing user code. */
export type ProducerSend<T> = {
  readonly kind: 'reliable-delivery.send';
  readonly body: T;
  readonly confirm?: ConfirmationCallback;
};

type InFlight<T> = {
  readonly seq: number;
  readonly body: T;
  readonly confirm?: ConfirmationCallback;
  /**
   * Transmissions of this sequence so far, counted by {@link send} and read by
   * nothing.  **Kept deliberately, not dead weight:** it is the hook #646
   * reserves for a `maxAttempts` ceiling, and a count is the only unit such a
   * ceiling can be expressed in.
   *
   * That nothing reads it is itself load-bearing.  The resend timer in
   * {@link send} re-arms unconditionally, so retransmission on this path is
   * unbounded — which is exactly what makes the consumer's out-of-order
   * refusal (`ConsumerController.handleDelivery`, which withholds the
   * acknowledgment by design) a *stall* rather than a drop.  Both delivery
   * pages say so in those words: reaching the cap "never drops one either; it
   * costs a stall", and the producer retries "until ack arrives or producer
   * stops".
   *
   * So #646 carries an interaction it does not name: a ceiling that cannot
   * tell a consumer *refusing* a sequence from a consumer that is gone turns
   * that documented stall into a silent drop, and would have to distinguish
   * the two or surface the give-up through `confirm(error)`.  The guard is
   * "a real producer stalls at the cap, holds there, and drains once the gap
   * closes" in `tests/unit/delivery/ReliableDelivery.test.ts`, which holds a
   * gap open across several resend periods; measured against a ceiling of
   * three attempts it is the only case in that file that goes red.
   */
  attempts: number;
  timer: Cancellable | null;
};

/**
 * Producer side of the reliable-delivery protocol.  Messages sent to this
 * actor are assigned sequence numbers and shipped to the consumer; the
 * actor keeps retrying until it gets an Acknowledgment back.
 */
export class ProducerController<T> extends Actor<ProducerSend<T> | Acknowledgment> {
  private readonly inflight = new Map<number, InFlight<T>>();
  private readonly pending: ProducerSend<T>[] = [];
  private nextSeq = 1;
  private readonly id: string;
  /**
   * Identity of *this* construction of the controller, minted in the field
   * initialiser so a restart cannot inherit the previous one.
   *
   * `nextSeq` above is an instance field with no seed, so every incarnation
   * starts numbering at 1 again, while `id` is read from the options object
   * the spawn closure captured and therefore survives a restart unchanged.
   * Those two facts in one class were #726: the consumer's dedup entry for
   * `id` outlived the producer, so the whole post-restart prefix satisfied
   * `seq <= contiguous`, was answered with an ordinary ack, and drove
   * `confirm(null)` for messages the consumer's handler never saw.  The
   * incarnation is the discriminator that makes a restart distinguishable
   * from a retransmit, and — being unguessable — is also what an
   * {@link Acknowledgment} has to echo before this actor will act on it
   * (#730).
   *
   * **One token per construction, where #730 suggested one per delivery.**
   * The deviation is recorded here because the commit that closed the issue
   * did not: the criterion asked for a per-delivery nonce, and this is
   * strictly wider.  Every send of this incarnation carries the same string,
   * so any party that legitimately receives *one* delivery — the consumer, a
   * handler that forwards it on, a router fan-out — holds a token that
   * settles every other in-flight seq of this producer for the rest of the
   * actor's life.
   *
   * Adequate under the issue's own threat model, which is an attacker who can
   * tell this actor but is not the consumer: the party holding a delivery is
   * the one that acknowledges it anyway, and without that delivery it could
   * not reach `replyTo` at all.  64 bits is ample against guessing
   * (see {@link PRODUCER_INCARNATION_LENGTH}).  What the wider scope buys is
   * not only a saved per-seq map: the consumer keys its dedup entry on
   * (producerId, incarnation), so a per-delivery token would change that key
   * on every sequence and reset the window each time — measured, narrowing it
   * to `incarnation + seq` fails two consumer-side cases in
   * `tests/unit/delivery/ReliableDelivery.test.ts` for exactly that reason.
   *
   * "one incarnation token settles every send of that producer" in that file
   * pins the scope, so a future per-delivery token turns the record red
   * instead of leaving this note stale.  #1237 is the open consumer-side
   * sibling: nothing binds an inbound delivery to its sender, so a forged
   * incarnation still resets a consumer's window.
   */
  private readonly incarnation = randomId(PRODUCER_INCARNATION_LENGTH);
  private readonly resendTimeoutMs: number;
  private readonly windowSize: number;
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

  public readonly options: ProducerControllerOptionsType<T>;

  constructor(options: ProducerControllerOptions<T>) {
    super();
    const resolvedOptions = options as ProducerControllerOptionsType<T>;
    new ProducerControllerOptionsValidator<T>().validate(resolvedOptions);
    this.options = resolvedOptions;
    this.id = resolvedOptions.producerId ?? nextProducerId();
    this.resendTimeoutMs = resolvedOptions.resendTimeout ?? DEFAULT_RESEND_TIMEOUT_MS;
    this.windowSize = resolvedOptions.windowSize ?? DEFAULT_WINDOW_SIZE;
  }

  /**
   * Both queues owe their caller a settlement.  In-flight sends used to get
   * only their resend timer cancelled — so a caller awaiting `confirm` was
   * never told the producer had stopped and simply hung, which is the one
   * outcome a confirmation callback exists to prevent.
   *
   * Every call goes through {@link settle}, so a callback that throws costs no
   * send but its own: the first throw used to leave this loop, and every send
   * behind it, in either queue, was never told anything (#1230).
   */
  override postStop(): void {
    for (const inflight of this.inflight.values()) {
      inflight.timer?.cancel();
      this.settle(inflight.confirm, new Error('producer stopped'), inflight.seq);
    }
    for (const pending of this.pending) this.settle(pending.confirm, new Error('producer stopped'), null);
    this.pending.length = 0;
    this.inflight.clear();
  }

  /**
   * Tell one send its outcome through its `confirm`, and keep whatever the
   * callback throws away from this actor.
   *
   * The callback is the caller's code, running on this actor's turn.
   * Unguarded, a throw on an acknowledgment left `onReceive` and faulted the
   * producer: the supervisor restarted it, {@link postStop} told every other
   * send in flight and queued `producer stopped`, and the new incarnation
   * numbered from 1 again — one bad callback cost the whole window.  In
   * `postStop` the same throw abandoned the settlement loop (#1230).  So the
   * throw is caught here, and the turn carries on: an acknowledgment still
   * drains the window, a stop still settles every remaining send.
   *
   * Logged and not rethrown: a supervisor can restart this actor, but nothing
   * it does repairs the caller's callback, and the restart is exactly what
   * cost every other send its outcome.
   *
   * A returned promise is not awaited — the type promises `void`, and the
   * settlement does not wait on the caller — but `async` is the natural way to
   * write the durable-producer recipe's "persist that it is done", and such a
   * callback never throws here: it rejects later, and an unhandled rejection
   * ends a Bun or Node process.  The rejection is logged the same way, which is
   * what `EventStream` does for the callbacks it calls.
   */
  private settle(
    confirm: ConfirmationCallback | undefined,
    outcome: Error | null,
    sequenceNumber: number | null,
  ): void {
    try {
      const returned: unknown = confirm?.(outcome);
      if (isThenable(returned)) {
        returned.then(undefined, (error: unknown) => {
          this.reportConfirmFailure('returned a promise that rejected', outcome, sequenceNumber, error);
        });
      }
    } catch (error) {
      this.reportConfirmFailure('threw', outcome, sequenceNumber, error);
    }
  }

  /**
   * The one line a failing `confirm` leaves, with what it threw or rejected
   * with as the line's argument.  It names the seq — a queued send has none
   * yet, so it says that instead — and what the callback was told, because a
   * failure on an acknowledgment leaves a message that *was* delivered.
   */
  private reportConfirmFailure(
    failure: string,
    outcome: Error | null,
    sequenceNumber: number | null,
    error: unknown,
  ): void {
    const send = sequenceNumber === null ? 'a queued send (not yet numbered)' : `seq=${sequenceNumber}`;
    const told = outcome === null ? 'it was delivered' : `'${outcome.message}'`;
    this.log.error(
      `producer ${this.id}: the confirm callback for ${send}, told ${told}, ${failure}; `
      + 'contained, so no other send is affected',
      error,
    );
  }

  override onReceive(message: ProducerSend<T> | Acknowledgment): void {
    match(message)
      .with({ kind: 'reliable-delivery.ack' }, (m) => this.onAcknowledgment(m))
      .with({ kind: 'reliable-delivery.send' }, (m) => this.onSend(m))
      .otherwise((m) => this.onUnhandled(m));
  }

  /**
   * Decline a message that is neither a send nor an acknowledgment, and keep
   * the window.
   *
   * The match used to end in `.exhaustive()`, which throws on a kind it was
   * not written for, and a throw here is a supervised fault: the producer
   * restarted, {@link postStop} settled every send in flight and every send
   * still queued with `producer stopped`, and the new incarnation began again
   * at seq 1 knowing none of them.  One stray message cost the whole window,
   * and the message itself surfaced nowhere.  This ref is not private
   * either — it rides on every delivery as `replyTo`, so the consumer, a
   * handler that forwards a delivery on and, for a controller under `/user`,
   * a cluster peer can all reach it.  The first message work-pulling needs
   * (#1470) is a demand signal travelling back to the producer, which the
   * `.exhaustive()` producer would have met with that restart every time.
   *
   * `this.unhandled` makes the decline visible everywhere but the log: a
   * dead letter naming this producer, and `actor_unhandled_total{class}` for
   * the rate.  The warning is the log's share, paced by
   * {@link reportUnhandled}.  {@link onSend} declines through here as well,
   * for a send it cannot accept.
   */
  private onUnhandled(message: unknown): void {
    this.reportUnhandled();
    this.unhandled(message);
  }

  /**
   * Name declines in the log at most once per
   * {@link UNHANDLED_REPORT_INTERVAL_MS}, each line carrying how many it
   * stands for — the shape of the consumer's paced dedup-bound warnings.
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
      `producer declined ${count} message${count === 1 ? '' : 's'} it could not act on — `
      + 'neither a send nor an acknowledgment, or a send whose confirm is not a function; '
      + 'each one is a dead letter now, and the sends in flight and queued are untouched.  '
      + 'A sender may speak a newer delivery protocol than this producer',
    );
  }

  /**
   * Queue or dispatch a send — after checking the one field of it this actor
   * will call.
   *
   * `confirm` is invoked on the acknowledgment, or in {@link postStop} when
   * none came.  {@link settle} contains whatever that call throws, so a value
   * that is not a function no longer faults this actor — but admitted, such a
   * send is delivered and its outcome can never be reported: the call fails
   * with a `TypeError` that only the log sees.
   * The type says a function, but a send can reach a controller under `/user`
   * from a cluster peer, and JSON has no functions — a `confirm` from there is
   * a string at best.  Checked on arrival, before the send takes a sequence
   * number, it is declined like any message this actor cannot act on: a dead
   * letter naming this producer, and nothing delivered on its behalf.
   * `null` passes: the optional call skips it exactly as it skips `undefined`.
   */
  private onSend(message: ProducerSend<T>): void {
    const confirm: unknown = message.confirm;
    if (confirm !== undefined && confirm !== null && typeof confirm !== 'function') {
      this.onUnhandled(message);
      return;
    }
    if (this.inflight.size >= this.windowSize) {
      this.pending.push(message);
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: ProducerSend<T>): void {
    const seq = this.nextSeq++;
    const inflight: InFlight<T> = { seq, body: message.body, confirm: message.confirm, attempts: 0, timer: null };
    this.inflight.set(seq, inflight);
    this.send(inflight);
  }

  /**
   * Transmit one in-flight send, with its retransmit armed first.
   *
   * The timer is the at-least-once guarantee, and the tell can throw — a
   * bounded mailbox with the `reject` overflow policy throws
   * `MailboxFullError` at the sender.  Armed after the tell, a throw on a
   * retransmit skipped the re-arm, and that seq was never sent again: it held
   * its window slot until the producer stopped (#1230).
   *
   * What a throw does still depends on which transmission it hit.  The first
   * comes from {@link dispatch}, on this actor's turn, so a throw there faults
   * the producer as any failing turn does, and the restart settles every send
   * with `producer stopped`.  A retransmit runs from the scheduler, outside the
   * turn, where a throw never faulted anything — it only lost the re-arm — so
   * {@link retransmit} catches it and the timer armed here sends it again.
   */
  private send(inflight: InFlight<T>): void {
    inflight.attempts++;
    inflight.timer = this.system.scheduler.scheduleOnceFunction(
      this.resendTimeoutMs,
      () => this.retransmit(inflight.seq),
    );
    const delivery: Delivery<T> = {
      kind: 'reliable-delivery.delivery',
      producerId: this.id,
      incarnation: this.incarnation,
      seq: inflight.seq,
      body: inflight.body,
      replyTo: this.self as unknown as ActorRef<Acknowledgment>,
    };
    this.options.consumer.tell(delivery);
  }

  /**
   * Send a seq again when its timer fires, if it is still un-acked.
   *
   * A throw from the consumer's tell is caught here and named: it used to
   * reach the scheduler's own report, which says a task failed and neither
   * which producer nor which seq.  The next attempt is already armed by
   * {@link send}, so the refusal costs one resend period, not the message.
   */
  private retransmit(sequenceNumber: number): void {
    const current = this.inflight.get(sequenceNumber);
    if (!current) return;
    try {
      this.send(current);
    } catch (error) {
      this.log.warn(
        `producer ${this.id}: the consumer refused the retransmit of seq=${sequenceNumber}; `
        + 'it is sent again after the next resend timeout',
        error,
      );
    }
  }

  /**
   * Acting on an acknowledgment is destructive — it cancels the retransmit
   * that is the entire at-least-once guarantee and tells the caller the
   * message landed — so it needs evidence, and `(producerId, seq)` is not
   * evidence.  Both are enumerable, so before #730 anything that could tell
   * this actor could downgrade the stream to at-most-once *and* report
   * success while doing it.  The incarnation closes that: it is crypto-random
   * and leaves this process only on the deliveries this incarnation sent.
   *
   * The check is here rather than on `this.sender`, which is `None` for every
   * acknowledgment the producer will ever see — the consumer tells with one
   * argument and so does the cluster's envelope dispatch — and rather than
   * against `options.consumer`, which nothing requires to be the actor that
   * acknowledges: a consumer ref is free to forward a delivery on, and the
   * ack then arrives from whichever actor handled it.
   *
   * It also rejects an ack from the *previous* incarnation of this
   * `producerId`, which is a real message and not an attack: a delivery still
   * on the wire when the producer restarted can be acked afterwards, and
   * without this the ack would settle whatever the new incarnation happened
   * to have parked under the same seq.
   */
  private onAcknowledgment(message: Acknowledgment): void {
    if (message.producerId !== this.id) return;
    if (message.incarnation !== this.incarnation) return;
    const inflight = this.inflight.get(message.seq);
    if (!inflight) return;
    inflight.timer?.cancel();
    this.inflight.delete(message.seq);
    this.settle(inflight.confirm, null, inflight.seq);
    // Drain queued sends while the window is open.
    while (this.inflight.size < this.windowSize && this.pending.length > 0) {
      this.dispatch(this.pending.shift()!);
    }
  }
}

/** A returned promise, or anything else `await` would treat as one. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}
