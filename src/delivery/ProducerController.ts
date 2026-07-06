import { Actor } from '../Actor.js';
import type { ActorRef } from '../ActorRef.js';
import type { Cancellable } from '../Scheduler.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { Ack, ConfirmationCallback, Delivery } from './Messages.js';

let producerSeed = 0;
const nextProducerId = (): string => `producer-${++producerSeed}`;

/** Message sent to the ProducerController by the publishing user code. */
export interface ProducerSend<T> {
  readonly kind: 'reliable-delivery.send';
  readonly body: T;
  readonly confirm?: ConfirmationCallback;
}

export interface ProducerControllerSettings<T> {
  readonly consumer: ActorRef<Delivery<T>>;
  /**
   * How long to wait for an Ack before re-sending.  Default 500ms.
   */
  readonly resendTimeoutMs?: number;
  /**
   * Flow-control window: at most `windowSize` messages may be in-flight
   * (un-acked) at any moment.  Additional Sends queue until room opens up.
   * Default: 16.
   */
  readonly windowSize?: number;
  /** Stable identifier used by consumers to dedup across restarts. */
  readonly producerId?: string;
}

/**
 * Fluent builder for {@link ProducerControllerSettings}.  The
 * `consumer` ref is required — pass it via {@link withConsumer} before
 * `build()`; the remaining fields default (resend 500 ms, window 16,
 * generated producer id) when left unset.
 *
 *     ProducerControllerOptions.create<Cmd>()
 *       .withConsumer(consumerRef)
 *       .withWindowSize(32);
 */
export class ProducerControllerOptions<T> extends OptionsBuilder<ProducerControllerSettings<T>> {
  /** Start a fresh builder.  Equivalent to `new ProducerControllerOptions<T>()`. */
  static create<T>(): ProducerControllerOptions<T> {
    return new ProducerControllerOptions<T>();
  }

  /** Consumer that receives the deliveries and Acks back.  Required. */
  withConsumer(consumer: ActorRef<Delivery<T>>): this {
    return this.set('consumer', consumer);
  }

  /** How long to wait for an Ack before re-sending, in ms.  Default 500. */
  withResendTimeout(ms: number): this {
    return this.set('resendTimeoutMs', ms);
  }

  /** Flow-control window: max in-flight (un-acked) messages.  Default 16. */
  withWindowSize(size: number): this {
    return this.set('windowSize', size);
  }

  /** Stable identifier used by consumers to dedup across restarts. */
  withProducerId(producerId: string): this {
    return this.set('producerId', producerId);
  }
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
 * actor keeps retrying until it gets an Ack back.
 */
export class ProducerController<T> extends Actor<ProducerSend<T> | Ack> {
  private readonly inflight = new Map<number, InFlight<T>>();
  private readonly pending: ProducerSend<T>[] = [];
  private nextSeq = 1;
  private readonly id: string;
  private readonly resendTimeoutMs: number;
  private readonly windowSize: number;

  public readonly settings: ProducerControllerSettings<T>;

  constructor(options: ProducerControllerOptions<T>) {
    super();
    const settings = options.build() as ProducerControllerSettings<T>;
    this.settings = settings;
    this.id = settings.producerId ?? nextProducerId();
    this.resendTimeoutMs = settings.resendTimeoutMs ?? 500;
    this.windowSize = settings.windowSize ?? 16;
  }

  override postStop(): void {
    for (const f of this.inflight.values()) f.timer?.cancel();
    for (const p of this.pending) p.confirm?.(new Error('producer stopped'));
    this.pending.length = 0;
    this.inflight.clear();
  }

  override onReceive(msg: ProducerSend<T> | Ack): void {
    if ((msg as Ack).kind === 'reliable-delivery.ack') return this.handleAck(msg as Ack);
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
    const f: InFlight<T> = { seq, body: msg.body, confirm: msg.confirm, attempts: 0, timer: null };
    this.inflight.set(seq, f);
    this.send(f);
  }

  private send(f: InFlight<T>): void {
    f.attempts++;
    const delivery: Delivery<T> = {
      kind: 'reliable-delivery.delivery',
      producerId: this.id,
      seq: f.seq,
      body: f.body,
      replyTo: this.self as unknown as ActorRef<Ack>,
    };
    this.settings.consumer.tell(delivery);
    f.timer = this.system.scheduler.scheduleOnceFn(
      this.resendTimeoutMs,
      () => {
        // Only resend if still un-acked.
        const current = this.inflight.get(f.seq);
        if (!current) return;
        this.send(current);
      },
    );
  }

  private handleAck(msg: Ack): void {
    if (msg.producerId !== this.id) return;
    const f = this.inflight.get(msg.seq);
    if (!f) return;
    f.timer?.cancel();
    this.inflight.delete(msg.seq);
    f.confirm?.(null);
    // Drain queued sends while the window is open.
    while (this.inflight.size < this.windowSize && this.pending.length > 0) {
      this.dispatch(this.pending.shift()!);
    }
  }
}
