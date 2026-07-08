import { match, P } from 'ts-pattern';
import { Actor } from '../Actor.js';
import { DEFAULT_GOSSIP_INTERVAL_MS } from '../util/Constants.js';
import { ReceptionistOptionsValidator } from './ReceptionistOptions.js';
import type { ReceptionistOptions, ReceptionistOptionsType } from './ReceptionistOptions.js';
import { fromNullable, type Option } from '../util/Option.js';
import type { ActorRef } from '../ActorRef.js';
import type { ActorSystem } from '../ActorSystem.js';
import type { Cancellable } from '../Scheduler.js';
import { extensionId, type ExtensionId } from '../Extension.js';
import { Props } from '../Props.js';
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
  Unsubscribe,
  type ReceptionistGossipMsg,
} from './ReceptionistMessages.js';
import { ServiceKey } from './ServiceKey.js';

type Msg =
  | Register
  | Deregister
  | Find
  | Subscribe
  | Unsubscribe;

interface KeyEntry {
  /** Locally registered refs — treated as authoritative on this node. */
  readonly local: Map<string, ActorRef>; // pathString → ref
  /** Remote nodes that claim to host at least one ref under the key. */
  readonly remote: Map<string, string[]>; // nodeAddrString → pathStrings
  /** Subscribers wanting change notifications. */
  readonly subscribers: Set<ActorRef<Listing>>;
}

/**
 * Cluster-wide service registry.  Each node hosts one Receptionist actor.
 * Register/Deregister are authoritative locally; peers learn about
 * registrations through periodic gossip carrying a delta of local keys.
 *
 * When a peer node leaves, every key entry it contributed is removed and
 * subscribers are notified with an updated Listing.
 */
export class Receptionist extends Actor<Msg> {
  private readonly keys = new Map<string, KeyEntry>();
  private readonly clusterRef: Cluster | null;
  private readonly gossipIntervalMs: number;

  private version = 0;
  private gossipTimer: Cancellable | null = null;
  private unsubWire: (() => void) | null = null;
  private unsubCluster: (() => void) | null = null;

  constructor(options: ReceptionistOptions = {}) {
    super();
    const settings = options as ReceptionistOptionsType;
    new ReceptionistOptionsValidator().validate(settings);
    this.clusterRef = settings.cluster ?? null;
    this.gossipIntervalMs = settings.gossipIntervalMs ?? DEFAULT_GOSSIP_INTERVAL_MS;
  }

  override preStart(): void {
    if (this.clusterRef) {
      this.unsubWire = this.clusterRef._onWire('receptionist-gossip', (msg) =>
        this.handleGossip(msg as unknown as ReceptionistGossipMsg),
      );
      this.unsubCluster = this.clusterRef.subscribe((evt) =>
        match(evt)
          .with(P.instanceOf(MemberRemoved), (e) => this.forgetNode(e.member.address))
          .with(P.instanceOf(MemberUp), () => { this.version++; })
          .otherwise(() => { /* other events ignored */ }),
      );
      this.gossipTimer = this.system.scheduler.scheduleAtFixedRateFn(
        this.gossipIntervalMs, this.gossipIntervalMs, () => this.gossipTick(),
      );
    }
  }

  override postStop(): void {
    this.unsubWire?.();
    this.unsubCluster?.();
    this.gossipTimer?.cancel();
  }

  override onReceive(msg: Msg): void {
    match(msg)
      .with(P.instanceOf(Register), (m) => this.handleRegister(m))
      .with(P.instanceOf(Deregister), (m) => this.handleDeregister(m))
      .with(P.instanceOf(Find), (m) => this.handleFind(m))
      .with(P.instanceOf(Subscribe), (m) => this.handleSubscribe(m))
      .with(P.instanceOf(Unsubscribe), (m) => this.handleUnsubscribe(m))
      .exhaustive();
  }

  /* ---------------- handlers ---------------- */

  private handleRegister(msg: Register): void {
    const entry = this.getOrCreate(msg.key);
    const pathStr = msg.ref.path.toString();
    if (!entry.local.has(pathStr)) {
      entry.local.set(pathStr, msg.ref);
      this.version++;
      this.notifySubscribers(msg.key, entry);
    }
    msg.replyTo?.tell(new Registered(msg.key, msg.ref) as never);
  }

