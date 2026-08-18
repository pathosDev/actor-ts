import type { ActorClassOrFactory } from '../../Actor.js';
import type { ActorOptions, ActorOptionsType } from '../../ActorOptions.js';
import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import { ActorRef } from '../../ActorRef.js';
import { ActorPath } from '../../ActorPath.js';
import { DEFAULT_NUM_SHARDS, DEFAULT_PASSIVATION_IDLE_MS } from './ShardingOptions.js';
import type { ShardingOptionsType } from './ShardingOptions.js';
import type { Cancellable } from '../../Scheduler.js';
import { Terminated } from '../../SystemMessages.js';
import { SystemGroups, shardCoordinatorName, systemActorPath } from '../../internal/SystemPaths.js';
import type { Cluster } from '../Cluster.js';
import type { EnvelopeMessage } from '../Protocol.js';
import {
  LeaderChanged,
  MemberRemoved,
  MemberUp,
  ShardMapChanged,
} from '../ClusterEvents.js';
import { NodeAddress, type NodeAddressData } from '../NodeAddress.js';
import { RemoteActorRef, remoteActorPath } from '../RemoteActorRef.js';
import { hashShardId } from './ShardAllocator.js';
import { Passivate } from './Passivate.js';
import { Shard, type ShardConfig, type ShardInbox, type ShardMessage } from './Shard.js';
import type { ShardInfo } from './ShardInfo.js';
import { ShardCoordinator } from './ShardCoordinator.js';
import {
  AuthenticatedShardingMessage,
  isShardingMessage,
  type RegisterRegion,
  type RegisterRefused,
  type RegionTerminated,
  type ShardEnvelope,
  type ShardReply,
  type ShardingMessage,
  type ClusterShardingStats,
  type GetShardHome,
  type GetShardLocation,
  type GetShardRegionStats,
  type GetShards,
  type ShardHome,
  type ShardLocation,
  type ShardMapUpdate,
  type ShardRegionStats,
  type HandOff,
  type HandOffComplete,
  type BeginHandOffAcknowledgment,
  type RememberedEntities,
  type RegisterAcknowledgment,
  type EntityEnvelope,
  type EntityStarted,
  type EntityStopped,
  type ToShard,
} from './ShardingProtocol.js';

export type ShardRegionConfig<TMessage> = {
  readonly typeName: string;
  readonly entityActor: ActorClassOrFactory<TMessage>;
  readonly entityOptions?: ActorOptions<TMessage>;
  readonly extractEntityId: (message: TMessage) => string;
  readonly extractEntityMessage: (message: TMessage) => unknown;
  readonly numShards: number;
  readonly role?: string;
  readonly proxy: boolean;
  readonly rememberEntities: boolean;
  readonly passivationIdleMs: number;
  readonly shardPassivationIdleMs: number;
  readonly maxEntities: number;
  readonly cluster: Cluster;
  readonly localResolver: (path: string) => ActorRef | null;
};

/** What the region knows about a local entity — enough to decide passivation. */
type EntityActivity = {
  readonly shardId: number;
  lastActivity: number;
};

/**
 * What the region is currently doing with a shard.  `'handing-off'` and
 * `'passivating'` both mean "stop delivering, buffer instead"; they differ in
 * what happens once the actor is gone — a handoff gives ownership up, a
 * passivation keeps it and re-creates the shard on the next message.
 */
type ShardState = 'owned' | 'handing-off' | 'passivating';

/** Anything the region can route to an entity: a user message, or an id-addressed envelope. */
type RoutableMessage<TMessage> = TMessage | EntityEnvelope;

function isEntityEnvelope(message: unknown): message is EntityEnvelope {
  return typeof message === 'object'
    && message !== null
    && (message as { kind?: unknown }).kind === 'sharding.EntityEnvelope';
}

/**
 * ShardRegion is the node-local router for a sharded type.  It talks to
 * the ShardCoordinator to discover the home of each shard, hosts a
 * {@link Shard} actor for every shard that lives locally, and forwards
 * everything else to the remote region that owns the target shard.  Messages
 * whose shard home is unknown or in handoff are buffered until the
 * coordinator answers.
 *
 * Entities are grandchildren, not children: the region routes to a shard and
 * the shard owns the entity actors.  What the region deliberately keeps is
 * the *passivation policy* — the idle sweep, the `maxEntities` LRU, and the
 * shard-level sweep that stops a shard once it has stood empty long enough.
 * It sees every message on this node, so it is the only place where a
 * node-wide entity cap can be enforced; a shard only ever sees its own slice.
 *
 * Deciding here is also what makes stopping a shard loss-free.  The region
 * marks the shard and stops routing to it in the same synchronous step as it
 * sends the stop, so nothing it routes can land in a mailbox that is already
 * draining — a shard that timed itself out would have to tell the region
 * afterwards, and everything in that gap would be dropped.
 */
