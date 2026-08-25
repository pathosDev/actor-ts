import type { ActorRef } from '../../ActorRef.js';
import type { NodeAddress, NodeAddressData } from '../NodeAddress.js';

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
 *
 * `deliverWithOrigin` swaps the delivery shape: every message for this
 * subscriber arrives as a {@link PubSubEnvelope} naming the node it came
 * from, instead of as the bare body.  Opt-in rather than the default, because
 * the bare body is what every existing subscriber's `onReceive` is written
 * against — but a subscriber that acts on *who* published cannot work without
 * it, since a topic fan-out otherwise carries no sender at all (#706).
 *
 * The flag belongs to the **subscriber**, not to the subscription: one actor
 * has one `onReceive`, so a mixture of shapes across its topics would be a
 * discrimination problem it has no way to solve.  A second `Subscribe` from
 * the same actor therefore restates the shape for all of its topics.
 */
export class Subscribe {
  constructor(
    public readonly topic: string,
    public readonly ref: ActorRef,
    public readonly replyTo: PubSubSubscriberRef | null = null,
    public readonly deliverWithOrigin: boolean = false,
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

/**
 * How a {@link Publish} picks recipients among a topic's subscribers.
 *
 * `'one-subscriber'` is anycast: exactly one subscriber cluster-wide gets
 * the message.  That is what a work queue wants — N workers on one topic,
 * every task handled once — and it is the case a broadcast bus cannot serve
 * without the workers coordinating among themselves.
 *
 * A string union rather than a second message class because the two differ
 * only in how many recipients are chosen, and because it leaves room for a
 * further selection (Akka's per-consumer-group anycast) without a third
 * class and a third wire kind.
 */
export type PubSubDelivery = 'all-subscribers' | 'one-subscriber';

/**
 * Publish `message` to `topic` — cluster-wide, to every subscriber by
 * default and to exactly one with `delivery = 'one-subscriber'`.
 *
 * The third slot used to be `sendOneMessageToEachGroup`, Akka's per-group
 * anycast switch.  Nothing ever read it: the flag selects *one subscriber
 * per consumer group*, and this mediator has no groups for it to range over,
 * so passing `true` did the same nothing as passing `false` (#155).
 */
export class Publish<T = unknown> {
  constructor(
    public readonly topic: string,
    public readonly message: T,
    public readonly delivery: PubSubDelivery = 'all-subscribers',
  ) {}
}

/**
 * What a subscriber that asked for `deliverWithOrigin` receives instead of the
 * bare body: the message, the topic it came in on, and the cluster node the
 * transport authenticated it as coming from.
 *
 * **`origin` is never a value out of the payload.**  For a message that
 * crossed the wire it is the connection's peer, which
 * `Cluster.dispatchEnvelope` hands the mediator's envelope handler; for one
 * published on this node it is `cluster.selfAddress`.  `null` means the
 * mediator had no authenticated identity to attach — a wire-shaped frame
 * injected straight into its mailbox — and a subscriber that authorises on
 * `origin` must treat that as *unauthenticated*, not as *local*.
 *
 * **Sound only because a publish crosses at most one hop.**  The mediator
 * never re-forwards what it received, so the node a subscriber sees is the
 * node that published, not a relay — which is what lets a subscriber compare
 * `origin` against a claim inside `message` and have the comparison mean
 * something (#706).
 *
 * Deliberately a class: a wire body is always plain JSON, so `instanceof` is
 * proof this was minted locally by the mediator rather than reproduced by a
 * peer inside its own payload — the same reasoning as
 * `AuthenticatedShardingMessage` (#584, #712).
 */
export class PubSubEnvelope<T = unknown> {
  constructor(
    public readonly topic: string,
    public readonly message: T,
    public readonly origin: NodeAddress | null,
  ) {}
}

/**
 * A pub-sub wire frame together with the peer whose connection it arrived on.
 *
 * The identity is known at the transport and was thrown away one line later:
 * `DistributedPubSub.start` registered `(env) => mediator.tell(env.body)`, so
 * the `from` that `Cluster.dispatchEnvelope` passes never reached the mediator
 * and could not reach a subscriber (#706).  This wrapper is what carries it
 * through the mailbox.
 *
 * **Deliberately a class, not a `{ kind }` tag** — same reasoning as
 * {@link PubSubEnvelope} and the sharding/singleton wrappers it copies: a peer
 * can reproduce any tagged object verbatim inside `body`, and cannot mint a
 * class instance.  A frame that misses the per-path handler and reaches the
 * mediator through generic path resolution therefore arrives unwrapped, and is
 * treated as having no authenticated origin.
 */
export class AuthenticatedPubSubMessage {
  constructor(
    /** Connection-authenticated sender.  Never a value out of the payload. */
    public readonly peer: NodeAddress,
    /**
     * What the peer sent.  Typed as the wire union because that is what it
     * claims to be; the mediator re-dispatches on `kind` and drops whatever
     * matches no arm.
     */
    public readonly message: PubSubWireMessage,
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

/**
 * Anycast counterpart of {@link PubSubPublishMessage}.  The sending mediator
 * already picked this node as the single recipient, so the receiver hands the
 * body to exactly one of its local subscribers instead of fanning out.
 *
 * A distinct `kind` rather than a mode field on the publish envelope: the
 * receiver's dispatch stays a table lookup, and a frame that says what it
 * wants cannot be misread by a receiver that ignores the field.
 */
export type PubSubPublishOneMessage = {
  readonly kind: 'pubsub-publish-one';
  readonly topic: string;
  readonly body: unknown;
};

export type PubSubWireMessage =
  | PubSubGossipMessage
  | PubSubPublishMessage
  | PubSubPublishOneMessage;
