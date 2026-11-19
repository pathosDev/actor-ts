/**
 * The reply contract of the consuming broker actors' `'on-reply'`
 * acknowledgment mode (#975, #976, #977), and the bookkeeping that waits for
 * those replies.
 *
 * In `'on-reply'` mode — the default for `KafkaActor`, `AmqpActor` and the
 * foreign targets of `MqttActor` — the broker actor `ask`s its target with
 * the delivery.  `ask` adds a one-shot `replyTo` ref to the delivery, and the
 * target answers on it once it has *processed* the delivery:
 *
 *     override onReceive(record: KafkaRecord): void {
 *       store(record);
 *       acknowledgeDelivery(record);                       // { kind: 'acknowledgment' }
 *     }
 *
 * or, when it could not process it and wants it redelivered:
 *
 *     negativelyAcknowledgeDelivery(record, 'database unavailable');
 *
 * Only an `acknowledgment` reply acknowledges.  A `negativeAcknowledgment`,
 * any other reply, and no reply within `acknowledgmentTimeoutMs` all leave the
 * delivery unacknowledged — the broker redelivers it.  In `'on-delivery'`
 * mode the delivery carries no `replyTo` and both helpers do nothing, so a
 * target written for `'on-reply'` runs unchanged under either mode.
 */
import type { ActorRef } from '../../ActorRef.js';
import type { BrokerAcknowledgmentMode } from './BrokerOptions.js';

/** The target processed the delivery: acknowledge it to the broker. */
type AcknowledgmentReply = { readonly kind: 'acknowledgment' };

/** The target could not process the delivery: give it back to the broker for redelivery. */
type NegativeAcknowledgmentReply = {
  readonly kind: 'negativeAcknowledgment';
  /** Shows up in the broker actor's warn log. */
  readonly reason?: string;
};

/**
 * What a target replies to a delivery in `'on-reply'` mode, on the
 * delivery's `replyTo` (or `this.sender`, which is the same ref).
 */
export type BrokerDeliveryReply = AcknowledgmentReply | NegativeAcknowledgmentReply;

/** A delivery as `'on-reply'` hands it over: whatever the broker delivers, plus the ref to reply on. */
export type BrokerReplyableDelivery = {
  /**
   * Where the {@link BrokerDeliveryReply} goes.  Present in `'on-reply'` mode
   * only — injected by `ask`, never set by the broker actor's caller.
   */
  readonly replyTo?: ActorRef<BrokerDeliveryReply>;
};

/**
 * Reply `{ kind: 'acknowledgment' }` to a delivery: it was processed, and the
 * broker actor may acknowledge or commit it.  A no-op for a delivery that
 * carries no `replyTo` — one delivered in `'on-delivery'` mode.
 */
export function acknowledgeDelivery(delivery: BrokerReplyableDelivery): void {
  delivery.replyTo?.tell({ kind: 'acknowledgment' });
}

/**
 * Reply `{ kind: 'negativeAcknowledgment', reason }` to a delivery: it was not
 * processed, and the broker should redeliver it.  A no-op for a delivery that
 * carries no `replyTo`.
 */
export function negativelyAcknowledgeDelivery(delivery: BrokerReplyableDelivery, reason?: string): void {
  delivery.replyTo?.tell(reason === undefined
    ? { kind: 'negativeAcknowledgment' }
    : { kind: 'negativeAcknowledgment', reason });
}

/**
 * Why a delivery was not acknowledged — a negative reply, an unexpected one,
 * no reply in time, or a connection that went away while the actor waited.
 * The broker actor catches it and leaves the delivery to be redelivered.
 */
export class BrokerDeliveryNotAcknowledgedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerDeliveryNotAcknowledgedError';
  }
}

/**
 * Hands deliveries to targets under one {@link BrokerAcknowledgmentMode} and
 * keeps track of the replies still outstanding, so a teardown can give up on
 * every one of them at once.
 *
 * That last part is not tidiness.  A driver that waits for its handler —
 * kafkajs before it disconnects a consumer, mqtt.js before it reads the next
 * packet — would otherwise hold a stop for a full `acknowledgmentTimeoutMs`
 * per outstanding delivery, waiting for replies to a connection that no longer
 * exists.
 */
export class BrokerAcknowledgmentTracker {
  /** The reject of every reply still outstanding. */
  private readonly outstanding = new Set<(cause: Error) => void>();

  constructor(
    private readonly mode: BrokerAcknowledgmentMode,
    private readonly timeoutMs: number,
  ) {}

  /** Replies still outstanding — exposed for tests. */
  get outstandingCount(): number { return this.outstanding.size; }

  /** Whether deliveries wait for a reply — `'on-reply'` mode. */
  get awaitsReply(): boolean { return this.mode === 'on-reply'; }

  /**
   * Hand `delivery` to `target`.  Resolves once the delivery may be
   * acknowledged — at once in `'on-delivery'` mode, on an `acknowledgment`
   * reply in `'on-reply'` mode — and rejects with a
   * {@link BrokerDeliveryNotAcknowledgedError} when it may not.
   */
  deliver<M extends object>(target: ActorRef<M>, delivery: M): Promise<void> {
    if (this.mode === 'on-delivery') {
      target.tell(delivery);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (cause: Error): void => {
        if (settled) return;
        settled = true;
        this.outstanding.delete(fail);
        reject(cause);
      };
      this.outstanding.add(fail);
      target.ask<unknown>(delivery as never, this.timeoutMs).then(
        (reply) => {
          if (settled) return;
          const refusal = refusalOf(reply);
          if (refusal !== null) { fail(refusal); return; }
          settled = true;
          this.outstanding.delete(fail);
          resolve();
        },
        (error: unknown) => fail(new BrokerDeliveryNotAcknowledgedError(
          `no reply from ${target.path.toString()} within ${this.timeoutMs} ms`
          + (error instanceof Error && error.name !== 'AskTimeoutError' ? ` (${error.message})` : ''),
        )),
      );
    });
  }

  /** Give up on every outstanding reply — the connection they would have acknowledged on is gone. */
  cancelAll(cause: string): void {
    for (const fail of [...this.outstanding]) fail(new BrokerDeliveryNotAcknowledgedError(cause));
  }
}

/** `null` for an `acknowledgment` reply; otherwise the error saying why the reply does not acknowledge. */
function refusalOf(reply: unknown): BrokerDeliveryNotAcknowledgedError | null {
  const kind = typeof reply === 'object' && reply !== null ? (reply as { kind?: unknown }).kind : undefined;
  if (kind === 'acknowledgment') return null;
  if (kind === 'negativeAcknowledgment') {
    const reason = (reply as { reason?: unknown }).reason;
    return new BrokerDeliveryNotAcknowledgedError(
      `negatively acknowledged${typeof reason === 'string' && reason !== '' ? `: ${reason}` : ''}`,
    );
  }
  // Strict on purpose: at-least-once is the promise, and a reply the contract
  // does not name — a typo'd kind, an application message sent to the wrong
  // ref — is no evidence the delivery was processed.
  return new BrokerDeliveryNotAcknowledgedError(
    "the target's reply was neither { kind: 'acknowledgment' } nor { kind: 'negativeAcknowledgment' }",
  );
}