export class ShardRegion<TMessage = unknown>
  extends Actor<TMessage | ShardingMessage | AuthenticatedShardingMessage | Terminated | Passivate> {
  private readonly shardHomes = new Map<number, string>(); // shardId → region path
  private readonly shardHomeNodes = new Map<number, NodeAddress>();
  private readonly localShards = new Set<number>();
  private readonly shardState = new Map<number, ShardState>();
  /** Shard actors hosted here, keyed by shard id. */
  private readonly shards = new Map<number, ActorRef<ShardInbox>>();
  /** Shards stopped on purpose for a handoff — tells an expected stop from a crash. */
  private readonly handingOff = new Set<number>();
  /** Shards stopped on purpose because they stood empty — likewise an expected stop. */
  private readonly passivatingShards = new Set<number>();
  /** shardId → when it last became empty (or was created).  The shard sweep's clock. */
  private readonly shardEmptySince = new Map<number, number>();
  private readonly shardEntities = new Map<number, Set<string>>(); // shardId → entityIds
  private readonly entityActivity = new Map<string, EntityActivity>(); // entityId → activity
  /** Entities we have already asked a shard to passivate — excluded from the LRU count. */
  private readonly passivating = new Set<string>();
  /** Messages buffered while their shard home is unknown or in transition. */
  private readonly buffer = new Map<
    number,
    Array<{ message: RoutableMessage<TMessage>; sender: ActorRef | null }>
  >();

  private coordinatorRef: ActorRef<ShardingMessage> | null = null;
  /**
   * The node this region currently believes hosts the coordinator — the sole
   * authority for the coordinator-only directives (#584).  Kept beside
   * `coordinatorRef` rather than derived from it because a `RemoteActorRef`
   * does not expose its target node, and the local branch has no node at all.
   */
  private coordinatorNode: NodeAddress | null = null;
  private unsubscribe: (() => void) | null = null;
  private envelopeUnsubscribe: (() => void) | null = null;
  private passivationTimer: Cancellable | null = null;
  private registerTimer: Cancellable | null = null;
  private registered = false;
  /**
   * Set when the coordinator refused this region's `numShards` (#633).  A
   * refused region must stop hammering the register loop — the count is fixed
   * for the lifetime of the region, so retrying against the same coordinator
   * can only produce the same answer.  Cleared on a leader change, where the
   * coordinator moves to a node whose configuration we have not been told
   * about yet.
   */
  private registerRefused = false;

  /**
   * Senders of messages currently awaiting a reply from a remote shard.
   * Keyed by a correlation id that travels with {@link ShardEnvelope} across
   * the wire; the owning region looks it up when a {@link ShardReply} arrives.
   */
  private readonly pendingAsks = new Map<number, { sender: ActorRef; expireAt: number }>();
  private nextCorrelation = 0;

  /** Local callers of `ClusterSharding.shards()`, keyed by their correlation. */
  private readonly pendingStatsAsks = new Map<number, ActorRef>();
  private nextStatsCorrelation = 0;
  /** Local callers of `ClusterSharding.shardRefFor()`, keyed by shard. */
  private readonly pendingLocationAsks = new Map<number, ActorRef[]>();
  private asksSweepTimer: Cancellable | null = null;
  /** How long an unsettled ask entry is kept before being GC'd. */
  private readonly asksTtlMs = 60_000;

  constructor(public readonly config: ShardRegionConfig<TMessage>) { super(); }

  static settingsToConfig<TMessage>(
    s: ShardingOptionsType<TMessage>,
    cluster: Cluster,
    localResolver: (path: string) => ActorRef | null,
  ): ShardRegionConfig<TMessage> {
    const passivationIdleMs = s.passivationIdleMs ?? DEFAULT_PASSIVATION_IDLE_MS;
    return {
      typeName: s.typeName,
      entityActor: s.entityActor,
      entityOptions: s.entityOptions,
      extractEntityId: s.extractEntityId,
      extractEntityMessage: s.extractEntityMessage ?? ((m: TMessage) => m as unknown),
      numShards: s.numShards ?? DEFAULT_NUM_SHARDS,
      role: s.role,
      proxy: s.proxy ?? false,
      rememberEntities: s.rememberEntities ?? false,
      passivationIdleMs,
      // The one place the "shards follow entities" default lives: a shard
      // stands empty precisely because its entities went idle, so absent an
      // explicit window the entity one applies a level up.
      shardPassivationIdleMs: s.shardPassivationIdleMs ?? passivationIdleMs,
      maxEntities: s.maxEntities ?? 0,
      cluster,
      localResolver,
    };
  }

  override preStart(): void {
    this.unsubscribe = this.config.cluster.subscribe(evt =>
      match(evt)
        .with(P.instanceOf(LeaderChanged), () => this.onLeaderChanged())
        .with(P.instanceOf(MemberRemoved), (event) => this.onMemberRemoved(event))
        .with(P.instanceOf(MemberUp), () => this.onMemberUp())
        .otherwise(() => this.onOtherClusterEvent()),
    );

    // Claim the region's own path on the envelope router *before* registering
    // with the coordinator, so nothing the registration provokes can arrive
    // before the handler that stamps it with its sender.  Generic path
    // resolution would deliver the same frames — that is what happened until
    // #584 — but it calls `ref.tell(body)` with no sender at all, throwing away
    // the one field of an inbound frame the sender cannot choose.
    this.envelopeUnsubscribe = this.config.cluster._registerEnvelopeHandler(
      this.self.path.toString(),
      (envelope, from) => this.onRemoteEnvelope(envelope, from),
    );

    this.ensureRegistered();

    // One timer drives both sweeps.  The interval is the shorter of the
    // windows actually enabled — a sweep is only ever as punctual as its
    // tick, so the tighter window sets the pace for both.
    const windows = [this.config.passivationIdleMs, this.config.shardPassivationIdleMs]
      .filter((ms) => ms > 0);
    if (windows.length > 0) {
      const intervalMs = Math.min(...windows);
      this.passivationTimer = this.system.scheduler.scheduleAtFixedRateFunction(
        intervalMs, intervalMs,
        () => this.passivationSweep(),
      );
    }

    this.asksSweepTimer = this.system.scheduler.scheduleAtFixedRateFunction(
      this.asksTtlMs, this.asksTtlMs,
      () => this.sweepPendingAsks(),
    );
  }

  /**
   * An envelope addressed to this region arrived from `from`, whose identity
   * the transport authenticated (#584).
   *
   * Re-enqueued through `self.tell` so the region still processes it on its own
   * turn — the handler runs on the receive path, not in the actor.  Only a
   * sharding frame gets the wrapper: a region is also a legitimate target for
   * *user* messages, which `deliverRemote` forwards raw when there is no sender
   * to correlate, and those route by `extractEntityId` exactly as a local tell
   * does.  Nothing is lost by leaving them unwrapped — no user message can
   * reach a coordinator-only arm, since those dispatch on a `sharding.` kind.
   */
  private onRemoteEnvelope(envelope: EnvelopeMessage, from: NodeAddress): void {
    if (isShardingMessage(envelope.body)) {
      this.self.tell(new AuthenticatedShardingMessage(from, envelope.body));
      return;
    }
    this.self.tell(envelope.body as TMessage);
  }

  override postStop(): void {
    this.unsubscribe?.();
    this.envelopeUnsubscribe?.();
    this.passivationTimer?.cancel();
    this.registerTimer?.cancel();
    this.asksSweepTimer?.cancel();
    this.tellCoordinatorTerminated();
  }

  /**
   * Tell the coordinator this region is gone (#648).
   *
   * Without it the only thing that ever removes a region from the coordinator's
   * registry is `MemberRemoved`, so stopping a region on a node that stays in
   * the cluster left its shards allocated to an actor that no longer exists:
   * the coordinator kept answering `GetShardHome` with the dead region, senders
   * cached that home and delivered into a stopped cell, and nothing self-healed
   * — `candidates()` is derived from the registry with no liveness check, so
   * the rebalance tick saw a perfectly balanced cluster.
   *
   * Ordering is already safe: `postStop` runs only once every child has
   * terminated, so the entities are provably gone before the coordinator is
   * free to place their shards elsewhere.  Sent directly rather than through
   * `tellCoordinator`, which would re-enter the register loop (and arm a timer)
   * on a region that is shutting down.
   */
  private tellCoordinatorTerminated(): void {
    const coordinator = this.coordinatorRef;
    if (!coordinator) return;
    const terminated: RegionTerminated = {
      kind: 'sharding.RegionTerminated',
      // Must be byte-identical to what `register()` sent, or the coordinator's
      // `regionKey` misses and `onRegionTerminated` silently no-ops.
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
    };
    try {
      this.tellCoordinatorRef(coordinator, terminated);
    } catch (error) {
      // A transport that is already down on the shutdown path must not turn
      // into a failed `postStop`; the `MemberRemoved` route still covers it.
      this.log.debug(
        `[sharding] could not tell the coordinator that region '${this.config.typeName}' stopped`,
        error,
      );
    }
  }

  override onReceive(
    message: TMessage | ShardingMessage | AuthenticatedShardingMessage | Terminated | Passivate,
  ): void {
    if (message instanceof AuthenticatedShardingMessage) {
      this.handleShardingMessage(message.message, message.peer);
      return;
    }
    if (isShardingMessage(message)) {
      this.handleShardingMessage(message, null);
      return;
    }
    if (message instanceof Terminated) {
      this.handleShardTerminated(message);
      return;
    }
    if (message instanceof Passivate) {
      this.handlePassivate(message);
      return;
    }
    this.routeMessage(message as TMessage, this.sender.toNullable());
  }

  /* ----------------------------- Routing -------------------------------- */

  /**
   * The single entry point for anything bound for an entity.  Two shapes get
   * here: a plain user message, whose entity id comes out of
   * `extractEntityId`, and an {@link EntityEnvelope} from an
   * {@link EntityRef}, which names its entity outright.  Everything after the
   * id is resolved is identical, so both go through {@link route}.
   */
  private routeMessage(message: RoutableMessage<TMessage>, sender: ActorRef | null): void {
    if (isEntityEnvelope(message)) {
      this.route(message.entityId, message.message as TMessage, message, sender);
      return;
    }
    const entityId = this.config.extractEntityId(message);
    const entityMessage = this.config.extractEntityMessage(message) as TMessage;
    this.route(entityId, entityMessage, message, sender);
  }

  /**
   * @param entityMessage what the entity itself receives when the shard is local
   * @param forwardMessage what gets buffered or handed to a remote region — the
   *   *un*-extracted form, so a replay or a second hop re-derives the id the
   *   same way this one did
   */
  private route(
    entityId: string,
    entityMessage: TMessage,
    forwardMessage: RoutableMessage<TMessage>,
    sender: ActorRef | null,
  ): void {
    const shardId = hashShardId(entityId, this.config.numShards);

    const state = this.shardState.get(shardId);
    if (state === 'handing-off' || state === 'passivating') {
      // The shard actor is on its way out either way; hold the message until
      // its `Terminated` says where the work goes next.
      this.bufferShard(shardId, forwardMessage, sender);
      return;
    }

    const ownerPath = this.shardHomes.get(shardId);
    if (!ownerPath) {
      this.bufferShard(shardId, forwardMessage, sender);
      this.askCoordinator(shardId);
      return;
    }

    if (this.localShards.has(shardId)) {
      this.deliverLocal(shardId, entityId, entityMessage, sender);
    } else {
      const node = this.shardHomeNodes.get(shardId);
      if (!node) { this.bufferShard(shardId, forwardMessage, sender); this.askCoordinator(shardId); return; }
      this.deliverRemote(node, ownerPath, forwardMessage, sender);
    }
  }

  private deliverLocal(shardId: number, entityId: string, message: TMessage, sender: ActorRef | null): void {
    if (this.config.proxy) {
      // Proxy regions should not own shards; this is a routing bug.
      this.log.warn(`proxy region got shard ${shardId} unexpectedly`);
      return;
    }
    this.recordActivity(shardId, entityId);
    // Forward the original sender so that ask-pattern replies bypass region
    // and shard and reach the caller directly.
    this.ensureShard(shardId).tell({ kind: 'sharding.EntityEnvelope', entityId, message }, sender);
  }

  /**
   * Stamp an entity as active — and, when this is the first message for a
   * not-yet-existing entity, make room for it first.  A message for an entity
   * that is already passivating changes nothing: the shard buffers it, and
   * the entity's slot is accounted for until `EntityStopped` arrives.
   */
  private recordActivity(shardId: number, entityId: string): void {
    if (this.passivating.has(entityId)) return;
    const existing = this.entityActivity.get(entityId);
    if (!existing) {
      this.evictLruIfAtCapacity();
      this.entityActivity.set(entityId, { shardId, lastActivity: Date.now() });
      return;
    }
    existing.lastActivity = Date.now();
  }

  /**
   * If `maxEntities` is set and the node is at capacity, passivate the entity
   * with the oldest `lastActivity` to make room for a new one (#82).  The cap
   * is deliberately **region-wide, not per shard** — it is a node-level
   * memory bound, and dividing it across a shard set that changes on every
   * rebalance would make the effective limit unpredictable.
   *
   * Already-passivating entities don't count toward capacity (they'll be
   * removed once `EntityStopped` arrives), and the eviction goes through the
   * same `PassivateEntity` command as `passivationSweep`, so the journal-aware
   * shutdown path is identical for idle-timeout and capacity-driven evictions.
   *
   * The cap is a steady-state upper bound: between asking the shard to stop
   * the LRU entity and `EntityStopped` landing, the node briefly holds
   * `maxEntities + 1` entities.  Acceptable trade-off vs blocking the
   * incoming message until passivation actually completes.
   */
  private evictLruIfAtCapacity(): void {
    if (this.config.maxEntities <= 0) return;
    let liveCount = 0;
    let oldestId: string | null = null;
    let oldestShard = -1;
    let oldestActivity = Number.POSITIVE_INFINITY;
    for (const [entityId, activity] of this.entityActivity) {
      if (this.passivating.has(entityId)) continue;
      liveCount++;
      if (activity.lastActivity < oldestActivity) {
        oldestActivity = activity.lastActivity;
        oldestId = entityId;
        oldestShard = activity.shardId;
      }
    }
    if (liveCount < this.config.maxEntities) return;
    if (oldestId === null) return;
    this.log.debug(
      `[sharding] LRU passivation: evicting '${oldestId}' (idle for ${Date.now() - oldestActivity}ms, `
      + `cap ${this.config.maxEntities} reached)`,
    );
    this.requestPassivation(oldestId, oldestShard);
  }

  /** Ask the shard that owns `entityId` to stop it gracefully. */
  private requestPassivation(entityId: string, shardId: number): void {
    const shard = this.shards.get(shardId);
    if (!shard) return;
    this.passivating.add(entityId);
    shard.tell({ kind: 'sharding.PassivateEntity', entityId });
  }

  private deliverRemote(
    node: NodeAddress,
    path: string,
    message: RoutableMessage<TMessage>,
    sender: ActorRef | null,
  ): void {
    if (sender === null) {
      // Nothing to reply to — skip the envelope wrapping.
      new RemoteActorRef<RoutableMessage<TMessage>>(node, path, this.config.cluster).tell(message);
      return;
    }

    // Preserve an existing correlation if this sender is itself a proxy
    // for an upstream asker (multi-hop forwarding).  Otherwise register a
    // fresh correlation keyed to our local pendingAsks table so the reply
    // reaches this region.
    let originNode: NodeAddress;
    let originRegion: string;
    let correlationId: number;
    if (sender instanceof ShardSenderRef) {
      originNode = sender.originNode;
      originRegion = sender.originRegion;
      correlationId = sender.correlationId;
    } else {
      originNode = this.config.cluster.selfAddress;
      originRegion = this.self.path.toString();
      correlationId = this.registerPendingAsk(sender);
    }

    const envelope: ShardEnvelope = {
      kind: 'sharding.Envelope',
      message,
      originNode: originNode.toJSON(),
      originRegion,
      correlationId,
    };
    new RemoteActorRef<ShardingMessage>(node, path, this.config.cluster).tell(envelope);
  }

  private registerPendingAsk(sender: ActorRef): number {
    const id = ++this.nextCorrelation;
    this.pendingAsks.set(id, { sender, expireAt: Date.now() + this.asksTtlMs });
    return id;
  }

  private sweepPendingAsks(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingAsks) {
      if (entry.expireAt <= now) this.pendingAsks.delete(id);
    }
  }

  /**
   * The shard actor for `shardId`, spawning it if there isn't one.
   *
   * Creation is driven by *ownership*, not by the first message: `onShardHome`
   * calls this the moment the coordinator says the shard lives here, so an
   * allocated-but-empty shard still has a live ref for anyone asking the
   * region to locate it.  Ownership itself is demand-driven — the coordinator
   * only allocates a shard someone asked about — so nothing here runs at
   * `ClusterSharding.start` time.
   */
  private ensureShard(shardId: number): ActorRef<ShardInbox> {
    const existing = this.shards.get(shardId);
    if (existing) return existing;
    const shardConfig: ShardConfig = {
      typeName: this.config.typeName,
      shardId,
      entityActor: this.config.entityActor as ActorClassOrFactory<unknown>,
      entityOptions: this.config.entityOptions as ActorOptions<unknown> | undefined,
    };
    const ref = this.context.spawn<ShardInbox>(
      () => new Shard(shardConfig),
      `shard-${shardId}`,
    );
    this.context.watch(ref);
    this.shards.set(shardId, ref);
    // A fresh shard is an empty shard, so its idle clock starts now — that is
    // what lets a shard allocated but never used go away again on its own.
    this.shardEmptySince.set(shardId, Date.now());
    return ref;
  }

  /* ----------------------------- Coordinator ---------------------------- */

  private ensureRegistered(): void {
    const leaderOption = this.config.cluster.leader();
    if (leaderOption.isNone()) { this.scheduleRegisterRetry(); return; }
    const leader = leaderOption.value;
    // Always re-target the coordinator on each leader change.
    //
    // Built from the *leader's* system name, not ours.  An actor path carries
    // the system it belongs to, and this one is an address for somebody else's
    // actor — so guessing it from the local name only happens to work when every
    // member shares one, and produces a path the leader never registered when
    // they do not.  Generic path resolution used to paper over the difference by
    // dropping the `actor-ts://<system>` prefix and walking the local tree; that
    // is also the leg that arrives with no sender, so the coordinator's own
    // per-path handler — the thing that attributes the frame — was unreachable
    // for exactly those nodes (#712).
    const coordinatorLocation = coordinatorPath(leader.address.systemName, this.config.typeName);
    // Recorded before the ref is resolved: it is what the origin gate compares
    // against, and a directive can legitimately arrive while the local lookup
    // below is still failing.
    this.coordinatorNode = leader.address;
    if (leader.address.equals(this.config.cluster.selfAddress)) {
      const local = this.config.localResolver(coordinatorLocation) as ActorRef<ShardingMessage> | null;
      if (!local) { this.scheduleRegisterRetry(); return; }
      this.coordinatorRef = local;
    } else {
      this.coordinatorRef = new RemoteActorRef<ShardingMessage>(
        leader.address, coordinatorLocation, this.config.cluster,
      );
    }
    if (this.registerRefused) return;
    this.register();
  }

  private scheduleRegisterRetry(): void {
    this.registerTimer?.cancel();
    this.registerTimer = this.system.scheduler.scheduleOnceFunction(500, () => this.ensureRegistered());
  }

  private register(): void {
    const message: RegisterRegion = {
      kind: 'sharding.Register',
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
      proxy: this.config.proxy,
      hostedShards: Array.from(this.localShards),
      numShards: this.config.numShards,
    };
    this.tellCoordinator(message);
    // Re-ask for every pending shard home.
    for (const shardId of this.buffer.keys()) this.askCoordinator(shardId);
  }

  private tellCoordinator(message: ShardingMessage): void {
    if (!this.coordinatorRef) { this.ensureRegistered(); return; }
    this.tellCoordinatorRef(this.coordinatorRef, message);
  }

  /**
   * Send a frame to the coordinator, stamping this node's own identity on the
   * local leg.
   *
   * The coordinator honours a region's claims only when they arrive attributed
   * to the node making them (#712), and the remote leg gets that for free — the
   * receiving node's per-path envelope handler stamps the connection's peer on
   * the way in.  A bare local `tell` gets nothing, and is byte-identical to what
   * an attacker's frame produces after the generic path walk, so the local leg
   * has to build the wrapper itself.  Exactly the mirror of what
   * `ShardCoordinator.replyTo` already does in the other direction (#584);
   * without it a leader-hosted region — every region on a single-node cluster —
   * could not register at all.
   */
  private tellCoordinatorRef(ref: ActorRef<ShardingMessage>, message: ShardingMessage): void {
    const coordinator = this.coordinatorNode;
    if (coordinator === null || !coordinator.equals(this.config.cluster.selfAddress)) {
      ref.tell(message);
      return;
    }
    (ref as ActorRef<ShardingMessage | AuthenticatedShardingMessage>)
      .tell(new AuthenticatedShardingMessage(this.config.cluster.selfAddress, message));
  }

  private askCoordinator(shardId: number): void {
    const getShardHome: GetShardHome = {
      kind: 'sharding.GetShardHome',
      shardId,
      requester: this.self.path.toString(),
      requesterNode: this.config.cluster.selfAddress.toJSON(),
    };
    this.tellCoordinator(getShardHome);
  }

  /* ---------------------------- Sharding msgs -------------------------- */

  /**
   * @param peer the node whose authenticated connection the frame arrived on,
   *   or `null` for a frame that reached the mailbox unattributed — a plain
   *   local `tell`, or an inbound envelope that dodged the per-path handler.
   *   The coordinator-only arms refuse the second case outright.
   */
  private handleShardingMessage(message: ShardingMessage, peer: NodeAddress | null): void {
    match(message)
      .with({ kind: 'sharding.RegisterAcknowledgment' }, (m) => this.onRegisterAcknowledgment(m, peer))
      .with({ kind: 'sharding.RegisterRefused' }, (m) => this.onRegisterRefused(m, peer))
      .with({ kind: 'sharding.ShardHome' }, (m) => this.onShardHome(m, peer))
      .with({ kind: 'sharding.HandOff' }, (m) => this.onHandOff(m, peer))
      .with({ kind: 'sharding.RememberedEntities' }, (m) => this.onRememberedEntities(m, peer))
      .with({ kind: 'sharding.Envelope' }, (m) => this.onShardEnvelope(m))
      .with({ kind: 'sharding.Reply' }, (m) => this.onShardReply(m))
      // An EntityRef addressed one of our entities by id.
      .with({ kind: 'sharding.EntityEnvelope' }, (m) => this.onEntityEnvelope(m))
      // Someone on another node told a ref to one of our shards.
      .with({ kind: 'sharding.ToShard' }, (m) => this.onToShard(m))
      // Lifecycle reports coming up from our own shards.
      .with({ kind: 'sharding.EntityStarted' }, (m) => this.onEntityStarted(m))
      .with({ kind: 'sharding.EntityStopped' }, (m) => this.onEntityStopped(m))
      // Introspection — node-local queries plus the coordinator's fan-out.
      .with({ kind: 'sharding.GetShards' }, (m) => this.onGetShards(m))
      .with({ kind: 'sharding.GetShardLocation' }, (m) => this.onGetShardLocation(m))
      .with({ kind: 'sharding.GetShardRegionStats' }, (m) => this.onGetShardRegionStats(m))
      .with({ kind: 'sharding.ClusterShardingStats' }, (m) => this.onClusterShardingStats(m))
      .with({ kind: 'sharding.ShardMapUpdate' }, (m) => this.onShardMapUpdate(m, peer))
      // Coordinator-only messages; regions ignore them.
      .otherwise(() => this.onUnhandled());
  }

  private onUnhandled(): void {
    /* no-op */
  }

  /**
   * Whether a coordinator directive may be honoured.
   *
   * Everything the coordinator tells a region is destructive to some degree —
   * `HandOff` stops every entity under a shard, `ShardHome` moves ownership,
   * `ShardMapUpdate` publishes an allocation map to every local subscriber —
   * and until #584 the region applied all of it on nothing but the `kind`
   * string.  Two conditions have to hold: the frame arrived inside an
   * {@link AuthenticatedShardingMessage}, which the wire cannot mint, *and* the
   * peer that sent it is the node this region currently believes hosts the
   * coordinator.  The second half is not redundant — an authenticated peer is
   * any cluster member, and the wrapper alone would let any of them issue
   * directives.
   *
   * Refusing is safe: the region re-registers and re-asks for every buffered
   * shard on the next leader/membership event, so a directive dropped during a
   * leadership handover is re-requested rather than lost.
   */
  private fromCoordinator(message: ShardingMessage, peer: NodeAddress | null): boolean {
    if (peer !== null && this.coordinatorNode !== null && peer.equals(this.coordinatorNode)) return true;
    this.log.warn(
      `[sharding] refusing '${message.kind}' for '${this.config.typeName}' from `
      + `${peer ?? 'an unauthenticated sender'} — only the coordinator's node `
      + `(${this.coordinatorNode ?? 'not yet known'}) may issue it`,
    );
    return false;
  }

  private onShardEnvelope(message: ShardEnvelope): void {
    const senderRef =
      message.correlationId !== null && message.originRegion !== null && message.originNode !== null
        ? new ShardSenderRef(
            NodeAddress.fromJSON(message.originNode),
            message.originRegion,
            message.correlationId,
            this.config.cluster,
            (path) => this.config.localResolver(path),
          )
        : null;
    // The payload may itself be an EntityEnvelope — an EntityRef whose entity
    // turned out to live on this node.  routeMessage sorts that out.
    this.routeMessage(message.message as RoutableMessage<TMessage>, senderRef);
  }

  private onEntityEnvelope(message: EntityEnvelope): void {
    this.routeMessage(message, this.sender.toNullable());
  }

  /**
   * A {@link RemoteShardRef} on another node was told something.  We own the
   * shard, so we are the only one who can guarantee an actor exists to take
   * it — `ensureShard` re-creates a shard that had passivated (#901).
   *
   * The sender travels through, so an `ask` against a remote shard ref gets
   * its reply the same way a local one does.
   */
  private onToShard(message: ToShard): void {
    if (this.config.proxy) return;
    if (!this.localShards.has(message.shardId)) return;
    this.ensureShard(message.shardId).tell(message.message as never, this.sender.toNullable());
  }

  private onShardReply(message: ShardReply): void {
    const entry = this.pendingAsks.get(message.correlationId);
    if (!entry) return;
    this.pendingAsks.delete(message.correlationId);
    entry.sender.tell(message.message as never);
  }

  private onRegisterAcknowledgment(message: RegisterAcknowledgment, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    this.log.debug(`[sharding] region '${this.config.typeName}' registered with coordinator`);
    this.registered = true;
    this.registerRefused = false;
    this.registerTimer?.cancel();
    this.registerTimer = null;
  }

  /**
   * The coordinator rejected this region's configuration (#633).
   *
   * Logged at error rather than thrown: `start()` has long returned by the
   * time a coordinator answers, and throwing here would only restart the
   * region into the same rejection.  The region stays up and keeps buffering,
   * which is the fail-stop the alternative lacks — an accepted mismatch routes
   * the same entity id into two different shards and runs two live instances
   * of it, one per node, at paths that never collide.
   */
  private onRegisterRefused(message: RegisterRefused, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    this.registered = false;
    this.registerRefused = true;
    this.registerTimer?.cancel();
    this.registerTimer = null;
    this.log.error(
      `[sharding] the coordinator refused to register region '${this.config.typeName}': `
      + `numShards must match across the cluster, but this node is configured with `
      + `${message.regionNumShards} and the coordinator governs the type with ${message.numShards}. `
      + `No shard will be allocated here and messages for this type will keep buffering until the `
      + `configuration agrees. Set the same numShards on every node that starts or proxies this type `
      + `(explicitly, or via actor-ts.sharding.num-shards).`,
    );
  }

  /**
   * A shard id is `hash(entityId) % numShards`, so anything outside the range
   * did not come from an honest allocation.  It matters here more than
   * elsewhere because `ensureShard` turns the id into a **child actor name**:
   * an out-of-range or non-integer id minted a permanent child under an
   * attacker-chosen name, and the region has no way to tell it apart from a
   * real shard afterwards (#569).
   */
  private isKnownShardId(shardId: number): boolean {
    if (Number.isInteger(shardId) && shardId >= 0 && shardId < this.config.numShards) return true;
    this.log.warn(
      `[sharding] ignoring shard id ${shardId} for '${this.config.typeName}' — `
      + `outside 0..${this.config.numShards - 1}`,
    );
    return false;
  }

  /**
   * Whether a `HandOff` for `shardId` has anything to hand off (#584).
   *
   * The origin gate answers *who* may order a handoff; this answers *what* one
   * can be ordered for, and the arm had neither an ownership nor an idempotence
   * precondition.  A `HandOff` for a shard this region does not own still marked
   * it `'handing-off'`, acknowledged, and — since `shards.get(shardId)` was
   * `undefined` — fell straight into `completeHandOff`, which deletes
   * `shardHomes`, `shardHomeNodes` and `shardState` for the id and announces a
   * `HandOffComplete`.  That is a routing-cache eviction for a shard the region
   * was never handing off, reachable by replaying one authentic frame: the
   * coordinator issues `HandOff` once per rebalance, but `Transport` flushes
   * frames buffered before a handshake completed, so a genuine one can also
   * land *late*, long after the coordinator's `handOffTimeoutMs` already
   * force-reallocated the shard.
   *
   * `localShards`, deliberately not `shards`: a shard whose actor has passivated
   * (#901) has no `shards` entry and is still legitimately owned, so it must
   * still hand off.  `handingOff` covers the window in between — the shard actor
   * is stopping and `handleShardTerminated` will complete the handoff, so a
   * second directive has nothing left to add.
   *
   * The cost of refusing is bounded and self-healing: the coordinator only ever
   * sends `HandOff` to the region its own `shardHome` names, so a refusal means
   * the two disagree about ownership — and the `handOffTimeoutMs` fallback
   * (`ShardCoordinator.beginHandOff`) exists for exactly that, force-reallocating
   * the shard instead of waiting forever.
   */
  private ownsShardToHandOff(shardId: number): boolean {
    if (this.handingOff.has(shardId)) {
      this.log.debug(
        `[sharding] shard ${shardId} of '${this.config.typeName}' is already handing off; `
        + `ignoring the duplicate directive`,
      );
      return false;
    }
    if (this.localShards.has(shardId)) return true;
    this.log.warn(
      `[sharding] refusing to hand off shard ${shardId} of '${this.config.typeName}' — `
      + `this region does not own it, so there is nothing to give up`,
    );
    return false;
  }

  private onShardHome(message: ShardHome, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    if (!this.isKnownShardId(message.shardId)) return;
    const node = NodeAddress.fromJSON(message.node);
    const local = node.equals(this.config.cluster.selfAddress) && message.region === this.self.path.toString();
    this.log.debug(
      `[sharding] shard ${message.shardId} of '${this.config.typeName}' home=${node} (${local ? 'LOCAL' : 'remote'})`,
    );
    this.shardHomes.set(message.shardId, message.region);
    this.shardHomeNodes.set(message.shardId, node);
    if (local) {
      this.localShards.add(message.shardId);
      this.shardState.set(message.shardId, 'owned');
      if (!this.config.proxy) this.ensureShard(message.shardId);
    } else {
      this.localShards.delete(message.shardId);
      this.shardState.delete(message.shardId);
    }
    // Order matters: the shard actor has to exist before anyone is handed a
    // ref to it, and the ref answers before the buffered traffic replays.
    this.flushLocationAsks(message.shardId);
    this.flushBuffer(message.shardId);
  }

  /* ---------------------------- Introspection --------------------------- */

  /**
   * `ClusterSharding.shards()` asking its own region.  The region is an actor
   * with a resolvable path, so it can do the cross-node half through the
   * coordinator and hand the answer back to the in-process asker — which is
   * why the public API is a method on a plain object and still works from
   * any node.
   */
  private onGetShards(message: GetShards): void {
    const asker = this.sender.toNullable();
    if (!asker) return;
    const correlationId = ++this.nextStatsCorrelation;
    this.pendingStatsAsks.set(correlationId, asker);
    this.tellCoordinator({
      kind: 'sharding.GetClusterShardingStats',
      correlationId,
      requester: this.self.path.toString(),
      requesterNode: this.config.cluster.selfAddress.toJSON(),
      timeoutMs: message.timeoutMs,
    });
  }

  private onClusterShardingStats(message: ClusterShardingStats): void {
    const asker = this.pendingStatsAsks.get(message.correlationId);
    if (!asker) return;
    this.pendingStatsAsks.delete(message.correlationId);
    asker.tell(message.shards.map((location) => this.toShardInfo(location)) as never);
  }

  /**
   * `ClusterSharding.shardRefFor()`.  An unplaced shard is not an error — ask
   * the coordinator, which allocates it exactly as a normal message would,
   * and answer once its home is known.
   */
  private onGetShardLocation(message: GetShardLocation): void {
    const asker = this.sender.toNullable();
    if (!asker) return;
    const ref = this.knownShardRef(message.shardId);
    if (ref) { asker.tell(ref as never); return; }
    let waiting = this.pendingLocationAsks.get(message.shardId);
    if (!waiting) { waiting = []; this.pendingLocationAsks.set(message.shardId, waiting); }
    waiting.push(asker);
    this.askCoordinator(message.shardId);
  }

  private flushLocationAsks(shardId: number): void {
    const waiting = this.pendingLocationAsks.get(shardId);
    if (!waiting) return;
    const ref = this.knownShardRef(shardId);
    if (!ref) return;
    this.pendingLocationAsks.delete(shardId);
    for (const asker of waiting) asker.tell(ref as never);
  }

  /**
   * Republish the coordinator's allocation map as a local cluster event.
   *
   * The coordinator runs only on the leader, so it is the region — which
   * exists on every node — that puts `ShardMapChanged` in front of local
   * subscribers.  Without this leg the event would fire on one node out of N,
   * which is no use to a per-node DevTools panel or an application listener.
   */
  private onShardMapUpdate(message: ShardMapUpdate, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    this.config.cluster._publishClusterEvent(new ShardMapChanged(
      message.typeName,
      new Map(message.shards),
      message.version,
      message.regions,
    ));
  }

  /** The coordinator's fan-out leg: what this node hosts, and how full. */
  private onGetShardRegionStats(message: GetShardRegionStats): void {
    const shards = Array.from(this.localShards).map((shardId) => ({
      shardId,
      entityCount: this.shardEntities.get(shardId)?.size ?? 0,
      // Allocated here either way; `resident` is what separates a shard that
      // is running and empty from one that passivated (#901).
      resident: this.shards.has(shardId),
    }));
    const reply: ShardRegionStats = {
      kind: 'sharding.ShardRegionStats',
      queryId: message.queryId,
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
      shards,
    };
    this.replyToPath(message.requester, message.requesterNode, reply);
  }

  private toShardInfo(location: ShardLocation): ShardInfo {
    const node = NodeAddress.fromJSON(location.node);
    return {
      shardId: location.shardId,
      node,
      regionPath: location.regionPath,
      entityCount: location.entityCount,
      resident: location.resident,
      local: node.equals(this.config.cluster.selfAddress),
      ref: this.shardRef(location.shardId, node, location.regionPath),
    };
  }

  /** A ref for a shard whose home we already know; `null` if we don't. */
  private knownShardRef(shardId: number): ActorRef<ShardMessage> | null {
    const regionPath = this.shardHomes.get(shardId);
    const node = this.shardHomeNodes.get(shardId);
    if (!regionPath || !node) return null;
    return this.shardRef(shardId, node, regionPath);
  }

  /**
   * The real shard actor when we host it, a {@link RemoteShardRef} otherwise.
   *
   * Both halves have to survive the shard actor not being up at this instant,
   * because since #892 an empty one is stopped and re-created on demand.  Here
   * we can simply materialise it; for a shard on another node only its own
   * region can, which is what `RemoteShardRef` delegates to.
   */
  private shardRef(shardId: number, node: NodeAddress, regionPath: string): ActorRef<ShardMessage> {
    if (node.equals(this.config.cluster.selfAddress)) {
      const local = this.shards.get(shardId);
      if (local) return local as unknown as ActorRef<ShardMessage>;
      // Ours, but the actor is not up — passivated, or allocated and never
      // needed.  A path ref would be a dead ref: nothing resolves that path
      // until the shard exists.  So materialise it, which is also the honest
      // reading of "give me a handle on this shard".  `ensureShard` restarts
      // the idle clock, so asking buys it a full window.
      if (this.localShards.has(shardId) && !this.config.proxy) {
        return this.ensureShard(shardId) as unknown as ActorRef<ShardMessage>;
      }
    }
    return new RemoteShardRef(node, regionPath, shardId, this.config.cluster);
  }

  /**
   * Send a sharding message to an arbitrary region/coordinator path — today
   * only the statistics fan-out's answer, back to the coordinator that asked.
   *
   * That asker refuses a frame which reached its mailbox unattributed (#712), so
   * the local leg carries the same wrapper `tellCoordinatorRef` builds, for the
   * same reason.
   */
  private replyToPath(path: string, nodeData: NodeAddressData, message: ShardingMessage): void {
    const node = NodeAddress.fromJSON(nodeData);
    if (node.equals(this.config.cluster.selfAddress)) {
      const local = this.config.localResolver(path) as
        ActorRef<ShardingMessage | AuthenticatedShardingMessage> | null;
      local?.tell(new AuthenticatedShardingMessage(this.config.cluster.selfAddress, message));
      return;
    }
    new RemoteActorRef<ShardingMessage>(node, path, this.config.cluster).tell(message);
  }

  /* --------------------------- Entity lifecycle ------------------------- */

  /**
   * A shard reports a spawn.  The region mirrors the per-shard entity index
   * because it owns the passivation policies and answers stats queries, and
   * relays the event to the coordinator when entities are remembered.
   */
  private onEntityStarted(message: EntityStarted): void {
    let entityIds = this.shardEntities.get(message.shardId);
    if (!entityIds) { entityIds = new Set(); this.shardEntities.set(message.shardId, entityIds); }
    entityIds.add(message.entityId);
    // No longer empty, so the shard sweep has nothing to measure.
    this.shardEmptySince.delete(message.shardId);
    if (!this.entityActivity.has(message.entityId)) {
      // Remembered entities are pre-created without ever being routed to.
      this.entityActivity.set(message.entityId, { shardId: message.shardId, lastActivity: Date.now() });
    }
    if (this.config.rememberEntities) this.tellCoordinator(message);
  }

  private onEntityStopped(message: EntityStopped): void {
    this.shardEntities.get(message.shardId)?.delete(message.entityId);
    if ((this.shardEntities.get(message.shardId)?.size ?? 0) === 0) {
      // That was the last one — the shard's own idle window starts here.
      this.shardEmptySince.set(message.shardId, Date.now());
    }
    this.entityActivity.delete(message.entityId);
    this.passivating.delete(message.entityId);
    if (this.config.rememberEntities) this.tellCoordinator(message);
  }

  /**
   * Give a shard up.  Stopping the shard actor terminates its entities
   * underneath it, and the runtime only reports `Terminated` once they are
   * all gone — so `HandOffComplete` now genuinely means "nothing of this
   * shard is running here any more", which the previous fire-and-forget
   * entity stop could not promise.
   */
  private onHandOff(message: HandOff, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    // `onShardHome` has had the #569 range check since it was added; this arm
    // never got it, so an out-of-range id still walked into `completeHandOff`
    // and deleted cache entries under a shard that cannot exist.
    if (!this.isKnownShardId(message.shardId)) return;
    if (!this.ownsShardToHandOff(message.shardId)) return;
    const shardId = message.shardId;
    const entityIds = Array.from(this.shardEntities.get(shardId) ?? []);
    this.log.debug(
      `[sharding] handing off shard ${shardId} of '${this.config.typeName}' (stopping ${entityIds.length} entit(ies))`,
    );
    this.shardState.set(shardId, 'handing-off');
    const ack: BeginHandOffAcknowledgment = { kind: 'sharding.BeginHandOffAcknowledgment', shardId };
    this.tellCoordinator(ack);

    // Deliberately no `EntityStopped`, the same way an unexpected shard death
    // sends none (#894).  These entities are not being forgotten — they are
    // moving, and the coordinator's registry is the record that has to survive
    // the move so `tryAllocate` can ship it to the new owner.  Announcing them
    // as stopped emptied that registry mid-rebalance, so the new owner started
    // with nothing and `rememberEntities` lost precisely what it exists to
    // keep (#632).  Local bookkeeping still goes, below: those entities really
    // are gone *from this node*.
    this.forgetShardEntities(shardId);

    const shard = this.shards.get(shardId);
    if (!shard) { this.completeHandOff(shardId); return; }
    this.handingOff.add(shardId);
    shard.stop();
  }

  private completeHandOff(shardId: number): void {
    this.handingOff.delete(shardId);
    // A handoff can land on a shard we were already passivating; the handoff
    // wins, so clear the passivation bookkeeping with it.
    this.passivatingShards.delete(shardId);
    this.shardEmptySince.delete(shardId);
    this.shards.delete(shardId);
    this.localShards.delete(shardId);
    this.shardHomes.delete(shardId);
    this.shardHomeNodes.delete(shardId);
    this.shardState.delete(shardId);

    const complete: HandOffComplete = {
      kind: 'sharding.HandOffComplete',
      shardId,
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
    };
    this.tellCoordinator(complete);

    // Anything that arrived while the shard was handing off is still queued,
    // and clearing `shardHomes` above means nothing will replay it: the
    // coordinator sends `ShardHome` to the *new* owner and to regions with an
    // outstanding `GetShardHome`, and we are neither.  Ask, so the reply
    // flushes the buffer through `onShardHome` like any other placement.
    // Either ordering works — arriving before the `HandOffComplete` just
    // parks us in the coordinator's `pending` until it reallocates.
    if (this.buffer.has(shardId)) this.askCoordinator(shardId);
  }

  /**
   * A shard we passivated is gone.  Unlike a handoff this gives nothing up:
   * the shard is still ours, still local, still routable — only the actor
   * went.  So `route` keeps recognising it and anything buffered during the
   * stop re-creates it on the way through.
   */
  private completeShardPassivation(shardId: number): void {
    this.passivatingShards.delete(shardId);
    this.shards.delete(shardId);
    this.forgetShardEntities(shardId);
    // A `ShardHome` naming a different owner can land mid-stop, and then the
    // shard is not ours to mark owned again.  Clearing the state either way
    // matters: a stuck `'passivating'` would buffer for this shard forever.
    if (this.localShards.has(shardId)) this.shardState.set(shardId, 'owned');
    else this.shardState.delete(shardId);
    this.flushBuffer(shardId);
  }

  /** Drop every entity bookkeeping entry belonging to `shardId`. */
  private forgetShardEntities(shardId: number): void {
    for (const entityId of this.shardEntities.get(shardId) ?? []) {
      this.entityActivity.delete(entityId);
      this.passivating.delete(entityId);
    }
    this.shardEntities.delete(shardId);
    this.shardEmptySince.delete(shardId);
  }

  private onRememberedEntities(message: RememberedEntities, peer: NodeAddress | null): void {
    if (!this.fromCoordinator(message, peer)) return;
    // Pre-create entities we've been told about but haven't materialised yet.
    if (!this.localShards.has(message.shardId)) return;
    if (this.config.proxy) return;
    const startEntities: ShardMessage = {
      kind: 'sharding.StartEntities',
      entityIds: message.entityIds,
    };
    this.ensureShard(message.shardId).tell(startEntities);
  }

  /* ----------------------------- Passivation --------------------------- */

  /**
   * An entity's parent is its shard, so `Passivate` normally never reaches
   * the region.  Code that kept a region ref from before the shard level
   * existed can still send one here — forward it to the shard that hosts the
   * entity, derived from the entity ref's own path.
   */
  private handlePassivate(message: Passivate): void {
    const candidate = message.entity ?? this.sender.toNullable();
    if (!candidate) return;
    const shardId = shardIdFromEntityPath(candidate.path.toString());
    const shard = shardId === null ? undefined : this.shards.get(shardId);
    if (!shard) {
      this.log.warn(
        `[sharding] Passivate for '${candidate.path}' reached the region but no local shard owns it`,
      );
      return;
    }
    shard.tell(message as never, candidate);
  }

  /**
   * A shard actor stopped.  Expected during handoff — that is how we learn
   * the entities are really gone — and expected after a passivation, where it
   * is how we learn the shard is clear to be re-created.  Otherwise the shard
   * died past its supervisor's budget; drop it so the next message respawns
   * it, and keep the ownership so buffered work is not thrown away.
   */
  private handleShardTerminated(t: Terminated): void {
    for (const [shardId, ref] of this.shards) {
      if (!ref.equals(t.actor)) continue;
      if (this.handingOff.has(shardId)) { this.completeHandOff(shardId); return; }
      if (this.passivatingShards.has(shardId)) { this.completeShardPassivation(shardId); return; }
      this.log.warn(
        `[sharding] shard ${shardId} of '${this.config.typeName}' stopped unexpectedly; `
        + `it will be recreated on the next message`,
      );
      this.shards.delete(shardId);
      this.forgetShardEntities(shardId);
      // Deliberately no `EntityStopped`: under `rememberEntities` those
      // entities are meant to come back, and the coordinator's registry is
      // still the record of them.  But ownership did not move, so nothing
      // re-ships that registry on its own (#894) — ask for it.
      if (this.config.rememberEntities) {
        this.tellCoordinator({ kind: 'sharding.GetRememberedEntities', shardId });
      }
      return;
    }
  }

  private passivationSweep(): void {
    this.sweepIdleEntities();
    this.sweepEmptyShards();
  }

  private sweepIdleEntities(): void {
    if (this.config.passivationIdleMs <= 0) return;
    const now = Date.now();
    for (const [entityId, activity] of this.entityActivity) {
      if (this.passivating.has(entityId)) continue;
      if (now - activity.lastActivity < this.config.passivationIdleMs) continue;
      this.requestPassivation(entityId, activity.shardId);
    }
  }

  /**
   * Stop shards that have stood empty for a whole window (#892).  Without it a
   * shard outlives its entities indefinitely: it appears when the coordinator
   * allocates it here, and apart from a handoff nothing ever stops it again —
   * so a long-running node accumulates one empty shard per `numShards` as ids
   * spread over the hash space.
   *
   * Ownership is untouched, so this costs only the actor: `route` still sees
   * the shard as local and the next message re-creates it.  An empty shard has
   * no state to lose, which is what makes stopping it safe at all; a shard
   * with buffered traffic is skipped, because that traffic is about to bring
   * it back regardless.
   */
  private sweepEmptyShards(): void {
    if (this.config.shardPassivationIdleMs <= 0 || this.config.proxy) return;
    const now = Date.now();
    // `passivateShard` only touches shardState/passivatingShards, never
    // `shards` itself — the deletion happens later, on Terminated — so
    // iterating the live map here is safe.
    for (const shardId of this.shards.keys()) {
      if (!this.localShards.has(shardId)) continue;
      if (this.handingOff.has(shardId) || this.passivatingShards.has(shardId)) continue;
      if ((this.shardEntities.get(shardId)?.size ?? 0) > 0) continue;
      if (this.buffer.has(shardId)) continue;
      const emptySince = this.shardEmptySince.get(shardId);
      if (emptySince === undefined) continue;
      if (now - emptySince < this.config.shardPassivationIdleMs) continue;
      this.passivateShard(shardId);
    }
  }

  /**
   * Ask an empty shard to go away.  Mirrors {@link onHandOff}: mark it so
   * `route` buffers instead of delivering, then stop it and let the
   * `Terminated` watch close the loop.  Marking and stopping in the *same*
   * synchronous step is what makes this loss-free — nothing the region routes
   * can slip into a mailbox that is already on its way out.
   */
  private passivateShard(shardId: number): void {
    const shard = this.shards.get(shardId);
    if (!shard) return;
    this.log.debug(
      `[sharding] passivating empty shard ${shardId} of '${this.config.typeName}'`,
    );
    this.passivatingShards.add(shardId);
    this.shardState.set(shardId, 'passivating');
    shard.stop();
  }

  /* -------------------------------- Buffer ----------------------------- */

  private bufferShard(shardId: number, message: RoutableMessage<TMessage>, sender: ActorRef | null): void {
    let queue = this.buffer.get(shardId);
    if (!queue) { queue = []; this.buffer.set(shardId, queue); }
    queue.push({ message, sender });
  }

  private flushBuffer(shardId: number): void {
    const queue = this.buffer.get(shardId);
    if (!queue || queue.length === 0) return;
    this.buffer.delete(shardId);
    for (const { message, sender } of queue) this.routeMessage(message, sender);
  }

  /* -------------------------------- Misc ------------------------------ */

  private onLeaderChanged(): void {
    this.registered = false;
    this.coordinatorRef = null;
    // Nobody is believed to host the coordinator until `ensureRegistered`
    // re-reads the leader — a directive arriving in that gap has no authority
    // to check against and is refused rather than trusted on the old belief.
    this.coordinatorNode = null;
    // The coordinator moved, so the count it governs the type with may have
    // moved with it; a refusal from the previous leader says nothing about
    // this one.
    this.registerRefused = false;
    this.ensureRegistered();
  }

  private onMemberRemoved(event: MemberRemoved): void {
    this.invalidateHomesOnNode(event.member.address);
    this.ensureRegistered();
  }

  private onMemberUp(): void {
    this.ensureRegistered();
  }

  private onOtherClusterEvent(): void {
    /* other events irrelevant here */
  }

  /**
   * When a node is removed from the cluster, any shards we thought lived
   * there are now orphans — drop the cache entries so the next message
   * re-asks the coordinator for the new owner.
   */
  private invalidateHomesOnNode(node: NodeAddress): void {
    for (const [shardId, addr] of Array.from(this.shardHomeNodes.entries())) {
      if (addr.equals(node)) {
        this.shardHomes.delete(shardId);
        this.shardHomeNodes.delete(shardId);
        this.shardState.delete(shardId);
      }
    }
  }
}

