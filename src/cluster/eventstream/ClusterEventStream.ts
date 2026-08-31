import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { ActorSystem } from '../../ActorSystem.js';
import { EventStream } from '../../EventStream.js';
import { EventKey, type EventChannel, type EventClass } from '../../EventKey.js';
import { extensionId, type Extension, type ExtensionId } from '../../Extension.js';
import { SystemActorNames, SystemGroups } from '../../internal/SystemPaths.js';
import type { Cluster } from '../Cluster.js';
import { DistributedPubSubId } from '../pubsub/DistributedPubSubExtension.js';
import type { MediatorMessage } from '../pubsub/DistributedPubSubMediator.js';
import { Publish, PubSubEnvelope, Subscribe } from '../pubsub/Messages.js';

/**
 * Topic namespace for everything this bus puts on the mediator.
 *
 * Format vocabulary, not a tunable: its meaning *is* the two functions below
 * that build and parse it, so it stays beside them rather than moving to
 * `cluster/Constants.ts`.
 *
 * The prefix is not decoration.  `maxTopics` is one budget shared with
 * application pub-sub, and a peer's gossip can fill it (#1074) — so a topic's
 * origin has to be readable in `CurrentTopics` and in the DevTools panel
 * without knowing which module minted it.
 */
const TOPIC_PREFIX = 'actor-ts.event-stream/';

/**
 * Marks the `kind` half of the namespace, so a class registered under the
 * name `kind:order-placed` cannot collide with the kind channel of that name.
 */
const KIND_MARKER = 'kind:';

/**
 * Rebuilds an event from the plain object a peer sent.
 *
 * Takes the decoded JSON tree rather than the class, because the prototype is
 * gone by the time this runs — that is the whole reason it exists.
 */
export type ClusterEventDecoder<TEvent> = (body: Record<string, unknown>) => TEvent;

/** What {@link ClusterEventStream.register} stores per class channel. */
type Registration = {
  readonly name: string;
  readonly channel: EventClass<object>;
  readonly decode: ClusterEventDecoder<object>;
};

/**
 * The cluster-wide sibling of {@link EventStream}.
 *
 * `system.eventStream` is one `ActorSystem`, which is one node: a publish
 * there walks an in-process array and never touches the network.  This bus is
 * the other half — a publish here reaches subscribers on every node — and the
 * two are told apart by what owns them rather than by a convention anybody has
 * to remember.  `cluster.subscribe` is a third thing again and the easiest of
 * the three to confuse with this one: it delivers *membership* events to a
 * callback list and replays current state on subscribe.
 *
 * **It rides on the pub-sub mediator, one channel per topic.**  That is
 * deliberate, and it is what makes the feature cheap: the bounded topic-set
 * gossip, the at-most-one-hop delivery, the subscriber and topic caps (#80,
 * #139, #1074, #1261) and the per-peer authentication (#582, #706) already
 * exist and are already tested cross-node.  Above all it introduces **no new
 * wire kind** — there is still no protocol version negotiation (#823), so a
 * frame this node invented is one an older peer could not refuse intelligibly.
 *
 * **Two channel forms, and only one of them is free.**  A `kind`-discriminated
 * plain object is already valid JSON and its discriminant survives the wire
 * untouched, so a kind channel works across nodes with nothing registered.  A
 * **class** channel cannot: only the JsonTree tag travels, so a class instance
 * arrives as a plain object matching no `instanceof`.  Hence {@link register}
 * — which is not a workaround for a missing feature, because the registry that
 * would otherwise answer this (`SerializationExtension.bind`) deliberately
 * does not reach the wire (#450, itself waiting on #823).
 *
 * **Delivery is not synchronous**, unlike the local bus: a publish goes
 * through the mediator's mailbox even for a subscriber on this node.  Nothing
 * about crossing a node boundary could have been synchronous, and putting both
 * origins on one path is what keeps local and remote delivery in one order
 * instead of racing each other.
 */