  private handleDeregister(msg: Deregister): void {
    const entry = this.keys.get(msg.key.id);
    if (!entry) return;
    const pathStr = msg.ref.path.toString();
    if (entry.local.delete(pathStr)) {
      this.version++;
      this.notifySubscribers(msg.key, entry);
      this.maybeDrop(msg.key.id, entry);
    }
  }

  private handleFind(msg: Find): void {
    const entry = this.keys.get(msg.key.id);
    msg.replyTo.tell(new Listing(msg.key, entry ? this.collectRefs(entry) : []));
  }

  private handleSubscribe(msg: Subscribe): void {
    const entry = this.getOrCreate(msg.key);
    entry.subscribers.add(msg.replyTo);
    // Replay current listing to the new subscriber.
    msg.replyTo.tell(new Listing(msg.key, this.collectRefs(entry)));
  }

  private handleUnsubscribe(msg: Unsubscribe): void {
    const entry = this.keys.get(msg.key.id);
    if (!entry) return;
    entry.subscribers.delete(msg.replyTo);
    this.maybeDrop(msg.key.id, entry);
  }

  /* ---------------- cluster plumbing ---------------- */

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
    const gossip: ReceptionistGossipMsg = {
      t: 'receptionist-gossip',
      from: this.clusterRef.selfAddress.toJSON(),
      entries,
      version: this.version,
    };
    const target = peers[Math.floor(Math.random() * peers.length)]!;
    this.clusterRef.transport.send(target.address, gossip as unknown as never);
  }

  private handleGossip(msg: ReceptionistGossipMsg): void {
    if (!this.clusterRef) return;
    const senderAddr = NodeAddress.fromJSON(msg.from).toString();
    // Replace this sender's remote contribution wholesale so diff-to-notify
    // works per-key.
    const affected = new Set<string>();
    for (const [id, entry] of this.keys) {
      if (entry.remote.has(senderAddr)) {
        entry.remote.delete(senderAddr);
        affected.add(id);
      }
    }
    for (const [id, paths] of Object.entries(msg.entries)) {
      const entry = this.getOrCreate(new ServiceKey(id));
      entry.remote.set(senderAddr, paths.slice());
      affected.add(id);
    }
    for (const id of affected) {
      const entry = this.keys.get(id);
      if (entry) this.notifySubscribers(new ServiceKey(id), entry);
    }
  }

  private forgetNode(addr: NodeAddress): void {
    const key = addr.toString();
    const affected = new Set<string>();
    for (const [id, entry] of this.keys) {
      if (entry.remote.delete(key)) affected.add(id);
    }
    for (const id of affected) {
      const entry = this.keys.get(id);
      if (entry) this.notifySubscribers(new ServiceKey(id), entry);
    }
  }

  /* ---------------- helpers ---------------- */

  private getOrCreate(key: ServiceKey): KeyEntry {
    let e = this.keys.get(key.id);
    if (!e) {
      e = { local: new Map(), remote: new Map(), subscribers: new Set() };
      this.keys.set(key.id, e);
    }
    return e;
  }

  private maybeDrop(id: string, entry: KeyEntry): void {
    if (entry.local.size === 0 && entry.remote.size === 0 && entry.subscribers.size === 0) {
      this.keys.delete(id);
    }
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
    if (entry.subscribers.size === 0) return;
    const listing = new Listing(key, this.collectRefs(entry));
    for (const sub of entry.subscribers) sub.tell(listing);
  }
}

/* -------------------------- Extension ---------------------------- */

export class ReceptionistExtension {
  private started: ActorRef<Msg> | null = null;
  constructor(private readonly system: ActorSystem) {}

  start(
    cluster?: Cluster | null,
    options: ReceptionistOptions = {},
  ): ActorRef<Msg> {
    if (this.started) return this.started;
    // `cluster` stays a positional arg (it's identity/wiring, not a tunable);
    // fold it onto the resolved settings so the actor sees a single object.
    const settings: Partial<ReceptionistOptionsType> = {
      ...(options as Partial<ReceptionistOptionsType>),
      cluster: cluster ?? null,
    };
    const ref = this.system.spawn(
      Props.create<Msg>(() => new Receptionist(settings)),
      'receptionist',
    );
    this.started = ref;
    return ref;
  }

  get(): Option<ActorRef<Msg>> { return fromNullable(this.started); }
}

export const ReceptionistId: ExtensionId<ReceptionistExtension> = extensionId<ReceptionistExtension>(
  'actor-ts/discovery/receptionist',
  (system) => new ReceptionistExtension(system),
);
