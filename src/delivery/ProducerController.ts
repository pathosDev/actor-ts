import { match } from 'ts-pattern';
import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { Cancellable } from '../Scheduler.js';
import { ProducerControllerOptionsValidator } from './ProducerControllerOptions.js';
import type { ProducerControllerOptions, ProducerControllerOptionsType } from './ProducerControllerOptions.js';
import type { Acknowledgment, ConfirmationCallback, Delivery } from './Messages.js';
import { GENERATED_PRODUCER_ID_LENGTH, PRODUCER_INCARNATION_LENGTH } from './Constants.js';
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
   */
  private readonly incarnation = randomId(PRODUCER_INCARNATION_LENGTH);
  private readonly resendTimeoutMs: number;
  private readonly windowSize: number;

  public readonly options: ProducerControllerOptionsType<T>;

  constructor(options: ProducerControllerOptions<T>) {
    super();
    const resolvedOptions = options as ProducerControllerOptionsType<T>;
    new ProducerControllerOptionsValidator<T>().validate(resolvedOptions);
    this.options = resolvedOptions;
    this.id = resolvedOptions.producerId ?? nextProducerId();
    this.resendTimeoutMs = resolvedOptions.resendTimeout ?? 500;
    this.windowSize = resolvedOptions.windowSize ?? 16;
  }

  /**
   * Both queues owe their caller a settlement.  In-flight sends used to get
   * only their resend timer cancelled — so a caller awaiting `confirm` was
   * never told the producer had stopped and simply hung, which is the one
   * outcome a confirmation callback exists to prevent.
   */
  override postStop(): void {
    for (const inflight of this.inflight.values()) {
      inflight.timer?.cancel();
      inflight.confirm?.(new Error('producer stopped'));
    }
    for (const pending of this.pending) pending.confirm?.(new Error('producer stopped'));
    this.pending.length = 0;
    this.inflight.clear();
  }

  override onReceive(message: ProducerSend<T> | Acknowledgment): void {
    match(message)
      .with({ kind: 'reliable-delivery.ack' }, (m) => this.onAcknowledgment(m))
      .with({ kind: 'reliable-delivery.send' }, (m) => this.onSend(m))
      .exhaustive();
  }

  private onSend(message: ProducerSend<T>): void {
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

  private send(inflight: InFlight<T>): void {
    inflight.attempts++;
    const delivery: Delivery<T> = {
      kind: 'reliable-delivery.delivery',
      producerId: this.id,
      incarnation: this.incarnation,
      seq: inflight.seq,
      body: inflight.body,
      replyTo: this.self as unknown as ActorRef<Acknowledgment>,
    };
    this.options.consumer.tell(delivery);
    inflight.timer = this.system.scheduler.scheduleOnceFunction(
      this.resendTimeoutMs,
      () => {
        // Only resend if still un-acked.
        const current = this.inflight.get(inflight.seq);
        if (!current) return;
        this.send(current);
      },
    );
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
    inflight.confirm?.(null);
    // Drain queued sends while the window is open.
    while (this.inflight.size < this.windowSize && this.pending.length > 0) {
      this.dispatch(this.pending.shift()!);
    }
  }
}