export class ClusterEventStream implements Extension {
  /**
   * Local subscribers — and the reason this class is as small as it is.
   *
   * Reusing the bus rather than reimplementing it means the channel forms, the
   * dedup rules, the predicates and the per-subscription guards (#1010) are
   * the same code on both sides, so the two streams cannot drift apart in what
   * they consider a match.
   */
  private readonly local = new EventStream();

  private readonly registrationsByName = new Map<string, Registration>();
  private readonly registrationsByClass = new Map<EventClass<object>, Registration>();

  /** Topics the receiver already holds a mediator subscription for. */
  private readonly subscribedTopics = new Set<string>();

  private cluster: Cluster | null = null;
  private mediator: ActorRef<MediatorMessage> | null = null;
  private receiver: ActorRef<PubSubEnvelope> | null = null;
  private bridgeRef: ActorRef<object> | null = null;

  constructor(private readonly system: ActorSystem) {}

  /**
   * The stream for `cluster`, bound on first access.  The explicit form of
   * `cluster.eventStream`, kept for callers that hold the system and the
   * cluster separately — the same pairing `ClusterSharding.get` offers.
   */
  static get(system: ActorSystem, cluster: Cluster): ClusterEventStream {
    return system.extension(ClusterEventStreamId).start(cluster);
  }

  /**
   * Bind the stream to a cluster.  Idempotent per cluster — re-binding to the
   * same one is a no-op, re-binding to a different one throws, exactly as
   * `DistributedPubSub.start` does.
   *
   * The mediator is started here rather than on first publish so that the
   * failure lands where the binding is: a node whose pub-sub cannot start
   * should say so when the stream is reached for, not on whichever event
   * happened to be the first one that needed it.
   */
  start(cluster: Cluster): this {
    if (this.cluster === cluster) return this;
    if (this.cluster !== null) {
      throw new Error('ClusterEventStream is already bound to a different cluster');
    }
    this.cluster = cluster;
    this.local.log = this.system.log;
    this.mediator = this.system.extension(DistributedPubSubId).start(cluster);
    return this;
  }

  /**
   * Name a class channel so it can cross the wire.
   *
   * `name` is what travels — it *is* the topic — so it has to be stable across
   * a rolling upgrade in a way the class's own name is not: a minifier renames
   * the class and cannot touch the string in this call.
   *
   * `decode` falls back to a static `fromJSON` on the class, and one of the two
   * has to exist.  Rebuilding an arbitrary class from a plain object
   * generically would mean writing peer-supplied keys onto a fresh prototype,
   * which is the prototype-pollution shape this project has already had to
   * remove once; making the class say how it is rebuilt keeps that door shut.
   *
   * @throws TypeError on an empty name, on a class with no decoder, or on a
   * second registration that would change what an existing name means — a
   * silent re-point would leave every already-subscribed node decoding into a
   * different type than the publisher meant.
   */
  register<TEvent extends object>(
    name: string,
    channel: EventClass<TEvent>,
    decode?: ClusterEventDecoder<TEvent>,
  ): void {
    if (name.length === 0) {
      throw new TypeError(
        'ClusterEventStream.register: name must not be empty — it is the topic',
      );
    }
    const resolved = decode
      ?? (channel as { fromJSON?: ClusterEventDecoder<TEvent> }).fromJSON;
    if (typeof resolved !== 'function') {
      throw new TypeError(
        `ClusterEventStream.register: ${name} needs a decoder — pass one as the third`
        + ' argument, or give the class a static fromJSON(body)',
      );
    }
    const existing = this.registrationsByName.get(name);
    if (existing && existing.channel !== channel) {
      throw new TypeError(
        `ClusterEventStream.register: ${name} is already registered for a different class`,
      );
    }
    const registration: Registration = {
      name,
      channel: channel as EventClass<object>,
      decode: resolved as ClusterEventDecoder<object>,
    };
    this.registrationsByName.set(name, registration);
    this.registrationsByClass.set(registration.channel, registration);
  }

