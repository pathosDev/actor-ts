import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import { ActorRef } from '../../ActorRef.js';
import { ActorPath } from '../../ActorPath.js';
import { Props } from '../../Props.js';
import type { ShardingOptionsType } from './ShardingOptions.js';
import type { Cancellable } from '../../Scheduler.js';
import { Terminated } from '../../SystemMessages.js';
import type { Cluster } from '../Cluster.js';
import {
  LeaderChanged,
  MemberRemoved,
  MemberUp,
} from '../ClusterEvents.js';
import { NodeAddress } from '../NodeAddress.js';
import { RemoteActorRef } from '../RemoteActorRef.js';
import { hashShardId } from './ShardAllocator.js';
import { Passivate } from './Passivate.js';
import { Shard, type ShardConfig, type ShardInbox, type ShardMessage } from './Shard.js';
import { ShardCoordinator } from './ShardCoordinator.js';
import {
  isShardingMessage,
  type RegisterRegion,
  type ShardEnvelope,
  type ShardReply,
  type ShardingMessage,
  type GetShardHome,
  type ShardHome,
  type HandOff,
  type HandOffComplete,
  type BeginHandOffAcknowledgment,
  type RememberedEntities,
  type RegisterAcknowledgment,
  type EntityStarted,
  type EntityStopped,
} from './ShardingProtocol.js';

export type ShardRegionConfig<TMessage> = {
  readonly typeName: string;
  readonly entityProps: Props<TMessage>;
  readonly extractEntityId: (message: TMessage) => string;
  readonly extractEntityMessage: (message: TMessage) => unknown;
  readonly numShards: number;
  readonly role?: string;
  readonly proxy: boolean;
  readonly rememberEntities: boolean;
  readonly passivationIdleMs: number;
  readonly maxEntities: number;
  readonly cluster: Cluster;
  readonly localResolver: (path: string) => ActorRef | null;
};

/** What the region knows about a local entity — enough to decide passivation. */
type EntityActivity = {
  readonly shardId: number;
  lastActivity: number;
};

type ShardState = 'owned' | 'handing-off';

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
 * the *passivation policy* — both the idle sweep and the `maxEntities` LRU.
 * It sees every message on this node, so it is the only place where a
 * node-wide entity cap can be enforced; a shard only ever sees its own slice.
 */
export class ShardRegion<TMessage = unknown> extends Actor<TMessage | ShardingMessage | Terminated | Passivate> {
  private readonly shardHomes = new Map<number, string>(); // shardId → region path
  private readonly shardHomeNodes = new Map<number, NodeAddress>();
  private readonly localShards = new Set<number>();
  private readonly shardState = new Map<number, ShardState>();
  /** Shard actors hosted here, keyed by shard id. */
  private readonly shards = new Map<number, ActorRef<ShardInbox>>();
  /** Shards stopped on purpose for a handoff — tells an expected stop from a crash. */
  private readonly handingOff = new Set<number>();
  private readonly shardEntities = new Map<number, Set<string>>(); // shardId → entityIds
  private readonly entityActivity = new Map<string, EntityActivity>(); // entityId → activity
  /** Entities we have already asked a shard to passivate — excluded from the LRU count. */
  private readonly passivating = new Set<string>();
  /** Messages buffered while their shard home is unknown or in transition. */
  private readonly buffer = new Map<number, Array<{ message: TMessage; sender: ActorRef | null }>>();

  private coordinatorRef: ActorRef<ShardingMessage> | null = null;
  private unsubscribe: (() => void) | null = null;
  private passivationTimer: Cancellable | null = null;
  private registerTimer: Cancellable | null = null;
  private registered = false;

  /**
   * Senders of messages currently awaiting a reply from a remote shard.
   * Keyed by a correlation id that travels with {@link ShardEnvelope} across
   * the wire; the owning region looks it up when a {@link ShardReply} arrives.
   */
  private readonly pendingAsks = new Map<number, { sender: ActorRef; expireAt: number }>();
  private nextCorrelation = 0;
  private asksSweepTimer: Cancellable | null = null;
  /** How long an unsettled ask entry is kept before being GC'd. */
  private readonly asksTtlMs = 60_000;