export function coordinatorPath(systemName: string, typeName: string): string {
  // Resolvable both locally (via localResolver) and remotely by path.
  return systemActorPath(
    systemName,
    SystemGroups.clusterSharding,
    shardCoordinatorName(typeName),
  );
}

/** Child name of the shard actor for `shardId` under its region. */
export function shardName(shardId: number): string {
  return `shard-${shardId}`;
}

/** Full path of a shard actor, given the path of the region that hosts it. */
export function shardPath(regionPath: string, shardId: number): string {
  return `${regionPath}/${shardName(shardId)}`;
}

/**
 * Recover the shard id from the path of an entity (or of the shard itself).
 * `null` when the path does not run through a shard — which, since entities
 * became grandchildren of the region, only happens for foreign refs.
 */
function shardIdFromEntityPath(path: string): number | null {
  const matched = path.match(/\/shard-(\d+)(?:\/|$)/);
  if (!matched) return null;
  const shardId = Number(matched[1]);
  return Number.isFinite(shardId) ? shardId : null;
}

/**
 * A shard hosted on another node.
 *
 * Its `path` is the shard's own — that is the identity callers see, compare
 * and log — but delivery goes to the **owning region**, wrapped in a
 * {@link ToShard}.  Addressing the shard path directly is what #901 was: since
 * #892 an empty shard is stopped and re-created on demand, so between those
 * two moments nothing resolves that path and the receiving node drops the
 * message.  The region is always up and materialises the shard first.
 *
 * This mirrors the entity path, where {@link ShardEnvelope} has likewise
 * always been addressed to the region rather than to the entity.
 */
