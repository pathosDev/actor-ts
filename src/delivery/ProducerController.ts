import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { Cancellable } from '../Scheduler.js';
import { ProducerControllerOptionsValidator } from './ProducerControllerOptions.js';
import type { ProducerControllerOptions, ProducerControllerOptionsType } from './ProducerControllerOptions.js';
import type { Acknowledgment, ConfirmationCallback, Delivery } from './Messages.js';

let producerSeed = 0;
const nextProducerId = (): string => `producer-${++producerSeed}`;

/** Message sent to the ProducerController by the publishing user code. */
export interface ProducerSend<T> {
  readonly kind: 'reliable-delivery.send';
  readonly body: T;
  readonly confirm?: ConfirmationCallback;
}

interface InFlight<T> {
  readonly seq: number;
  readonly body: T;
  readonly confirm?: ConfirmationCallback;
  attempts: number;
  timer: Cancellable | null;
}

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

  override postStop(): void {
    for (const inflight of this.inflight.values()) inflight.timer?.cancel();
    for (const pending of this.pending) pending.confirm?.(new Error('producer stopped'));
    this.pending.length = 0;
    this.inflight.clear();
  }

  override onReceive(msg: ProducerSend<T> | Acknowledgment): void {
    if ((msg as Acknowledgment).kind === 'reliable-delivery.ack') return this.handleAcknowledgment(msg as Acknowledgment);
    if ((msg as ProducerSend<T>).kind === 'reliable-delivery.send') return this.handleSend(msg as ProducerSend<T>);
  }

  private handleSend(msg: ProducerSend<T>): void {
    if (this.inflight.size >= this.windowSize) {
      this.pending.push(msg);
      return;
    }
    this.dispatch(msg);
  }

  private dispatch(msg: ProducerSend<T>): void {
    const seq = this.nextSeq++;
    const inflight: InFlight<T> = { seq, body: msg.body, confirm: msg.confirm, attempts: 0, timer: null };
    this.inflight.set(seq, inflight);
    this.send(inflight);
  }

  private send(inflight: InFlight<T>): void {
    inflight.attempts++;
    const delivery: Delivery<T> = {
      kind: 'reliable-delivery.delivery',
      producerId: this.id,
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

  private handleAcknowledgment(msg: Acknowledgment): void {
    if (msg.producerId !== this.id) return;
    const inflight = this.inflight.get(msg.seq);
    if (!inflight) return;
    inflight.timer?.cancel();
    this.inflight.delete(msg.seq);
    inflight.confirm?.(null);
    // Drain queued sends while the window is open.
    while (this.inflight.size < this.windowSize && this.pending.length > 0) {
      this.dispatch(this.pending.shift()!);
    }
  }
}