  constructor(public readonly config: ShardRegionConfig<TMessage>) { super(); }

  static settingsToConfig<TMessage>(
    s: ShardingOptionsType<TMessage>,
    cluster: Cluster,
    localResolver: (path: string) => ActorRef | null,
  ): ShardRegionConfig<TMessage> {
    return {
      typeName: s.typeName,
      entityProps: s.entityProps,
      extractEntityId: s.extractEntityId,
      extractEntityMessage: s.extractEntityMessage ?? ((m: TMessage) => m as unknown),
      numShards: s.numShards ?? 64,
      role: s.role,
      proxy: s.proxy ?? false,
      rememberEntities: s.rememberEntities ?? false,
      passivationIdleMs: s.passivationIdleMs ?? 0,
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

    this.ensureRegistered();

    if (this.config.passivationIdleMs > 0) {
      this.passivationTimer = this.system.scheduler.scheduleAtFixedRateFunction(
        this.config.passivationIdleMs, this.config.passivationIdleMs,
        () => this.passivationSweep(),
      );
    }

    this.asksSweepTimer = this.system.scheduler.scheduleAtFixedRateFunction(
      this.asksTtlMs, this.asksTtlMs,
      () => this.sweepPendingAsks(),
    );
  }

  override postStop(): void {
    this.unsubscribe?.();
    this.passivationTimer?.cancel();
    this.registerTimer?.cancel();
    this.asksSweepTimer?.cancel();
  }

  override onReceive(message: TMessage | ShardingMessage | Terminated | Passivate): void {
    if (isShardingMessage(message)) {
      this.handleShardingMessage(message);
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
    this.routeUserMessage(message as TMessage, this.sender.toNullable());
  }

  /* ----------------------------- Routing -------------------------------- */

  private routeUserMessage(message: TMessage, sender: ActorRef | null): void {
    const entityId = this.config.extractEntityId(message);
    const shardId = hashShardId(entityId, this.config.numShards);
    const entityMessage = this.config.extractEntityMessage(message) as TMessage;

    const state = this.shardState.get(shardId);
    if (state === 'handing-off') {
      this.bufferShard(shardId, message, sender);
      return;
    }

    const ownerPath = this.shardHomes.get(shardId);
    if (!ownerPath) {
      this.bufferShard(shardId, message, sender);
      this.askCoordinator(shardId);
      return;
    }

    if (this.localShards.has(shardId)) {
      this.deliverLocal(shardId, entityId, entityMessage, sender);
    } else {
      const node = this.shardHomeNodes.get(shardId);
      if (!node) { this.bufferShard(shardId, message, sender); this.askCoordinator(shardId); return; }
      this.deliverRemote(node, ownerPath, message, sender);
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
    this.ensureShard(shardId).tell({ $t: 'sharding.EntityEnvelope', entityId, message }, sender);
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
    shard.tell({ $t: 'sharding.PassivateEntity', entityId });
  }

  private deliverRemote(node: NodeAddress, path: string, message: TMessage, sender: ActorRef | null): void {
    if (sender === null) {
      // Nothing to reply to — skip the envelope wrapping.
      new RemoteActorRef<TMessage>(node, path, this.config.cluster).tell(message);
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
      $t: 'sharding.Envelope',
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
   * The shard actor for `shardId`, spawning it if this is the first time we
   * own it.  Shards are created **eagerly on ownership** rather than on the
   * first message, so an allocated-but-empty shard still has a live ref for
   * anyone asking the region to locate it.
   */
  private ensureShard(shardId: number): ActorRef<ShardInbox> {
    const existing = this.shards.get(shardId);
    if (existing) return existing;
    const shardConfig: ShardConfig = {
      typeName: this.config.typeName,
      shardId,
      entityProps: this.config.entityProps as Props<unknown>,
    };
    const ref = this.context.spawn(
      Props.create<ShardInbox>(() => new Shard(shardConfig)),
      `shard-${shardId}`,
    );
    this.context.watch(ref);
    this.shards.set(shardId, ref);
    return ref;
  }

  /* ----------------------------- Coordinator ---------------------------- */

  private ensureRegistered(): void {
    const leaderOption = this.config.cluster.leader();
    if (leaderOption.isNone()) { this.scheduleRegisterRetry(); return; }
    const leader = leaderOption.value;
    // Always re-target the coordinator on each leader change.
    const coordPath = coordinatorPath(this.config.cluster.system.name, this.config.typeName);
    if (leader.address.equals(this.config.cluster.selfAddress)) {
      const local = this.config.localResolver(coordPath) as ActorRef<ShardingMessage> | null;
      if (!local) { this.scheduleRegisterRetry(); return; }
      this.coordinatorRef = local;
    } else {
      this.coordinatorRef = new RemoteActorRef<ShardingMessage>(
        leader.address, coordPath, this.config.cluster,
      );
    }
    this.register();
  }

  private scheduleRegisterRetry(): void {
    this.registerTimer?.cancel();
    this.registerTimer = this.system.scheduler.scheduleOnceFunction(500, () => this.ensureRegistered());
  }

  private register(): void {
    const message: RegisterRegion = {
      $t: 'sharding.Register',
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
      proxy: this.config.proxy,
      hostedShards: Array.from(this.localShards),
    };
    this.tellCoordinator(message);
    // Re-ask for every pending shard home.
    for (const shardId of this.buffer.keys()) this.askCoordinator(shardId);
  }

  private tellCoordinator(message: ShardingMessage): void {
    if (!this.coordinatorRef) { this.ensureRegistered(); return; }
    this.coordinatorRef.tell(message);
  }

  private askCoordinator(shardId: number): void {
    const getShardHome: GetShardHome = {
      $t: 'sharding.GetShardHome',
      shardId,
      requester: this.self.path.toString(),
      requesterNode: this.config.cluster.selfAddress.toJSON(),
    };
    this.tellCoordinator(getShardHome);
  }

  /* ---------------------------- Sharding msgs -------------------------- */

  private handleShardingMessage(message: ShardingMessage): void {
    match(message)
      .with({ $t: 'sharding.RegisterAcknowledgment' }, (m) => this.onRegisterAcknowledgment(m))
      .with({ $t: 'sharding.ShardHome' }, (m) => this.onShardHome(m))
      .with({ $t: 'sharding.HandOff' }, (m) => this.onHandOff(m))
      .with({ $t: 'sharding.RememberedEntities' }, (m) => this.onRememberedEntities(m))
      .with({ $t: 'sharding.Envelope' }, (m) => this.onShardEnvelope(m))
      .with({ $t: 'sharding.Reply' }, (m) => this.onShardReply(m))
      // Lifecycle reports coming up from our own shards.
      .with({ $t: 'sharding.EntityStarted' }, (m) => this.onEntityStarted(m))
      .with({ $t: 'sharding.EntityStopped' }, (m) => this.onEntityStopped(m))
      // Coordinator-only messages; regions ignore them.
      .otherwise(() => this.onUnhandled());
  }

  private onUnhandled(): void {
    /* no-op */
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
    this.routeUserMessage(message.message as TMessage, senderRef);
  }

  private onShardReply(message: ShardReply): void {
    const entry = this.pendingAsks.get(message.correlationId);
    if (!entry) return;
    this.pendingAsks.delete(message.correlationId);
    entry.sender.tell(message.message as never);
  }

  private onRegisterAcknowledgment(_message: RegisterAcknowledgment): void {
    this.log.debug(`[sharding] region '${this.config.typeName}' registered with coordinator`);
    this.registered = true;
    this.registerTimer?.cancel();
    this.registerTimer = null;
  }

  private onShardHome(message: ShardHome): void {
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
    this.flushBuffer(message.shardId);
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
    if (!this.entityActivity.has(message.entityId)) {
      // Remembered entities are pre-created without ever being routed to.
      this.entityActivity.set(message.entityId, { shardId: message.shardId, lastActivity: Date.now() });
    }
    if (this.config.rememberEntities) this.tellCoordinator(message);
  }

  private onEntityStopped(message: EntityStopped): void {
    this.shardEntities.get(message.shardId)?.delete(message.entityId);
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
  private onHandOff(message: HandOff): void {
    const shardId = message.shardId;
    const entityIds = Array.from(this.shardEntities.get(shardId) ?? []);
    this.log.debug(
      `[sharding] handing off shard ${shardId} of '${this.config.typeName}' (stopping ${entityIds.length} entit(ies))`,
    );
    this.shardState.set(shardId, 'handing-off');
    const ack: BeginHandOffAcknowledgment = { $t: 'sharding.BeginHandOffAcknowledgment', shardId };
    this.tellCoordinator(ack);

    if (this.config.rememberEntities) {
      for (const entityId of entityIds) {
        this.tellCoordinator({ $t: 'sharding.EntityStopped', shardId, entityId });
      }
    }
    this.forgetShardEntities(shardId);

    const shard = this.shards.get(shardId);
    if (!shard) { this.completeHandOff(shardId); return; }
    this.handingOff.add(shardId);
    shard.stop();
  }

  private completeHandOff(shardId: number): void {
    this.handingOff.delete(shardId);
    this.shards.delete(shardId);
    this.localShards.delete(shardId);
    this.shardHomes.delete(shardId);
    this.shardHomeNodes.delete(shardId);
    this.shardState.delete(shardId);

    const complete: HandOffComplete = {
      $t: 'sharding.HandOffComplete',
      shardId,
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
    };
    this.tellCoordinator(complete);
  }

  /** Drop every entity bookkeeping entry belonging to `shardId`. */
  private forgetShardEntities(shardId: number): void {
    for (const entityId of this.shardEntities.get(shardId) ?? []) {
      this.entityActivity.delete(entityId);
      this.passivating.delete(entityId);
    }
    this.shardEntities.delete(shardId);
  }

  private onRememberedEntities(message: RememberedEntities): void {
    // Pre-create entities we've been told about but haven't materialised yet.
    if (!this.localShards.has(message.shardId)) return;
    if (this.config.proxy) return;
    const startEntities: ShardMessage = {
      $t: 'sharding.StartEntities',
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
   * the entities are really gone.  Otherwise the shard died past its
   * supervisor's budget; drop it so the next message respawns it, and keep
   * the ownership so buffered work is not thrown away.
   */
  private handleShardTerminated(t: Terminated): void {
    for (const [shardId, ref] of this.shards) {
      if (!ref.equals(t.actor)) continue;
      if (this.handingOff.has(shardId)) { this.completeHandOff(shardId); return; }
      this.log.warn(
        `[sharding] shard ${shardId} of '${this.config.typeName}' stopped unexpectedly; `
        + `it will be recreated on the next message`,
      );
      this.shards.delete(shardId);
      this.forgetShardEntities(shardId);
      return;
    }
  }

  private passivationSweep(): void {
    if (this.config.passivationIdleMs <= 0) return;
    const now = Date.now();
    for (const [entityId, activity] of this.entityActivity) {
      if (this.passivating.has(entityId)) continue;
      if (now - activity.lastActivity < this.config.passivationIdleMs) continue;
      this.requestPassivation(entityId, activity.shardId);
    }
  }

  /* -------------------------------- Buffer ----------------------------- */

  private bufferShard(shardId: number, message: TMessage, sender: ActorRef | null): void {
    let queue = this.buffer.get(shardId);
    if (!queue) { queue = []; this.buffer.set(shardId, queue); }
    queue.push({ message, sender });
  }

  private flushBuffer(shardId: number): void {
    const queue = this.buffer.get(shardId);
    if (!queue || queue.length === 0) return;
    this.buffer.delete(shardId);
    for (const { message, sender } of queue) this.routeUserMessage(message, sender);
  }

  /* -------------------------------- Misc ------------------------------ */

  private onLeaderChanged(): void {
    this.registered = false;
    this.coordinatorRef = null;
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
  return `actor-ts://${systemName}/user/sharding-coordinator-${typeName}`;
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
      $t: 'sharding.Reply',
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
