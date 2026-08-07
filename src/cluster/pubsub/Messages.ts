import type { ActorRef } from '../../ActorRef.js';
import type { NodeAddressData } from '../NodeAddress.js';

/* ============================ User-facing API ============================= */

/** What a `Subscribe`'s `replyTo` can be sent back: the ack, or the refusal. */
export type PubSubSubscriberRef = ActorRef<SubscribeAcknowledgment | SubscribeRejected>;

/**
 * Subscribe a local actor to a topic.
 *
 * `replyTo` is where the {@link SubscribeAcknowledgment} — or the
 * {@link SubscribeRejected} a full cap produces — is delivered.  It exists
 * because the mediator used to answer `context.sender`, and that slot is
 * empty for the documented call shape `mediator.tell(new Subscribe(…))`
 * from outside an actor: the caller most in need of the refusal was the one
 * who could not receive it.  Left `null`, the reply still follows `sender`.
 */
export class Subscribe {
  constructor(
    public readonly topic: string,
    public readonly ref: ActorRef,
    public readonly replyTo: PubSubSubscriberRef | null = null,
  ) {}
}

/** Unsubscribe a local actor from a topic. */
export class Unsubscribe {
  constructor(public readonly topic: string, public readonly ref: ActorRef) {}
}

/** Remove every subscription the actor holds on this mediator. */
export class UnsubscribeAll {
  constructor(public readonly ref: ActorRef) {}
}

/** Publish `message` to every subscriber of `topic` — cluster-wide. */
export class Publish<T = unknown> {
  constructor(
    public readonly topic: string,
    public readonly message: T,
    /** Deliver to senders/publishers themselves?  Default false. */
    public readonly sendOneMessageToEachGroup = false,
  ) {}
}

/** Sent back from Subscribe/Unsubscribe when the registry has been updated. */
export class SubscribeAcknowledgment { constructor(public readonly subscribe: Subscribe) {} }
export class UnsubscribeAcknowledgment { constructor(public readonly unsubscribe: Unsubscribe) {} }

/** Which cap refused a {@link Subscribe} — named after the option that set it. */
export type PubSubSubscribeRejectionReason =
  | 'maxSubscribersPerTopic'
  | 'maxTopics';

/**
 * Refusal sent instead of a {@link SubscribeAcknowledgment} when a mediator
 * cap is already full.
 *
 * The caps bound what one mediator can be made to hold; answering bounds
 * the debugging cost of hitting one.  A dropped `Subscribe` looks exactly
 * like a working subscription to a topic nobody publishes to, and the two
 * are hours apart to tell from the outside.  `limit` is the configured
 * value of `reason`.
 */
export class SubscribeRejected {
  constructor(
    public readonly topic: string,
    public readonly reason: PubSubSubscribeRejectionReason,
    public readonly limit: number,
  ) {}
  toString(): string {
    return `SubscribeRejected(${this.topic}, ${this.reason}=${this.limit})`;
  }
}

/** Query the current per-topic subscriber counts (local + remote). */
export class GetTopics { constructor(public readonly replyTo: ActorRef) {} }
export class CurrentTopics { constructor(public readonly topics: ReadonlyArray<string>) {} }

/* ============================ Internal wire ============================== */

/**
 * Incremental gossip: one node announces the set of topics it currently
 * hosts subscribers for.  Merged into the cluster-wide registry.
 *
 * `entries` is a flat list of topic names — the receiver only ever
 * needs to know **which** topics the sender has subscribers for, so
 * the per-topic subscriber paths from earlier wire shapes were
 * removed (#80) to keep gossip bytes proportional to the topic count
 * rather than to total subscriber count.
 */
export type PubSubGossipMessage = {
  readonly kind: 'pubsub-gossip';
  readonly from: NodeAddressData;
  /** Topic names hosted locally on the sender. */
  readonly entries: ReadonlyArray<string>;
  readonly version: number;
};

/**
 * Payload envelope used to forward a Publish to a remote mediator.
 * Remote mediator decodes and fans out to its local subscribers.
 */
export type PubSubPublishMessage = {
  readonly kind: 'pubsub-publish';
  readonly topic: string;
  readonly body: unknown;
};

export type PubSubWireMessage = PubSubGossipMessage | PubSubPublishMessage;
