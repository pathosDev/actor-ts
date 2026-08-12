import { match, P } from 'ts-pattern';
import { Actor } from '../Actor.js';
import { SystemActorNames, SystemGroups } from '../internal/SystemPaths.js';
import { BidirectionalMultiMap } from '../util/BidirectionalMultiMap.js';
import { DEFAULT_GOSSIP_INTERVAL_MS } from '../util/Constants.js';
import {
  DEFAULT_MAX_SUBSCRIBERS_PER_KEY,
  DEFAULT_MAX_SUBSCRIBERS_TOTAL,
  ReceptionistOptionsValidator,
  readReceptionistOptionsFromConfig,
} from './ReceptionistOptions.js';
import type { ReceptionistOptions, ReceptionistOptionsType } from './ReceptionistOptions.js';
import { mergeOptions } from '../util/OptionsMerge.js';
import { fromNullable, type Option } from '../util/Option.js';
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { Cancellable } from '../Scheduler.js';
import { Terminated } from '../SystemMessages.js';
import { extensionId, type ExtensionId } from '../Extension.js';
import type { Cluster } from '../cluster/Cluster.js';
import { MemberRemoved, MemberUp } from '../cluster/ClusterEvents.js';
import { NodeAddress } from '../cluster/NodeAddress.js';
import { RemoteActorRef } from '../cluster/RemoteActorRef.js';
import {
  Deregister,
  Find,
  Listing,
  Register,
  Registered,
  Subscribe,
  SubscribeRejected,
  Unsubscribe,
  type ReceptionistGossipMessage,
  type ReceptionistSubscriberRef,
  type ReceptionistSubscribeRejectionReason,
} from './ReceptionistMessages.js';
import { ServiceKey } from './ServiceKey.js';

/** What the receptionist accepts from the outside — its own protocol. */
type Message =
  | Register
  | Deregister
  | Find
  | Subscribe
  | Unsubscribe;

/**
 * Everything the receptionist can find in its mailbox, including system
 * traffic.  `Terminated` is in the union because the actor watches its
 * subscribers: without the arm it would fall through to `onUnhandled` and
 * every dead subscriber would log a warning instead of being cleaned up
 * (the shape of #709).
 */
type ReceptionistInbox = Message | Terminated;

type KeyEntry = {
  /** Locally registered refs — treated as authoritative on this node. */
  readonly local: Map<string, ActorRef>; // pathString → ref
  /** Remote nodes that claim to host at least one ref under the key. */
  readonly remote: Map<string, string[]>; // nodeAddrString → pathStrings
};

/** The cap a {@link Subscribe} ran into, and the value that cap was set to. */
type CapRefusal = {
  readonly reason: ReceptionistSubscribeRejectionReason;
  readonly limit: number;
};

/**
 * Cluster-wide service registry.  Each node hosts one Receptionist actor.
 * Register/Deregister are authoritative locally; peers learn about
 * registrations through periodic gossip carrying a delta of local keys.
 *
 * When a peer node leaves, every key entry it contributed is removed and
 * subscribers are notified with an updated Listing.
 *
 * Subscriptions are **bounded and watched**.  Both matter: `Unsubscribe` is
 * caller-cooperative, so a crashed or adversarial subscriber used to sit in
 * the set forever, and `notifySubscribers` walks that set on every
 * registration change — an unbounded set is a memory leak *and* an O(N)
 * cost on the hot path (#137).
 */
export class Receptionist extends Actor<ReceptionistInbox> {
  private readonly keys = new Map<string, KeyEntry>();
  private readonly clusterRef: Cluster | null;
  private readonly gossipIntervalMs: number;
  private readonly maxSubscribersPerKey: number;
  private readonly maxSubscribersTotal: number;

