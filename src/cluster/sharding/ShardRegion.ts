import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import { ActorRef } from '../../ActorRef.js';
import { ActorPath } from '../../ActorPath.js';
import type { Props } from '../../Props.js';
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

export interface ShardRegionConfig<TMessage> {
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
}

interface EntityState {
  ref: ActorRef<unknown>;
  lastActivity: number;
  /** Non-null while the entity is passivating: buffered messages to flush on the next create. */
  passivating: unknown[] | null;
}

type ShardState = 'owned' | 'handing-off';

/**
 * ShardRegion is the node-local router for a sharded type.  It talks to
 * the ShardCoordinator to discover the home of each shard, hosts entities
 * whose shards live locally, and forwards everything else to the remote
 * region that owns the target shard.  Messages whose shard home is unknown
 * or in handoff are buffered until the coordinator answers.
 */
export class ShardRegion<TMessage = unknown> extends Actor<TMessage | ShardingMessage | Terminated | Passivate> {
  private readonly shardHomes = new Map<number, string>(); // shardId → region path
  private readonly shardHomeNodes = new Map<number, NodeAddress>();
  private readonly localShards = new Set<number>();
  private readonly shardState = new Map<number, ShardState>();
  private readonly entities = new Map<string, EntityState>(); // entityId → state
  private readonly entityShard = new Map<string, number>(); // entityId → shardId
  private readonly shardEntities = new Map<number, Set<string>>(); // shardId → entityIds
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
      this.handleEntityTerminated(message);
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
    let state = this.entities.get(entityId);
    if (!state || state.passivating) {
      if (state?.passivating) {
        state.passivating.push(message);
        return;
      }
      this.evictLruIfAtCapacity();
      state = this.createEntity(shardId, entityId);
    }
    state.lastActivity = Date.now();
    // Forward the original sender so that ask-pattern replies bypass the
    // region and reach the caller directly.
    state.ref.tell(message as never, sender);
  }

  /**
   * If `maxEntities` is set and the region is at capacity, passivate
   * the entity with the oldest `lastActivity` to make room for a new
   * one (#82).  Already-passivating entities don't count toward
   * capacity (they'll be removed once Terminated arrives), and the
   * eviction itself uses the same `passivating: []` + `ref.stop()`
   * dance as `passivationSweep` so the journal-aware shutdown path is
   * identical for idle-timeout and capacity-driven evictions.
   *
   * The cap is a steady-state upper bound: between stopping the LRU
   * and the Terminated message landing, the region briefly holds
   * `maxEntities + 1` entities.  Acceptable trade-off vs blocking the
   * incoming message until passivation actually completes.
   */
  private evictLruIfAtCapacity(): void {
    if (this.config.maxEntities <= 0) return;
    let liveCount = 0;
    let oldestId: string | null = null;
    let oldestActivity = Number.POSITIVE_INFINITY;
    for (const [id, s] of this.entities) {
      if (s.passivating) continue;
      liveCount++;
      if (s.lastActivity < oldestActivity) {
        oldestActivity = s.lastActivity;
        oldestId = id;
      }
    }
    if (liveCount < this.config.maxEntities) return;
    if (oldestId === null) return;
    const victim = this.entities.get(oldestId)!;
    this.log.debug(
      `[sharding] LRU passivation: evicting '${oldestId}' (idle for ${Date.now() - oldestActivity}ms, `
      + `cap ${this.config.maxEntities} reached)`,
    );
    victim.passivating = [];
    victim.ref.stop();
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

  private createEntity(shardId: number, entityId: string): EntityState {
    this.log.debug(`[sharding] spawning entity '${entityId}' in shard ${shardId} of '${this.config.typeName}'`);
    const ref = this.context.spawn(this.config.entityProps, `entity-${sanitizeName(entityId)}`);
    this.context.watch(ref);
    const state: EntityState = { ref: ref as ActorRef<unknown>, lastActivity: Date.now(), passivating: null };
    this.entities.set(entityId, state);
    this.entityShard.set(entityId, shardId);
    let set = this.shardEntities.get(shardId);
    if (!set) { set = new Set(); this.shardEntities.set(shardId, set); }
    set.add(entityId);
    if (this.config.rememberEntities) {
      this.tellCoordinator({ $t: 'sharding.EntityStarted', shardId, entityId });
    }
    return state;
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
    } else {
      this.localShards.delete(message.shardId);
      this.shardState.delete(message.shardId);
    }
    this.flushBuffer(message.shardId);
  }

  private onHandOff(message: HandOff): void {
    this.log.debug(
      `[sharding] handing off shard ${message.shardId} of '${this.config.typeName}' (stopping ${this.shardEntities.get(message.shardId)?.size ?? 0} entit(ies))`,
    );
    this.shardState.set(message.shardId, 'handing-off');
    const ack: BeginHandOffAcknowledgment = { $t: 'sharding.BeginHandOffAcknowledgment', shardId: message.shardId };
    this.tellCoordinator(ack);

    const entityIds = Array.from(this.shardEntities.get(message.shardId) ?? []);
    for (const entityId of entityIds) {
      const entity = this.entities.get(entityId);
      if (!entity) continue;
      entity.ref.stop();
      this.entities.delete(entityId);
      this.entityShard.delete(entityId);
      if (this.config.rememberEntities) {
        this.tellCoordinator({ $t: 'sharding.EntityStopped', shardId: message.shardId, entityId });
      }
    }
    this.shardEntities.delete(message.shardId);
    this.localShards.delete(message.shardId);
    this.shardHomes.delete(message.shardId);
    this.shardHomeNodes.delete(message.shardId);
    this.shardState.delete(message.shardId);

    const complete: HandOffComplete = {
      $t: 'sharding.HandOffComplete',
      shardId: message.shardId,
      region: this.self.path.toString(),
      node: this.config.cluster.selfAddress.toJSON(),
    };
    this.tellCoordinator(complete);
  }

  private onRememberedEntities(message: RememberedEntities): void {
    // Pre-create entities we've been told about but haven't materialised yet.
    if (!this.localShards.has(message.shardId)) return;
    for (const entityId of message.entityIds) {
      if (this.entities.has(entityId)) continue;
      this.createEntity(message.shardId, entityId);
    }
  }

  /* ----------------------------- Passivation --------------------------- */

  private handlePassivate(message: Passivate): void {
    const candidate = message.entity ?? this.sender.toNullable();
    if (!candidate) return;
    let foundId: string | null = null;
    for (const [id, s] of this.entities) {
      if (s.ref.equals(candidate)) { foundId = id; break; }
    }
    if (!foundId) return;
    const state = this.entities.get(foundId)!;
    state.passivating = [];
    candidate.tell(message.stopMessage as never);
    // The entity will terminate; we clean up in handleEntityTerminated.
  }

  private handleEntityTerminated(t: Terminated): void {
    for (const [id, s] of this.entities) {
      if (s.ref.equals(t.actor)) {
        const buffered = s.passivating ?? [];
        const shardId = this.entityShard.get(id) ?? -1;
        this.entities.delete(id);
        this.entityShard.delete(id);
        this.shardEntities.get(shardId)?.delete(id);
        if (this.config.rememberEntities) {
          this.tellCoordinator({ $t: 'sharding.EntityStopped', shardId, entityId: id });
        }
        // Flush buffered messages by replaying through the normal route.
        for (const message of buffered) this.routeUserMessage(message as TMessage, null);
        return;
      }
    }
  }

  private passivationSweep(): void {
    if (this.config.passivationIdleMs <= 0) return;
    const now = Date.now();
    for (const [id, s] of this.entities) {
      if (s.passivating) continue;
      if (now - s.lastActivity < this.config.passivationIdleMs) continue;
      s.passivating = [];
      s.ref.stop();
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

function sanitizeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_\-]/g, '_');
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