  /**
   * Publish to every subscriber on every node.
   *
   * The event is routed by its **exact** constructor, or by its `kind` when it
   * carries one.  A subclass of a registered class is deliberately not
   * published under the base name: the name is what the receiving node decodes
   * with, so that would deliver a base instance where a subclass was published
   * and lose the difference silently.  Register the concrete class — a
   * subscription to the base still reaches it, because the local half matches
   * with `instanceof`.
   *
   * @throws TypeError when the event is neither registered nor `kind`-tagged.
   */
  publish(event: object): void {
    this.assertStarted('publish');
    this.mediatorRef().tell(new Publish(this.topicForEvent(event), event));
  }

  /**
   * Subscribe to a channel, cluster-wide.  Same signature and the same channel
   * forms as {@link EventStream.subscribe}, predicate included.
   *
   * A class channel takes every registered class assignable to it, so
   * subscribing to a base class still collects its registered subclasses.  The
   * scan runs against the registry as it stands: {@link register} is setup, and
   * a class registered afterwards is not retro-subscribed.
   *
   * @throws TypeError when a class channel has nothing registered under it.
   * Quietly subscribing to no topic at all is indistinguishable from
   * subscribing to a topic nobody publishes to, and those two are hours apart
   * to tell from the outside.
   */
  subscribe<TEvent>(
    subscriber: ActorRef,
    channel: EventChannel<TEvent>,
    predicate?: (event: TEvent) => boolean,
  ): boolean {
    this.assertStarted('subscribe');
    // Resolved before the local subscription is taken, so an unusable channel
    // leaves nothing half-registered behind it.
    const topics = this.topicsForChannel(channel, 'subscribe');
    const added = this.local.subscribe(subscriber, channel, predicate);
    for (const topic of topics) this.ensureTopic(topic);
    return added;
  }

  /**
   * Drop a `(subscriber, channel)` pair, or every subscription the actor holds
   * when `channel` is omitted.
   *
   * The mediator subscription behind the topic is deliberately **not** dropped
   * with it: another local subscriber may still want that topic, and the only
   * registry that could answer whether one does is inside the local bus, which
   * exposes no per-channel count.  A retained topic costs one entry against
   * `maxTopics` and no delivery — the cheaper of the two mistakes.
   */
  unsubscribe<TEvent>(subscriber: ActorRef, channel?: EventChannel<TEvent>): boolean {
    return this.local.unsubscribe(subscriber, channel);
  }

  /**
   * Mirror a channel of the node-local bus onto this one.
   *
   * This is where "cluster-wide instead of local" gets decided, and it is
   * deliberately the operator's call rather than the framework's.  Every event
   * the framework publishes today has its own reason to stay node-local: the
   * lifecycle events are the hottest path in the system, dead letters have no
   * storm suppression (#1179), broker events still carry a credential-bearing
   * `cause` (#1388), and the membership events are derived independently on
   * every node.
   *
   * Which is also the one rule for using this: **bridge only events that
   * originate on exactly one node.**  Bridging one that every node derives for
   * itself produces N copies cluster-wide — not a bug to be fixed here, but the
   * direct consequence of how such an event comes to exist.
   *
   * @returns a function that stops the mirroring.
   */
  bridge<TEvent>(channel: EventChannel<TEvent>): () => void {
    this.assertStarted('bridge');
    // Resolved first, so an unregistered class channel fails on the line that
    // wrote the bridge rather than on the first event that took it.
    this.topicsForChannel(channel, 'bridge');
    const ref = this.bridgeSubscriber();
    this.system.eventStream.subscribe(ref, channel);
    return () => { this.system.eventStream.unsubscribe(ref, channel); };
  }

