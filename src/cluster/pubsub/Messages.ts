import type { ActorRef } from '../../ActorRef.js';
import type { NodeAddressData } from '../NodeAddress.js';

/* ============================ User-facing API ============================= */

/** Subscribe a local actor to a topic. */
export class Subscribe {
  constructor(public readonly topic: string, public readonly ref: ActorRef) {}
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
export class SubscribeAck { constructor(public readonly subscribe: Subscribe) {} }
export class UnsubscribeAck { constructor(public readonly unsubscribe: Unsubscribe) {} }

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
export interface PubSubGossipMsg {
  readonly t: 'pubsub-gossip';
  readonly from: NodeAddressData;
  /** Topic names hosted locally on the sender. */
  readonly entries: ReadonlyArray<string>;
  readonly version: number;
}

/**
 * Payload envelope used to forward a Publish to a remote mediator.
 * Remote mediator decodes and fans out to its local subscribers.
 */
export interface PubSubPublishMsg {
  readonly t: 'pubsub-publish';
  readonly topic: string;
  readonly body: unknown;
}

export type PubSubWireMessage = PubSubGossipMsg | PubSubPublishMsg;
