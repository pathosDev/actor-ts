import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import { ActorRef } from '../../ActorRef.js';
import type { Cancellable } from '../../Scheduler.js';
import { DeadLetter, Terminated } from '../../SystemMessages.js';
import { DEFAULT_GOSSIP_INTERVAL_MS } from '../../util/Constants.js';
import { SystemActorNames, SystemGroups, systemActorPath } from '../../internal/SystemPaths.js';
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
  SubscribeRejected,
  type PubSubGossipMessage,
  type PubSubPublishMessage,
  type PubSubPublishOneMessage,
  type PubSubSubscribeRejectionReason,
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
  return systemActorPath(systemName, SystemGroups.clusterPubSub, SystemActorNames.pubSubMediator);
}

/** What the mediator accepts — from local actors and from remote mediators. */
export type MediatorMessage =
  | Subscribe
  | Unsubscribe
  | UnsubscribeAll
  | Publish
  | GetTopics
  | PubSubPublishMessage
  | PubSubPublishOneMessage;

/**
 * Everything the mediator can find in its mailbox, including system traffic.
 * `Terminated` is in the union because the mediator watches its subscribers:
 * without the arm it would fall through to `onUnhandled` and a stopped
 * subscriber would never be removed (the shape of #709).
 */
export type MediatorInbox = MediatorMessage | Terminated;

/** Local subscribers per topic when nothing else is configured. */
const DEFAULT_MAX_SUBSCRIBERS_PER_TOPIC = 10_000;
/** Distinct topics per mediator when nothing else is configured. */
const DEFAULT_MAX_TOPICS = 10_000;
/** Remote claimants per topic when nothing else is configured. */
const DEFAULT_MAX_REMOTE_NODES_PER_TOPIC = 1_000;

type SubscriberSet = {
  /** Locally-registered subscribers — receive direct Publish deliveries. */
  readonly local: Map<string, ActorRef>;
  /** Remote node addresses with at least one subscriber for this topic. */
  readonly remoteNodes: Set<string>;
  /**
   * Rotation cursor for `'one-subscriber'` delivery — mutable on purpose,
   * and held here rather than in a `Map<topic, number>` beside `topics`:
   * a second map would be a fourth registry to bound and to prune, while a
   * field is created and dropped with the very set it rotates over.
   */
  nextCandidateIndex: number;
};

/** The cap a {@link Subscribe} ran into, and the value that cap was set to. */
type CapRefusal = {
  readonly reason: PubSubSubscribeRejectionReason;
  readonly limit: number;
};

/**
 * Cluster-wide publish/subscribe bus.  Every node hosts one mediator
 * which keeps a local Map<topic, subscribers> and gossip-replicates
 * the topic→node set so Publish can reach every subscriber with at
 * most one remote hop.
 *
 * Simple delta model: each mediator periodically gossips its local
 * topic set to one random peer.  Peers merge into their view.
 *
 * A `Publish` is a broadcast by default and an anycast with
 * `delivery = 'one-subscriber'` — one subscriber cluster-wide, chosen by a
 * rotation over local subscribers and remote claimant nodes (#155).
 *
 * Every registry the mediator keeps is **bounded and watched**.  Three
 * axes grew without limit before: local subscribers per topic, distinct
 * topics (reachable from a peer's gossip, not just from local calls), and
 * remote claimants per topic.  Publish fan-out walks all three, so an
 * unbounded registry is a publish-latency problem as much as a memory one
 * (#139).
 */
export class DistributedPubSubMediator extends Actor<MediatorInbox> {
  private readonly topics = new Map<string, SubscriberSet>();
  private gossipTimer: Cancellable | null = null;
  private unsubscribeWire: (() => void) | null = null;
  private unsubscribeCluster: (() => void) | null = null;
  private version = 0;

  /**
   * Topics each local subscriber is registered for.  `Terminated` carries
   * only a ref, and deciding whether a ref may be unwatched otherwise means
   * scanning every topic — both O(topics) on paths a subscriber controls
   * the rate of.
   */
  private readonly topicsBySubscriber = new Map<string, Set<string>>();

  readonly options: DistributedPubSubOptionsType;