  /** Whether anything on this node is listening — coarse, any channel. */
  get hasSubscribers(): boolean { return this.local.hasSubscribers; }

  /* ---------------------------- Topic naming ---------------------------- */

  /**
   * The topic an event publishes to.
   *
   * Exact constructor first and `kind` second, so a registered class that also
   * carries a `kind` travels as the class it was registered as.
   */
  private topicForEvent(event: object): string {
    const registration = this.registrationsByClass.get(
      event.constructor as EventClass<object>,
    );
    if (registration) return TOPIC_PREFIX + registration.name;
    const kind = (event as { kind?: unknown }).kind;
    if (typeof kind === 'string' && kind.length > 0) {
      return TOPIC_PREFIX + KIND_MARKER + kind;
    }
    throw new TypeError(
      `ClusterEventStream.publish: ${describe(event)} is neither registered nor kind-tagged`
      + ' — call register(name, class) for it, or give the event a kind',
    );
  }

  /** Every topic a subscription to `channel` has to cover. */
  private topicsForChannel(channel: unknown, operation: string): string[] {
    if (channel instanceof EventKey) return [TOPIC_PREFIX + KIND_MARKER + channel.kind];
    if (typeof channel === 'string') {
      if (channel.length === 0) {
        throw new TypeError(
          `ClusterEventStream.${operation}: the empty string is not a kind — it names no event`,
        );
      }
      return [TOPIC_PREFIX + KIND_MARKER + channel];
    }
    if (typeof channel === 'function') {
      const matched: string[] = [];
      for (const registration of this.registrationsByName.values()) {
        if (isAssignableTo(registration.channel, channel)) {
          matched.push(TOPIC_PREFIX + registration.name);
        }
      }
      if (matched.length === 0) {
        throw new TypeError(
          `ClusterEventStream.${operation}: ${describeClass(channel)} has nothing registered`
          + ' under it — call register(name, class) before subscribing to it',
        );
      }
      return matched;
    }
    throw new TypeError(
      `ClusterEventStream.${operation}: channel must be a class, an EventKey or a kind string`,
    );
  }

  /* --------------------------- Wire plumbing --------------------------- */

  /** Take out one mediator subscription per topic, once. */
  private ensureTopic(topic: string): void {
    if (this.subscribedTopics.has(topic)) return;
    this.subscribedTopics.add(topic);
    // `deliverWithOrigin` is what lets one code path serve both origins: a
    // locally published event and a peer's arrive in the same shape, carrying
    // the topic the delivery came in on.  Without it the receiver would have
    // to guess which registration a bare body belonged to.
    this.mediatorRef().tell(new Subscribe(topic, this.receiverRef(), null, true));
  }

  /**
   * A delivery from the mediator — local-origin or remote, the same either
   * way.  Republished onto the local half, which is what applies the channel
   * matching and the predicates.
   */
  private onInbound(envelope: PubSubEnvelope): void {
    const decoded = this.decodeInbound(envelope);
    if (decoded !== null) this.local.publish(decoded);
  }

  /**
   * Turn what came in on the envelope's topic back into an event.
   *
   * The body of a **locally** published event is the original object — the
   * mediator hands local subscribers the value it was given, not a copy — so
   * the `instanceof` short-circuit is the normal path on the publishing node,
   * and identity survives there.  Only a peer's body needs rebuilding.
   */
  private decodeInbound(envelope: PubSubEnvelope): object | null {
    const body = envelope.message;
    if (typeof body !== 'object' || body === null) return null;
    const suffix = envelope.topic.slice(TOPIC_PREFIX.length);
    if (suffix.startsWith(KIND_MARKER)) return body;
    const registration = this.registrationsByName.get(suffix);
    if (!registration) return null;
    if (body instanceof registration.channel) return body;
    try {
      return registration.decode(body as Record<string, unknown>);
    } catch (e) {
      this.system.log.warn(
        `ClusterEventStream: decoding ${registration.name} from ${String(envelope.origin)}`
        + ' failed — dropping this delivery',
        e,
      );
      return null;
    }
  }