  /**
   * Which keys each subscriber watches, and which subscribers each key has —
   * one object owning both directions (#1037).  The reverse direction is what
   * `Terminated` needs: it carries only a ref, and deciding whether that ref
   * may be unwatched by scanning every key would be O(keys) on a path whose
   * rate an attacker sets.
   *
   * Keyed by **path string** on the subscriber side, never by ref identity:
   * `Terminated` carries the cell's own `self` ref, which need not be the
   * object the caller subscribed with — a path is the one identity both sides
   * agree on.
   *
   * `size` is the total number of subscriptions, which is why the cap needs no
   * counter of its own.  A hand-kept one is a third thing to hold in step, and
   * it was already subtly wrong: the old `forgetSubscription` decremented
   * before its own "did this subscriber exist" guard.
   */
  private readonly subscriptions = new BidirectionalMultiMap<string, string>(); // keyId ↔ subscriber path
  /**
   * The ref behind each subscriber path — needed to `tell` a `Listing` and to
   * `unwatch`.  Its lifetime follows the relation exactly: written with a
   * subscriber's first subscription, dropped when its last one goes.
   */
  private readonly subscriberRefs = new Map<string, ReceptionistSubscriberRef>();

  private version = 0;
  private gossipTimer: Cancellable | null = null;
  private unsubscribeWire: (() => void) | null = null;
  private unsubscribeCluster: (() => void) | null = null;

  constructor(options: ReceptionistOptions = {}) {
    super();
    const resolvedOptions = options as ReceptionistOptionsType;
    new ReceptionistOptionsValidator().validate(resolvedOptions);
    this.clusterRef = resolvedOptions.cluster ?? null;
    this.gossipIntervalMs = resolvedOptions.gossipIntervalMs ?? DEFAULT_GOSSIP_INTERVAL_MS;
    this.maxSubscribersPerKey = resolvedOptions.maxSubscribersPerKey ?? DEFAULT_MAX_SUBSCRIBERS_PER_KEY;
    this.maxSubscribersTotal = resolvedOptions.maxSubscribersTotal ?? DEFAULT_MAX_SUBSCRIBERS_TOTAL;
  }

  override preStart(): void {
    if (this.clusterRef) {
      this.unsubscribeWire = this.clusterRef._onWire('receptionist-gossip', (message, from) =>
        this.handleGossip(message as unknown as ReceptionistGossipMessage, from),
      );
      this.unsubscribeCluster = this.clusterRef.subscribe((evt) =>
        match(evt)
          .with(P.instanceOf(MemberRemoved), (e) => this.onMemberRemoved(e))
          .with(P.instanceOf(MemberUp), () => this.onMemberUp())
          .otherwise(() => this.onOtherClusterEvent()),
      );
      this.gossipTimer = this.system.scheduler.scheduleAtFixedRateFunction(
        this.gossipIntervalMs, this.gossipIntervalMs, () => this.gossipTick(),
      );
    }
  }

  override postStop(): void {
    this.unsubscribeWire?.();
    this.unsubscribeCluster?.();
    this.gossipTimer?.cancel();
  }

  /**
   * `Terminated` is matched first, ahead of the protocol arms, and that order
   * is load-bearing rather than stylistic: `Subscribe` and `Unsubscribe` are
   * structurally identical (`key` + `replyTo`), so once `Terminated` sits
   * behind them in the union `ts-pattern` can no longer tell which of the
   * three an `instanceOf` arm extracts, and it hands the handler the wrong
   * type.  Taking the system message out of the union up front leaves the
   * remaining arms exactly the shape they had before death watch existed.
   */
  override onReceive(message: ReceptionistInbox): void {
    match(message)
      .with(P.instanceOf(Terminated), (m) => this.onTerminated(m))
      .with(P.instanceOf(Register), (m) => this.onRegister(m))
      .with(P.instanceOf(Deregister), (m) => this.onDeregister(m))
      .with(P.instanceOf(Find), (m) => this.onFind(m))
      .with(P.instanceOf(Subscribe), (m) => this.onSubscribe(m))
      .with(P.instanceOf(Unsubscribe), (m) => this.onUnsubscribe(m))
      .otherwise((m) => this.onUnhandled(m));
  }

