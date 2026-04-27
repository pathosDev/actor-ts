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

/** Ack sent back to the `replyTo` of a Register message. */
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
 * Continuous subscription: `replyTo` receives a Listing now AND every time
 * the set of refs for this key changes (register, deregister, cluster
 * gossip, node leaving).
 */
export class Subscribe<T = unknown> {
  constructor(
    public readonly key: ServiceKey<T>,
    public readonly replyTo: ActorRef<Listing<T>>,
  ) {}
}

/** Stop an active Subscribe. */
export class Unsubscribe<T = unknown> {
  constructor(
    public readonly key: ServiceKey<T>,
    public readonly replyTo: ActorRef<Listing<T>>,
  ) {}
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
export interface ReceptionistGossipMsg {
  readonly t: 'receptionist-gossip';
  readonly from: import('../cluster/NodeAddress.js').NodeAddressData;
  /** key-id → list of actor paths on the sender node */
  readonly entries: Record<string, string[]>;
  readonly version: number;
}