  private receiverRef(): ActorRef<PubSubEnvelope> {
    if (this.receiver) return this.receiver;
    this.receiver = this.system._spawnSystemActor<PubSubEnvelope>(
      () => new ClusterEventStreamReceiver((envelope) => this.onInbound(envelope)),
      SystemGroups.cluster,
      SystemActorNames.clusterEventStream,
    );
    return this.receiver;
  }

  private bridgeSubscriber(): ActorRef<object> {
    if (this.bridgeRef) return this.bridgeRef;
    this.bridgeRef = this.system._spawnSystemActor<object>(
      () => new ClusterEventStreamBridge((event) => this.forwardBridged(event)),
      SystemGroups.cluster,
      SystemActorNames.clusterEventStreamBridge,
    );
    return this.bridgeRef;
  }

  /**
   * Publish a bridged event, and survive one that cannot be routed.
   *
   * `bridge` checks the *channel*, which is not the same as checking every
   * event that will match it: a class channel matches subclasses, and a
   * subclass with no registration of its own has no topic to publish to.
   * Letting that throw would take the failure out through a system actor's
   * `onReceive`, and the supervisor would answer by restarting the bridge —
   * turning one unroutable event into a restart loop that stops mirroring the
   * events that *were* routable.
   */
  private forwardBridged(event: object): void {
    try {
      this.publish(event);
    } catch (e) {
      this.system.log.warn(
        'ClusterEventStream: a bridged event could not be published cluster-wide'
        + ' — register its concrete class, or give it a kind',
        e,
      );
    }
  }

  private mediatorRef(): ActorRef<MediatorMessage> {
    if (!this.mediator) throw new Error('ClusterEventStream.start(cluster) must be called first');
    return this.mediator;
  }

  private assertStarted(operation: string): void {
    if (this.cluster === null) {
      throw new Error(`ClusterEventStream.${operation}: start(cluster) must be called first`);
    }
  }
}

/**
 * Receives every cluster delivery and hands it back to the stream.
 *
 * An actor rather than a bare ref, because the mediator death-watches its
 * subscribers to clean up after them (#709) — a ref it cannot watch would sit
 * in every topic forever.
 */
class ClusterEventStreamReceiver extends Actor<PubSubEnvelope> {
  constructor(private readonly deliver: (envelope: PubSubEnvelope) => void) { super(); }

  override onReceive(message: PubSubEnvelope): void {
    this.deliver(message);
  }
}

/** Mirrors the node-local bus onto the cluster bus, for bridged channels. */
class ClusterEventStreamBridge extends Actor<object> {
  constructor(private readonly forward: (event: object) => void) { super(); }

  override onReceive(message: object): void {
    this.forward(message);
  }
}

/**
 * Is `candidate` the same class as `channel`, or a subclass of it?
 *
 * Walks the prototype chain rather than using `instanceof`, which needs an
 * instance and there is none here: the question is asked about two
 * constructors, at subscribe time.
 */
function isAssignableTo(candidate: EventClass<object>, channel: Function): boolean {
  if ((candidate as unknown) === channel) return true;
  let proto: unknown = Object.getPrototypeOf(candidate);
  while (typeof proto === 'function') {
    if (proto === channel) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/** How an unroutable event reads in the error that refuses it. */
function describe(event: object): string {
  const name = event.constructor?.name;
  return typeof name === 'string' && name.length > 0 ? name : 'the event';
}

/** How a class channel reads in an error. */
function describeClass(channel: Function): string {
  return channel.name.length > 0 ? channel.name : 'an unnamed channel';
}

export const ClusterEventStreamId: ExtensionId<ClusterEventStream> = extensionId(
  'ClusterEventStream',
  (system) => new ClusterEventStream(system),
);
