import type { ActorRef } from '../ActorRef.js';
import { ServiceKey } from './ServiceKey.js';

/** Register `ref` under `key` on this node. */
export class Register<T = unknown> {
  constructor(
    public readonly key: ServiceKey<T>,
    public readonly ref: ActorRef<T>,
    /** Optional: reply with Registered once accepted. */
    public readonly replyTo: ActorRef | null = null,
  ) {}
}

/** Acknowledgment sent back to the `replyTo` of a Register message. */
export class Registered<T = unknown> {
  constructor(
    public readonly key: ServiceKey<T>,
    public readonly ref: ActorRef<T>,
  ) {}
}

/** Remove `ref` from `key`. */
export class Deregister<T = unknown> {
  constructor(
    public readonly key: ServiceKey<T>,
    public readonly ref: ActorRef<T>,
  ) {}
}

/** One-shot lookup: reply with Listing once to `replyTo`. */
export class Find<T = unknown> {
  constructor(
    public readonly key: ServiceKey<T>,
    public readonly replyTo: ActorRef<Listing<T>>,
  ) {}
}

/**
 * What a subscriber can be sent by the receptionist: listings, plus the
 * refusal it gets when a subscriber cap is already full.
 *
 * The union is the whole reason {@link SubscribeRejected} exists — a
 * `Subscribe` that is silently discarded leaves the caller waiting for a
 * first `Listing` that never arrives, which is indistinguishable from "the
 * key has no registrations yet".
 */
export type ReceptionistSubscriberRef<T = unknown> = ActorRef<Listing<T> | SubscribeRejected<T>>;

/**
 * Continuous subscription: `replyTo` receives a Listing now AND every time
 * the set of refs for this key changes (register, deregister, cluster
 * gossip, node leaving).
 *
 * The receptionist watches `replyTo` for the lifetime of the subscription,
 * so a subscriber that stops without unsubscribing is dropped rather than
 * pinned forever (#137).
 */
export class Subscribe<T = unknown> {
  constructor(
    public readonly key: ServiceKey<T>,
    public readonly replyTo: ReceptionistSubscriberRef<T>,
  ) {}
}

/** Stop an active Subscribe. */
export class Unsubscribe<T = unknown> {
  constructor(
    public readonly key: ServiceKey<T>,
    public readonly replyTo: ReceptionistSubscriberRef<T>,
  ) {}
}

/** Which cap refused a {@link Subscribe} — named after the option that set it. */
export type ReceptionistSubscribeRejectionReason =
  | 'maxSubscribersPerKey'
  | 'maxSubscriptionsTotal';

/**
 * Refusal sent to a `Subscribe`'s `replyTo` when a subscriber cap is full.
 *
 * Answering is the point: the subscriber set is bounded so a buggy or
 * hostile actor cannot grow it without limit, and a bound that drops
 * requests silently would turn that protection into a debugging puzzle.
 * `limit` is the configured value of `reason`, so the recipient can log
 * what it was up against without reading the operator's config.
 */
export class SubscribeRejected<T = unknown> {
  constructor(
    public readonly key: ServiceKey<T>,
    public readonly reason: ReceptionistSubscribeRejectionReason,
    public readonly limit: number,
  ) {}
  toString(): string {
    return `SubscribeRejected(${this.key.id}, ${this.reason}=${this.limit})`;
  }
}

/**
 * Reply sent to Find requesters and to every Subscribe subscriber whenever
 * the current set of registrations for the key changes.  `refs` includes
 * actors registered on *any* cluster node.
 */
export class Listing<T = unknown> {
  constructor(
    public readonly key: ServiceKey<T>,
    public readonly refs: ReadonlyArray<ActorRef<T>>,
  ) {}
}

/** Wire message gossiped between receptionists. */
export type ReceptionistGossipMessage = {
  readonly kind: 'receptionist-gossip';
  readonly from: import('../cluster/NodeAddress.js').NodeAddressData;
  /** key-id → list of actor paths on the sender node */
  readonly entries: Record<string, string[]>;
  readonly version: number;
};