export class RemoteShardRef extends ActorRef<ShardMessage> {
  readonly path: ActorPath;
  private readonly region: RemoteActorRef<ShardingMessage>;

  constructor(
    node: NodeAddress,
    regionPath: string,
    private readonly shardId: number,
    cluster: Cluster,
  ) {
    super();
    this.path = remoteActorPath(shardPath(regionPath, shardId), node.systemName);
    this.region = new RemoteActorRef<ShardingMessage>(node, regionPath, cluster);
  }

  override tell(message: ShardMessage, sender: ActorRef | null = null): void {
    this.region.tell({ kind: 'sharding.ToShard', shardId: this.shardId, message }, sender);
  }

  /** The shard's path, not the region's — the region is only the delivery route. */
  override toString(): string { return this.path.toString(); }
}

/**
 * Synthetic sender ref given to entities whose messages arrived over the
 * wire.  Any reply tells a {@link ShardReply} back to the origin region,
 * which demultiplexes using the correlation id.  Exported for tests/typing.
 */
export class ShardSenderRef extends ActorRef<unknown> {
  readonly path: ActorPath;

  constructor(
    readonly originNode: NodeAddress,
    readonly originRegion: string,
    readonly correlationId: number,
    private readonly cluster: Cluster,
    private readonly localResolver: (path: string) => ActorRef | null,
  ) {
    super();
    const lastSeg = originRegion.split('/').pop() ?? 'region';
    this.path = new ActorPath(
      `shard-reply-${lastSeg}-${correlationId}`,
      null,
      originNode.systemName,
    );
  }

  override tell(message: unknown): void {
    const reply: ShardReply = {
      kind: 'sharding.Reply',
      correlationId: this.correlationId,
      message,
    };
    if (this.originNode.equals(this.cluster.selfAddress)) {
      const local = this.localResolver(this.originRegion) as ActorRef<ShardingMessage> | null;
      if (local) local.tell(reply);
      return;
    }
    new RemoteActorRef<ShardingMessage>(this.originNode, this.originRegion, this.cluster).tell(reply);
  }
}