  /* ---------------- handlers ---------------- */

  /**
   * Every arm above matches on `instanceof`, and the receptionist sits at a
   * resolvable path — so a body delivered over the cluster wire arrives as a
   * plain JSON object, matches nothing, and used to fail the actor through
   * `.exhaustive()`.  One remotely-delivered envelope was enough to take out
   * the node's service discovery (#713).  Drop it and say so instead.
   */
  private onUnhandled(message: ReceptionistInbox): void {
    this.log.warn(
      `receptionist: dropping an unrecognised message `
      + `(${(message as { kind?: string })?.kind ?? typeof message}) — `
      + `remote senders must address the receptionist through its own protocol`,
    );
  }

  private onRegister(message: Register): void {
    const entry = this.getOrCreate(message.key);
    const pathStr = message.ref.path.toString();
    if (!entry.local.has(pathStr)) {
      entry.local.set(pathStr, message.ref);
      this.version++;
      this.notifySubscribers(message.key, entry);
    }
    message.replyTo?.tell(new Registered(message.key, message.ref) as never);
  }

  private onDeregister(message: Deregister): void {
    const entry = this.keys.get(message.key.id);
    if (!entry) return;
    const pathStr = message.ref.path.toString();
    if (entry.local.delete(pathStr)) {
      this.version++;
      this.notifySubscribers(message.key, entry);
      this.maybeDrop(message.key.id, entry);
    }
  }

  private onFind(message: Find): void {
    const entry = this.keys.get(message.key.id);
    message.replyTo.tell(new Listing(message.key, entry ? this.collectRefs(entry) : []));
  }

  private onSubscribe(message: Subscribe): void {
    const entry = this.getOrCreate(message.key);
    const pathStr = message.replyTo.path.toString();
    if (!this.subscriptions.has(message.key.id, pathStr)) {
      const refusal = this.capRefusal(message.key.id);
      if (refusal) {
        // Undo the entry this Subscribe just created — otherwise a flood of
        // rejected subscribes to fresh keys grows `keys` instead, which is
        // the same leak one level up.
        this.maybeDrop(message.key.id, entry);
        this.log.warn(
          `receptionist: refusing a subscription to '${message.key.id}' — `
          + `${refusal.reason} (${refusal.limit}) is full`,
        );
        message.replyTo.tell(new SubscribeRejected(message.key, refusal.reason, refusal.limit));
        return;
      }
      this.rememberSubscription(message.replyTo, message.key.id);
    }
    // Replay current listing to the new subscriber.
    message.replyTo.tell(new Listing(message.key, this.collectRefs(entry)));
  }

  private onUnsubscribe(message: Unsubscribe): void {
    const pathStr = message.replyTo.path.toString();
    if (this.subscriptions.delete(message.key.id, pathStr)) {
      this.forgetSubscriber(pathStr);
    }
    const entry = this.keys.get(message.key.id);
    if (entry) this.maybeDrop(message.key.id, entry);
  }

  /**
   * A watched subscriber stopped.  `Unsubscribe` is caller-cooperative and a
   * stopped actor cannot send one, so without this arm every subscriber that
   * dies mid-subscription stays in the map and keeps costing a `tell` into
   * dead letters on every registration change.
   */
  private onTerminated(message: Terminated): void {
    const pathStr = message.actor.path.toString();
    // Snapshotted before the drop: `getKeys` hands back the live set, which
    // `deleteRight` is about to empty out from under the loop.
    const affected = [...this.subscriptions.getKeys(pathStr)];
    if (!this.subscriptions.deleteRight(pathStr)) return;
    // No `unwatch` — the cell already dropped the watch when it delivered
    // this, so asking again would only be a second lookup.
    this.subscriberRefs.delete(pathStr);
    for (const id of affected) {
      const entry = this.keys.get(id);
      if (entry) this.maybeDrop(id, entry);
    }
  }

