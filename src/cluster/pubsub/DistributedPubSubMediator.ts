import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import { ActorRef } from '../../ActorRef.js';
import type { Cancellable } from '../../Scheduler.js';
import type { Cluster } from '../Cluster.js';
import { MemberRemoved, MemberUp } from '../ClusterEvents.js';
import { NodeAddress } from '../NodeAddress.js';
import type { WireMessage } from '../Protocol.js';
import { RemoteActorRef } from '../RemoteActorRef.js';
import {
  CurrentTopics,
  GetTopics,
  Publish,
  Subscribe,
  SubscribeAck,
  type PubSubGossipMsg,
  type PubSubPublishMsg,
  type PubSubWireMessage,
  Unsubscribe,
  UnsubscribeAck,
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

export interface DistributedPubSubSettings {
  readonly cluster: Cluster;
  readonly gossipIntervalMs?: number;
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
  Subscribe | Unsubscribe | UnsubscribeAll | Publish | GetTopics | PubSubPublishMsg
> {
  private readonly topics = new Map<string, SubscriberSet>();
  private gossipTimer: Cancellable | null = null;
  private unsubscribeWire: (() => void) | null = null;
  private unsubscribeCluster: (() => void) | null = null;
  private version = 0;

  constructor(public readonly settings: DistributedPubSubSettings) { super(); }

  override preStart(): void {
    const cluster = this.settings.cluster;
    this.unsubscribeWire = cluster._onWire('pubsub-gossip', (msg) =>
      this.handleGossip(msg as unknown as PubSubGossipMsg),
    );
    // Remote publishes arrive via the envelope handler, not the wire hook.
    this.unsubscribeCluster = cluster.subscribe((evt) =>
      match(evt)
        .with(P.instanceOf(MemberRemoved), (e) => this.forgetNode(e.member.address))
        .with(P.instanceOf(MemberUp), () => { this.version++; })
        .otherwise(() => { /* other events ignored */ }),
    );
    const interval = this.settings.gossipIntervalMs ?? 1_000;
    this.gossipTimer = this.system.scheduler.scheduleAtFixedRateFn(
      interval, interval, () => this.gossipTick(),
    );
  }

  override postStop(): void {
    this.unsubscribeWire?.();
    this.unsubscribeCluster?.();
    this.gossipTimer?.cancel();
  }

  override onReceive(msg: Subscribe | Unsubscribe | UnsubscribeAll | Publish | GetTopics | PubSubPublishMsg): void {
    match(msg)
      .with(P.instanceOf(Subscribe), (m) => this.handleSubscribe(m))
      .with(P.instanceOf(Unsubscribe), (m) => this.handleUnsubscribe(m))
      .with(P.instanceOf(UnsubscribeAll), (m) => this.handleUnsubscribeAll(m))
      .with(P.instanceOf(Publish), (m) => this.handlePublish(m))
      .with(P.instanceOf(GetTopics), (m) => this.handleGetTopics(m))
      // Remote Publish forwarded from another mediator (plain envelope, not a class instance).
      .with({ t: 'pubsub-publish' }, (m) => this.deliverLocal(m.topic, m.body))
      .otherwise(() => { /* unknown message */ });
  }

  /* ----------------------------- Command handlers ----------------------------- */

  private handleSubscribe(msg: Subscribe): void {
    const set = this.getOrCreateSet(msg.topic);
    const key = msg.ref.path.toString();
    if (!set.local.has(key)) {
      set.local.set(key, msg.ref);
      this.version++;
    }
    this.sender.forEach((s) => s.tell(new SubscribeAck(msg)));
  }

  private handleUnsubscribe(msg: Unsubscribe): void {
    const set = this.topics.get(msg.topic);
    const key = msg.ref.path.toString();
    if (set?.local.delete(key)) {
      this.version++;
      if (set.local.size === 0 && set.remoteNodes.size === 0) this.topics.delete(msg.topic);
    }
    this.sender.forEach((s) => s.tell(new UnsubscribeAck(msg)));
  }

  private handleUnsubscribeAll(msg: UnsubscribeAll): void {
    const key = msg.ref.path.toString();
    for (const [topic, set] of this.topics) {
      if (set.local.delete(key)) this.version++;
      if (set.local.size === 0 && set.remoteNodes.size === 0) this.topics.delete(topic);
    }
  }

  private handleGetTopics(msg: GetTopics): void {
    msg.replyTo.tell(new CurrentTopics(Array.from(this.topics.keys()).sort()));
  }

  private handlePublish<T>(msg: Publish<T>): void {
    this.deliverLocal(msg.topic, msg.message);
    const set = this.topics.get(msg.topic);
    if (!set) return;
    const payload: PubSubPublishMsg = { t: 'pubsub-publish', topic: msg.topic, body: msg.message };
    for (const nodeStr of set.remoteNodes) {
      const node = NodeAddress.parse(nodeStr);
      if (node.equals(this.settings.cluster.selfAddress)) continue;
      this.sendWire(node, payload);
    }
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
    const peers = this.settings.cluster.upMembers()
      .filter(m => !m.address.equals(this.settings.cluster.selfAddress));
    if (peers.length === 0) return;
    const entries: Record<string, string[]> = {};
    for (const [topic, set] of this.topics) {
      if (set.local.size === 0) continue;
      entries[topic] = Array.from(set.local.keys());
    }
    const gossip: PubSubGossipMsg = {
      t: 'pubsub-gossip',
      from: this.settings.cluster.selfAddress.toJSON(),
      entries,
      version: this.version,
    };
    // Push to one random peer — epidemic dissemination.
    const target = peers[Math.floor(Math.random() * peers.length)]!;
    this.sendWire(target.address, gossip);
  }

  private handleGossip(msg: PubSubGossipMsg): void {
    const senderAddr = NodeAddress.fromJSON(msg.from).toString();
    // First, clear any remote-node claims this sender used to have — we
    // always replace its contribution wholesale to stay in sync.
    for (const [topic, set] of this.topics) {
      set.remoteNodes.delete(senderAddr);
      if (set.local.size === 0 && set.remoteNodes.size === 0) this.topics.delete(topic);
    }
    for (const [topic, _subs] of Object.entries(msg.entries)) {
      const set = this.getOrCreateSet(topic);
      set.remoteNodes.add(senderAddr);
      void _subs;
    }
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
    let s = this.topics.get(topic);
    if (!s) {
      s = { local: new Map(), remoteNodes: new Set() };
      this.topics.set(topic, s);
    }
    return s;
  }

  private sendWire(to: NodeAddress, msg: PubSubWireMessage): void {
    if (msg.t === 'pubsub-publish') {
      // Wrap in envelope so the receiver's Cluster routes it into the
      // mediator actor.  Publishes are "user" messages from the wire POV.
      this.settings.cluster._sendEnvelope(to, {
        t: 'envelope',
        to: mediatorPath(this.settings.cluster.system.name),
        from: null,
        body: msg,
        tag: 'PubSubPublish',
      });
    } else {
      // Gossip frames ride on the raw transport — they're system traffic.
      this.settings.cluster.transport.send(to, msg as unknown as WireMessage);
    }
  }
}
