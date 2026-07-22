import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import { ActorRef } from '../../ActorRef.js';
import type { Cancellable } from '../../Scheduler.js';
import { DEFAULT_GOSSIP_INTERVAL_MS } from '../../util/Constants.js';
import { DistributedPubSubOptionsValidator } from './DistributedPubSubOptions.js';
import type { DistributedPubSubOptions, DistributedPubSubOptionsType } from './DistributedPubSubOptions.js';
import { MemberRemoved, MemberUp } from '../ClusterEvents.js';
import { NodeAddress } from '../NodeAddress.js';
import type { WireMessage } from '../Protocol.js';
import { RemoteActorRef } from '../RemoteActorRef.js';
import {
  CurrentTopics,
  GetTopics,
  Publish,
  Subscribe,
  SubscribeAcknowledgment,
  type PubSubGossipMessage,
  type PubSubPublishMessage,
  type PubSubWireMessage,
  Unsubscribe,
  UnsubscribeAcknowledgment,
  UnsubscribeAll,
} from './Messages.js';

/**
 * Well-known path at which every node hosts its DistributedPubSubMediator.
 * Remote publishes target this path so the receiving mediator can fan out
 * to its local subscribers.
 */
export function mediatorPath(systemName: string): string {
  return `actor-ts://${systemName}/user/pubsub-mediator`;
}

interface SubscriberSet {
  /** Locally-registered subscribers — receive direct Publish deliveries. */
  readonly local: Map<string, ActorRef>;
  /** Remote node addresses with at least one subscriber for this topic. */
  readonly remoteNodes: Set<string>;
}

/**
 * Cluster-wide publish/subscribe bus.  Every node hosts one mediator
 * which keeps a local Map<topic, subscribers> and gossip-replicates
 * the topic→node set so Publish can reach every subscriber with at
 * most one remote hop.
 *
 * Simple delta model: each mediator periodically gossips its local
 * topic set to one random peer.  Peers merge into their view.
 */
export class DistributedPubSubMediator extends Actor<
  Subscribe | Unsubscribe | UnsubscribeAll | Publish | GetTopics | PubSubPublishMessage