  /* ---------------- cluster plumbing ---------------- */

  private onMemberRemoved(e: MemberRemoved): void {
    this.forgetNode(e.member.address);
  }

  private onMemberUp(): void {
    this.version++;
  }

  private onOtherClusterEvent(): void {
    /* other events ignored */
  }

  private gossipTick(): void {
    if (!this.clusterRef) return;
    const peers = this.clusterRef.upMembers()
      .filter(m => !m.address.equals(this.clusterRef!.selfAddress));
    if (peers.length === 0) return;
    const entries: Record<string, string[]> = {};
    for (const [id, entry] of this.keys) {
      if (entry.local.size === 0) continue;
      entries[id] = Array.from(entry.local.keys());
    }
    const gossip: ReceptionistGossipMessage = {
      kind: 'receptionist-gossip',
      from: this.clusterRef.selfAddress.toJSON(),
      entries,
      version: this.version,
    };
    const target = peers[Math.floor(Math.random() * peers.length)]!;
    this.clusterRef.transport.send(target.address, gossip as unknown as never);
  }

  /**
   * `from` is the peer the connection belongs to.  This used to key on
   * `message.from` instead, which a sender fills in itself — so any peer could
   * name another node and replace *its* whole service-registry contribution,
   * poisoning cluster-wide discovery (#574).  Every entry a node contributes
   * is now filed under the address that actually sent it.
   */
  private handleGossip(message: ReceptionistGossipMessage, from: NodeAddress): void {
    if (!this.clusterRef) return;
    const senderAddr = from.toString();
    // Replace this sender's remote contribution wholesale so diff-to-notify
    // works per-key.
    const affected = new Set<string>();
    for (const [id, entry] of this.keys) {
      if (entry.remote.has(senderAddr)) {
        entry.remote.delete(senderAddr);
        affected.add(id);
      }
    }
    for (const [id, paths] of Object.entries(message.entries)) {
      const entry = this.getOrCreate(new ServiceKey(id));
      entry.remote.set(senderAddr, paths.slice());
      affected.add(id);
    }
    this.notifyAndCompact(affected);
  }

  private forgetNode(addr: NodeAddress): void {
    const key = addr.toString();
    const affected = new Set<string>();
    for (const [id, entry] of this.keys) {
      if (entry.remote.delete(key)) affected.add(id);
    }
    this.notifyAndCompact(affected);
  }

  /**
   * Notify the subscribers of every touched key, then drop the entries that
   * ended up empty.  The compaction is the half that used to be missing: a
   * peer's contribution is replaced wholesale on every gossip round, so a key
   * that only ever existed because that peer named it left behind an empty
   * `KeyEntry` that nothing removed — `keys` grew for the lifetime of the
   * node, and the subscriber caps above would only have bounded what each
   * leftover entry held, not how many there were.
   */
  private notifyAndCompact(affected: ReadonlySet<string>): void {
    for (const id of affected) {
      const entry = this.keys.get(id);
      if (!entry) continue;
      this.notifySubscribers(new ServiceKey(id), entry);
      this.maybeDrop(id, entry);
    }
  }

  /* ---------------- helpers ---------------- */

  private getOrCreate(key: ServiceKey): KeyEntry {
    let entry = this.keys.get(key.id);
    if (!entry) {
      entry = { local: new Map(), remote: new Map() };
      this.keys.set(key.id, entry);
    }
    return entry;
  }

  private maybeDrop(id: string, entry: KeyEntry): void {
    if (entry.local.size === 0 && entry.remote.size === 0 && !this.subscriptions.hasLeft(id)) {
      this.keys.delete(id);
    }
  }