  private readonly maxSubscribersPerTopic: number;
  private readonly maxTopics: number;
  private readonly maxRemoteNodesPerTopic: number;
  private readonly sendToDeadLettersWhenNoSubscribers: boolean;

  constructor(options: DistributedPubSubOptions) {
    super();
    this.options = options as DistributedPubSubOptionsType;
    new DistributedPubSubOptionsValidator().validate(this.options);
    this.maxSubscribersPerTopic = this.options.maxSubscribersPerTopic ?? DEFAULT_MAX_SUBSCRIBERS_PER_TOPIC;
    this.maxTopics = this.options.maxTopics ?? DEFAULT_MAX_TOPICS;
    this.maxRemoteNodesPerTopic = this.options.maxRemoteNodesPerTopic ?? DEFAULT_MAX_REMOTE_NODES_PER_TOPIC;
    this.sendToDeadLettersWhenNoSubscribers = this.options.sendToDeadLettersWhenNoSubscribers ?? true;
  }

  override preStart(): void {
    const cluster = this.options.cluster;
    this.unsubscribeWire = cluster._onWire('pubsub-gossip', (message, from) =>
      this.handleGossip(message as unknown as PubSubGossipMessage, from),
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

  override onReceive(message: MediatorInbox): void {
    match(message)
      .with(P.instanceOf(Subscribe), (m) => this.onSubscribe(m))
      .with(P.instanceOf(Unsubscribe), (m) => this.onUnsubscribe(m))
      .with(P.instanceOf(UnsubscribeAll), (m) => this.onUnsubscribeAll(m))
      .with(P.instanceOf(Publish), (m) => this.onPublish(m))
      .with(P.instanceOf(GetTopics), (m) => this.onGetTopics(m))
      .with(P.instanceOf(Terminated), (m) => this.onTerminated(m))
      // Remote Publish forwarded from another mediator (plain envelope, not a class instance).
      .with({ kind: 'pubsub-publish' }, (m) => this.onPubSubPublish(m))
      .with({ kind: 'pubsub-publish-one' }, (m) => this.onPubSubPublishOne(m))
      .otherwise(() => this.onUnhandled());
  }

  /* ----------------------------- Command handlers ----------------------------- */

  private onSubscribe(message: Subscribe): void {
    const key = message.ref.path.toString();
    const existing = this.topics.get(message.topic);
    if (!existing?.local.has(key)) {
      const refusal = this.capRefusal(existing);
      if (refusal) {
        this.log.warn(
          `[pubsub] refusing a subscription to '${message.topic}' by ${key} — `
          + `${refusal.reason} (${refusal.limit}) is full`,
        );
        this.replyToSubscriber(message, new SubscribeRejected(message.topic, refusal.reason, refusal.limit));
        return;
      }
    }
    const set = this.getOrCreateSet(message.topic);
    let changed = false;
    if (!set.local.has(key)) {
      set.local.set(key, message.ref);
      this.rememberSubscription(message.ref, message.topic);
      this.version++;
      changed = true;
    }
    this.log.debug(
      `[pubsub] subscribe '${message.topic}' by ${key} (local subs now: ${set.local.size}; ${changed ? 'new' : 'duplicate'})`,
    );
    this.replyToSubscriber(message, new SubscribeAcknowledgment(message));
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
      this.forgetSubscription(message.ref, message.topic);
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
    if (this.dropSubscriber(message.ref)) this.eagerGossip();
  }

  /**
   * A watched subscriber stopped.  `Unsubscribe` is caller-cooperative and a
   * stopped actor cannot send one, so without this arm every subscriber that
   * dies mid-subscription stays in its topics, keeps them alive against the
   * topic cap, and costs a dead-lettered `tell` on every publish.
   */
  private onTerminated(message: Terminated): void {
    if (this.dropSubscriber(message.actor)) this.eagerGossip();
  }

  private onGetTopics(message: GetTopics): void {
    message.replyTo.tell(new CurrentTopics(Array.from(this.topics.keys()).sort()));
  }

  /** Broadcast or anycast — the only thing `delivery` decides. */
  private onPublish<T>(message: Publish<T>): void {
    if (message.delivery === 'one-subscriber') { this.publishToOneSubscriber(message); return; }
    this.publishToAllSubscribers(message);
  }

  private publishToAllSubscribers<T>(message: Publish<T>): void {
    const set = this.topics.get(message.topic);
    const remoteNodes = set ? this.remoteCandidatesOf(set) : [];
    this.log.debug(
      `[pubsub] publish '${message.topic}' → ${set?.local.size ?? 0} local + ${remoteNodes.length} remote node(s)`,
    );
    const delivered = this.deliverLocal(message.topic, message.message);
    const payload: PubSubPublishMessage = {
      kind: 'pubsub-publish', topic: message.topic, body: message.message,
    };
    for (const node of remoteNodes) this.sendWire(node, payload);
    if (delivered === 0 && remoteNodes.length === 0) this.deadLetter(message.topic, message.message);
  }

  /**
   * Anycast: exactly one subscriber, cluster-wide, gets the body.
   *
   * Candidates are this node's local subscribers listed individually plus one
   * entry per remote node claiming the topic.  Node granularity for the remote
   * half is not a simplification but the finest the registry supports: #80
   * deliberately dropped per-node subscriber counts from the gossip frame, so
   * how many subscribers sit behind a claim is not knowable here.  Akka's
   * group anycast routes at exactly the same granularity.
   *
   * Selection rotates a per-topic cursor instead of drawing at random.  A work
   * queue is the reason the mode exists and low-volume queues are where a
   * uniform draw shows: ten tasks over three workers leaves one of them idle
   * often enough to look like a bug.  A rotation also gives a test something
   * to assert, where a distribution only gives it something to sample.
   */
  private publishToOneSubscriber<T>(message: Publish<T>): void {
    const set = this.topics.get(message.topic);
    const localSubscribers = set ? [...set.local.values()] : [];
    const remoteNodes = set ? this.remoteCandidatesOf(set) : [];
    const candidateCount = localSubscribers.length + remoteNodes.length;
    this.log.debug(
      `[pubsub] publish '${message.topic}' to one of ${localSubscribers.length} local `
      + `+ ${remoteNodes.length} remote candidate(s)`,
    );
    if (!set || candidateCount === 0) { this.deadLetter(message.topic, message.message); return; }
    const index = this.rotate(set, candidateCount);
    const local = localSubscribers[index];
    if (local) {
      if (!this.tellSubscriber(local, message.message)) this.deadLetter(message.topic, message.message);
      return;
    }
    this.sendWire(remoteNodes[index - localSubscribers.length]!, {
      kind: 'pubsub-publish-one', topic: message.topic, body: message.message,
    });
  }

  private onPubSubPublish(message: PubSubPublishMessage): void {
    // Zero local subscribers here means the sending node acted on a topic
    // claim we no longer honour — the message travelled a hop and reached
    // nobody, which is exactly what dead letters are for.
    if (this.deliverLocal(message.topic, message.body) === 0) {
      this.deadLetter(message.topic, message.body);
    }
  }

  /**
   * An anycast that crossed a hop.  The sending mediator already chose this
   * node, so the only choice left is which local subscriber — and a topic with
   * none means the claim it routed on is stale, the same dead-letter case as
   * {@link onPubSubPublish}.  It is deliberately not re-routed: a second hop
   * would trade the at-most-one-hop guarantee for a race with the gossip that
   * is about to correct the sender anyway.
   */
  private onPubSubPublishOne(message: PubSubPublishOneMessage): void {
    const set = this.topics.get(message.topic);
    const subscribers = set ? [...set.local.values()] : [];
    if (!set || subscribers.length === 0) { this.deadLetter(message.topic, message.body); return; }
    const target = subscribers[this.rotate(set, subscribers.length)]!;
    if (!this.tellSubscriber(target, message.body)) this.deadLetter(message.topic, message.body);
  }

  private onUnhandled(): void {
    /* unknown message */
  }

  /** Fan out to local subscribers; returns how many actually got the body. */
  private deliverLocal<T>(topic: string, body: T): number {
    const set = this.topics.get(topic);
    if (!set) return 0;
    let delivered = 0;
    for (const ref of set.local.values()) {
      if (this.tellSubscriber(ref, body)) delivered++;
    }
    return delivered;
  }

  /** One delivery attempt.  A subscriber that throws costs only itself. */
  private tellSubscriber<T>(ref: ActorRef, body: T): boolean {
    try { ref.tell(body as never); return true; } catch (e) {
      this.log.warn(`pubsub: subscriber ${ref} threw on delivery`, e);
      return false;
    }
  }

  /**
   * Remote nodes claiming `topic`, this node excluded — one anycast candidate
   * and one broadcast envelope each.  Self is filtered because a stale claim
   * naming us would otherwise cost a wire round trip back into this mailbox.
   */
  private remoteCandidatesOf(set: SubscriberSet): NodeAddress[] {
    const candidates: NodeAddress[] = [];
    for (const nodeString of set.remoteNodes) {
      const node = NodeAddress.parse(nodeString);
      if (node.equals(this.options.cluster.selfAddress)) continue;
      candidates.push(node);
    }
    return candidates;
  }

  /** Advance the topic's rotation cursor, returning the index it handed out. */
  private rotate(set: SubscriberSet, candidateCount: number): number {
    const index = set.nextCandidateIndex % candidateCount;
    set.nextCandidateIndex = (index + 1) % candidateCount;
    return index;
  }

  /**
   * Route a publish that reached nobody to the system's dead letters.
   *
   * Silence was the old behaviour and it hides the single most common
   * pub-sub mistake — a typo in a topic name looks identical to a topic
   * whose subscribers have not gossiped in yet.  The `recipient` is the
   * mediator rather than a subscriber because there was none; the topic
   * travels in the `DeadLetter`'s message via the log line below it.
   */
  private deadLetter<T>(topic: string, body: T): void {
    if (!this.sendToDeadLettersWhenNoSubscribers) return;
    this.log.debug(`[pubsub] publish '${topic}' reached no subscriber → dead letters`);
    this.system.deadLetters.tell(new DeadLetter(body, this.sender.toNullable(), this.self));
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
      kind: 'pubsub-gossip',
      from: this.options.cluster.selfAddress.toJSON(),
      entries,
      version: this.version,
    };
  }

  /**
   * Keyed on the connection's peer, not on `message.from`.  The gossip
   * *replaces* the sender's contribution wholesale — that is how a node's
   * unsubscribes propagate — so trusting the payload's self-declared address
   * let any peer name another node and wipe every topic subscription that node
   * had registered cluster-wide (#582).
   *
   * The caps apply here too, and that is the half that matters most: a peer
   * naming 100 000 topics it "has subscribers for" allocates 100 000 entries
   * on every receiver, and no local `Subscribe` had to be involved.  A claim
   * over a cap is dropped and logged rather than refused on the wire — the
   * frame is otherwise well-formed, and dropping the connection over it
   * would let one noisy peer cost a healthy link.
   */
  private handleGossip(message: PubSubGossipMessage, from: NodeAddress): void {
    const senderAddr = from.toString();
    // First, clear any remote-node claims this sender used to have — we
    // always replace its contribution wholesale to stay in sync.
    for (const [topic, set] of this.topics) {
      set.remoteNodes.delete(senderAddr);
      if (set.local.size === 0 && set.remoteNodes.size === 0) this.topics.delete(topic);
    }
    let refused = 0;
    for (const topic of message.entries) {
      const existing = this.topics.get(topic);
      if (!existing && this.topics.size >= this.maxTopics) { refused++; continue; }
      if (existing && existing.remoteNodes.size >= this.maxRemoteNodesPerTopic) { refused++; continue; }
      this.getOrCreateSet(topic).remoteNodes.add(senderAddr);
    }
    if (refused > 0) {
      this.log.warn(
        `[pubsub] dropped ${refused} topic claim(s) gossiped by ${senderAddr} — `
        + `maxTopics (${this.maxTopics}) / maxRemoteNodesPerTopic (${this.maxRemoteNodesPerTopic}) is full`,
      );
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
      subscriberSet = { local: new Map(), remoteNodes: new Set(), nextCandidateIndex: 0 };
      this.topics.set(topic, subscriberSet);
    }
    return subscriberSet;
  }

  /**
   * The cap a fresh local subscription would breach, or `null` when there is
   * room.  `existing` is the topic's set, or `undefined` when the topic does
   * not exist yet — in which case the topic cap is the one at stake.
   */
  private capRefusal(existing: SubscriberSet | undefined): CapRefusal | null {
    if (!existing && this.topics.size >= this.maxTopics) {
      return { reason: 'maxTopics', limit: this.maxTopics };
    }
    if (existing && existing.local.size >= this.maxSubscribersPerTopic) {
      return { reason: 'maxSubscribersPerTopic', limit: this.maxSubscribersPerTopic };
    }
    return null;
  }

  /**
   * Answer a `Subscribe` on its `replyTo`, falling back to the sender.
   *
   * Neither is guaranteed: `mediator.tell(new Subscribe(…))` from outside an
   * actor has no sender, and `replyTo` is optional.  A refusal that reaches
   * nobody is worth a log line — an acknowledgment that does is not.
   */
  private replyToSubscriber(
    message: Subscribe,
    reply: SubscribeAcknowledgment | SubscribeRejected,
  ): void {
    const target = message.replyTo ?? this.sender.toNullable();
    if (target) { target.tell(reply as never); return; }
    if (reply instanceof SubscribeRejected) {
      this.log.warn(
        `[pubsub] ${reply} could not be delivered — the Subscribe carried no replyTo `
        + 'and arrived without a sender',
      );
    }
  }

  /** Book a local subscription and start watching the subscriber. */
  private rememberSubscription(ref: ActorRef, topic: string): void {
    const key = ref.path.toString();
    let subscribed = this.topicsBySubscriber.get(key);
    if (!subscribed) {
      subscribed = new Set();
      this.topicsBySubscriber.set(key, subscribed);
      this.context.watch(ref);
    }
    subscribed.add(topic);
  }

  /** Drop one subscription, and the death watch with the subscriber's last one. */
  private forgetSubscription(ref: ActorRef, topic: string): void {
    const key = ref.path.toString();
    const subscribed = this.topicsBySubscriber.get(key);
    if (!subscribed) return;
    subscribed.delete(topic);
    if (subscribed.size === 0) {
      this.topicsBySubscriber.delete(key);
      this.context.unwatch(ref);
    }
  }

  /**
   * Remove `ref` from every topic it subscribed to — the shared body of
   * `UnsubscribeAll` and `Terminated`.  Returns whether anything changed, so
   * the caller only pays for an eager gossip round when it did.
   *
   * Walks the subscriber's own topic set rather than the whole map: every
   * `local` insertion goes through `rememberSubscription`, so the index is
   * authoritative, and a mass termination of per-request subscribers would
   * otherwise cost O(topics) each.
   */
  private dropSubscriber(ref: ActorRef): boolean {
    const key = ref.path.toString();
    const subscribed = this.topicsBySubscriber.get(key);
    if (!subscribed) return false;
    this.topicsBySubscriber.delete(key);
    this.context.unwatch(ref);
    let changed = false;
    for (const topic of subscribed) {
      const set = this.topics.get(topic);
      if (!set) continue;
      if (set.local.delete(key)) { this.version++; changed = true; }
      if (set.local.size === 0 && set.remoteNodes.size === 0) this.topics.delete(topic);
    }
    return changed;
  }

  private sendWire(to: NodeAddress, message: PubSubWireMessage): void {
    if (message.kind === 'pubsub-gossip') {
      // Gossip frames ride on the raw transport — they're system traffic.
      this.options.cluster.transport.send(to, message as unknown as WireMessage);
      return;
    }
    // Wrap in envelope so the receiver's Cluster routes it into the
    // mediator actor.  Publishes are "user" messages from the wire POV.
    this.options.cluster._sendEnvelope(to, {
      kind: 'envelope',
      to: mediatorPath(this.options.cluster.system.name),
      from: null,
      body: message,
      tag: message.kind === 'pubsub-publish' ? 'PubSubPublish' : 'PubSubPublishOne',
    });
  }
}