> {
  private readonly topics = new Map<string, SubscriberSet>();
  private gossipTimer: Cancellable | null = null;
  private unsubscribeWire: (() => void) | null = null;
  private unsubscribeCluster: (() => void) | null = null;
  private version = 0;

  readonly options: DistributedPubSubOptionsType;

  constructor(options: DistributedPubSubOptions) {
    super();
    this.options = options as DistributedPubSubOptionsType;
    new DistributedPubSubOptionsValidator().validate(this.options);
  }

  override preStart(): void {
    const cluster = this.options.cluster;
    this.unsubscribeWire = cluster._onWire('pubsub-gossip', (message) =>
      this.handleGossip(message as unknown as PubSubGossipMessage),
    );
    // Remote publishes arrive via the envelope handler, not the wire hook.
    this.unsubscribeCluster = cluster.subscribe((evt) =>
      match(evt)
        .with(P.instanceOf(MemberRemoved), (e) => this.onMemberRemoved(e))
        .with(P.instanceOf(MemberUp), () => this.onMemberUp())
        .otherwise(() => this.onOtherClusterEvent()),
    );
    const interval = this.options.gossipIntervalMs ?? DEFAULT_GOSSIP_INTERVAL_MS;
    this.gossipTimer = this.system.scheduler.scheduleAtFixedRateFunction(
      interval, interval, () => this.gossipTick(),
    );
  }

  override postStop(): void {
    this.unsubscribeWire?.();
    this.unsubscribeCluster?.();
    this.gossipTimer?.cancel();
  }

  override onReceive(message: Subscribe | Unsubscribe | UnsubscribeAll | Publish | GetTopics | PubSubPublishMessage): void {
    match(message)
      .with(P.instanceOf(Subscribe), (m) => this.onSubscribe(m))
      .with(P.instanceOf(Unsubscribe), (m) => this.onUnsubscribe(m))
      .with(P.instanceOf(UnsubscribeAll), (m) => this.onUnsubscribeAll(m))
      .with(P.instanceOf(Publish), (m) => this.onPublish(m))
      .with(P.instanceOf(GetTopics), (m) => this.onGetTopics(m))
      // Remote Publish forwarded from another mediator (plain envelope, not a class instance).
      .with({ t: 'pubsub-publish' }, (m) => this.onPubSubPublish(m))
      .otherwise(() => this.onUnhandled());
  }

  /* ----------------------------- Command handlers ----------------------------- */

  private onSubscribe(message: Subscribe): void {
    const set = this.getOrCreateSet(message.topic);
    const key = message.ref.path.toString();
    let changed = false;
    if (!set.local.has(key)) {
      set.local.set(key, message.ref);
      this.version++;
      changed = true;
    }
    this.log.debug(
      `[pubsub] subscribe '${message.topic}' by ${key} (local subs now: ${set.local.size}; ${changed ? 'new' : 'duplicate'})`,
    );
    this.sender.forEach((s) => s.tell(new SubscribeAcknowledgment(message)));
    // Eager broadcast: peers learn about the new subscription within
    // one hop, deterministically.  Without this the random-peer-per-
    // tick gossip leaves a probabilistic gap (~1/2^N for N ticks)
    // where a publish-immediately-after-subscribe misses the new
    // subscriber.  Periodic gossip continues to handle anti-entropy.
    if (changed) this.eagerGossip();
  }

  private onUnsubscribe(message: Unsubscribe): void {
    const set = this.topics.get(message.topic);
    const key = message.ref.path.toString();
    let changed = false;
    if (set?.local.delete(key)) {
      this.version++;
      changed = true;
      if (set.local.size === 0 && set.remoteNodes.size === 0) this.topics.delete(message.topic);
    }
    this.log.debug(
      `[pubsub] unsubscribe '${message.topic}' by ${key} (${changed ? 'removed' : 'not subscribed'})`,
    );
    this.sender.forEach((s) => s.tell(new UnsubscribeAcknowledgment(message)));
    if (changed) this.eagerGossip();
  }

  private onUnsubscribeAll(message: UnsubscribeAll): void {
    const key = message.ref.path.toString();
    let changed = false;
    for (const [topic, set] of this.topics) {
      if (set.local.delete(key)) { this.version++; changed = true; }
      if (set.local.size === 0 && set.remoteNodes.size === 0) this.topics.delete(topic);
    }
    if (changed) this.eagerGossip();
  }

  private onGetTopics(message: GetTopics): void {
    message.replyTo.tell(new CurrentTopics(Array.from(this.topics.keys()).sort()));
  }

  private onPublish<T>(message: Publish<T>): void {
    const set = this.topics.get(message.topic);
    const localCount = set?.local.size ?? 0;
    const remoteCount = set?.remoteNodes.size ?? 0;
    this.log.debug(
      `[pubsub] publish '${message.topic}' → ${localCount} local + ${remoteCount} remote node(s)`,
    );
    this.deliverLocal(message.topic, message.message);
    if (!set) return;
    const payload: PubSubPublishMessage = { t: 'pubsub-publish', topic: message.topic, body: message.message };
    for (const nodeStr of set.remoteNodes) {
      const node = NodeAddress.parse(nodeStr);
      if (node.equals(this.options.cluster.selfAddress)) continue;
      this.sendWire(node, payload);
    }
  }

  private onPubSubPublish(message: PubSubPublishMessage): void {
    this.deliverLocal(message.topic, message.body);
  }

  private onUnhandled(): void {
    /* unknown message */
  }

  private deliverLocal<T>(topic: string, body: T): void {
    const set = this.topics.get(topic);
    if (!set) return;
    for (const ref of set.local.values()) {
      try { ref.tell(body as never); } catch (e) {
        this.log.warn(`pubsub: subscriber ${ref} threw on delivery`, e);
      }
    }
  }

  /* --------------------------------- Gossip ---------------------------------- */

  private gossipTick(): void {
    const peers = this.options.cluster.upMembers()
      .filter(m => !m.address.equals(this.options.cluster.selfAddress));
    if (peers.length === 0) return;
    const gossip = this.buildGossip();
    // Push to one random peer — epidemic dissemination.
    const target = peers[Math.floor(Math.random() * peers.length)]!;
    this.sendWire(target.address, gossip);
  }

  /**
   * Send the current subscription state to **every** peer
   * immediately.  Used after local subscribe / unsubscribe so a
   * follow-up publish doesn't have to wait several gossip ticks
   * for the random-peer-per-tick scheme to reach every node.
   * Periodic `gossipTick` continues to run as steady-state
   * anti-entropy.
   */
  private eagerGossip(): void {
    const peers = this.options.cluster.upMembers()
      .filter(m => !m.address.equals(this.options.cluster.selfAddress));
    if (peers.length === 0) return;
    const gossip = this.buildGossip();
    for (const peer of peers) {
      this.sendWire(peer.address, gossip);
    }
  }

  private buildGossip(): PubSubGossipMessage {
    // Only topic names — the receiver doesn't use the per-topic
    // subscriber lists (it only tracks "node N has at least one
    // subscriber for topic T"), so omitting them keeps the wire
    // payload proportional to the topic count, not the subscriber
    // count.  See `handleGossip` for the consuming side.
    const entries: string[] = [];
    for (const [topic, set] of this.topics) {
      if (set.local.size === 0) continue;
      entries.push(topic);
    }
    return {
      t: 'pubsub-gossip',
      from: this.options.cluster.selfAddress.toJSON(),
      entries,
      version: this.version,
    };
  }

  private handleGossip(message: PubSubGossipMessage): void {
    const senderAddr = NodeAddress.fromJSON(message.from).toString();
    // First, clear any remote-node claims this sender used to have — we
    // always replace its contribution wholesale to stay in sync.
    for (const [topic, set] of this.topics) {
      set.remoteNodes.delete(senderAddr);
      if (set.local.size === 0 && set.remoteNodes.size === 0) this.topics.delete(topic);
    }
    for (const topic of message.entries) {
      const set = this.getOrCreateSet(topic);
      set.remoteNodes.add(senderAddr);
    }
  }

  private onMemberRemoved(e: MemberRemoved): void {
    this.forgetNode(e.member.address);
  }

  private onMemberUp(): void {
    this.version++;
  }

  private onOtherClusterEvent(): void {
    /* other events ignored */
  }

  private forgetNode(addr: NodeAddress): void {
    const key = addr.toString();
    for (const [topic, set] of this.topics) {
      set.remoteNodes.delete(key);
      if (set.local.size === 0 && set.remoteNodes.size === 0) this.topics.delete(topic);
    }
  }

  /* ---------------------------------- Helpers --------------------------------- */

  private getOrCreateSet(topic: string): SubscriberSet {
    let subscriberSet = this.topics.get(topic);
    if (!subscriberSet) {
      subscriberSet = { local: new Map(), remoteNodes: new Set() };
      this.topics.set(topic, subscriberSet);
    }
    return subscriberSet;
  }

  private sendWire(to: NodeAddress, message: PubSubWireMessage): void {
    if (message.t === 'pubsub-publish') {
      // Wrap in envelope so the receiver's Cluster routes it into the
      // mediator actor.  Publishes are "user" messages from the wire POV.
      this.options.cluster._sendEnvelope(to, {
        t: 'envelope',
        to: mediatorPath(this.options.cluster.system.name),
        from: null,
        body: message,
        tag: 'PubSubPublish',
      });
    } else {
      // Gossip frames ride on the raw transport — they're system traffic.
      this.options.cluster.transport.send(to, message as unknown as WireMessage);
    }
  }
}