  /** The cap a fresh subscriber would breach, or `null` when there is room. */
  private capRefusal(keyId: string): CapRefusal | null {
    if (this.subscriptions.get(keyId).size >= this.maxSubscribersPerKey) {
      return { reason: 'maxSubscribersPerKey', limit: this.maxSubscribersPerKey };
    }
    if (this.subscriptions.size >= this.maxSubscribersTotal) {
      return { reason: 'maxSubscribersTotal', limit: this.maxSubscribersTotal };
    }
    return null;
  }

  /**
   * Book a new subscription and start watching the subscriber.  A subscriber
   * on several keys is watched once, and the single `Terminated` that follows
   * cleans up all of them — `hasRight` is what distinguishes the first
   * subscription from a later one.
   */
  private rememberSubscription(subscriber: ReceptionistSubscriberRef, keyId: string): void {
    const pathStr = subscriber.path.toString();
    if (!this.subscriptions.hasRight(pathStr)) {
      this.subscriberRefs.set(pathStr, subscriber);
      this.context.watch(subscriber);
    }
    this.subscriptions.add(keyId, pathStr);
  }

  /**
   * Drop the death watch once a subscriber's last subscription is gone.  The
   * pair itself is already removed by the caller; there is nothing to unlink
   * here, because the relation prunes a participant that holds nothing.
   */
  private forgetSubscriber(pathStr: string): void {
    if (this.subscriptions.hasRight(pathStr)) return;
    const ref = this.subscriberRefs.get(pathStr);
    if (!ref) return;
    this.subscriberRefs.delete(pathStr);
    this.context.unwatch(ref);
  }

  private collectRefs(entry: KeyEntry): ActorRef[] {
    const refs: ActorRef[] = Array.from(entry.local.values());
    if (this.clusterRef) {
      for (const [nodeStr, paths] of entry.remote) {
        const nodeAddr = NodeAddress.parse(nodeStr);
        for (const path of paths) {
          refs.push(new RemoteActorRef(nodeAddr, path, this.clusterRef));
        }
      }
    }
    return refs;
  }

  private notifySubscribers(key: ServiceKey, entry: KeyEntry): void {
    const subscribers = this.subscriptions.get(key.id);
    if (subscribers.size === 0) return;
    const listing = new Listing(key, this.collectRefs(entry));
    for (const pathStr of subscribers) this.subscriberRefs.get(pathStr)?.tell(listing);
  }
}

/* -------------------------- Extension ---------------------------- */

export class ReceptionistExtension {
  private started: ActorRef<Message> | null = null;
  constructor(private readonly system: ActorSystem) {}

  start(
    cluster?: Cluster | null,
    options: ReceptionistOptions = {},
  ): ActorRef<Message> {
    if (this.started) return this.started;
    // `cluster` stays a positional arg (it's identity/wiring, not a tunable);
    // fold it onto the resolved options so the actor sees a single object.
    // The tunables layer in the documented order — explicit options beat
    // `actor-ts.cluster.receptionist.*`, which beats the actor's built-ins.
    const resolvedOptions: Partial<ReceptionistOptionsType> = {
      ...mergeOptions<ReceptionistOptionsType>(
        {},
        readReceptionistOptionsFromConfig(this.system.config),
        options as Partial<ReceptionistOptionsType>,
      ),
      cluster: cluster ?? null,
    };
    // Spawned as its full inbox, handed out as the protocol: `Terminated`
    // reaches the actor through death watch, not from a holder of this ref.
    const ref = this.system._spawnSystemActor<ReceptionistInbox>(
      () => new Receptionist(resolvedOptions),
      SystemGroups.cluster,
      SystemActorNames.receptionist,
    ) as ActorRef<Message>;
    this.started = ref;
    return ref;
  }

  get(): Option<ActorRef<Message>> { return fromNullable(this.started); }
}

export const ReceptionistId: ExtensionId<ReceptionistExtension> = extensionId<ReceptionistExtension>(
  'actor-ts/discovery/receptionist',
  (system) => new ReceptionistExtension(system),
);
