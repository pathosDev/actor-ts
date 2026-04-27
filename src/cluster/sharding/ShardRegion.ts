import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import { ActorRef } from '../../ActorRef.js';
import { ActorPath } from '../../ActorPath.js';
import type { Props } from '../../Props.js';
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
  type BeginHandOffAck,
  type RememberedEntities,
  type RegisterAck,
  type EntityStarted,
  type EntityStopped,
} from './ShardingProtocol.js';

export interface ShardingSettings<TMsg> {
  readonly typeName: string;
  readonly entityProps: Props<TMsg>;
  readonly extractEntityId: (message: TMsg) => string;
  readonly extractEntityMessage?: (message: TMsg) => unknown;
  readonly numShards?: number;
  /** Members must carry this role to be candidates for hosting shards. */
  readonly role?: string;
  /** Run as a proxy — route messages but never host entities locally. */
  readonly proxy?: boolean;
  /** Track entity lifecycle so entities can be re-created on the new owner. */
  readonly rememberEntities?: boolean;
  /** Notify the region after an entity has been idle this many ms.  */
  readonly passivationIdleMs?: number;
}

export interface ShardRegionConfig<TMsg> {
  readonly typeName: string;
  readonly entityProps: Props<TMsg>;
  readonly extractEntityId: (message: TMsg) => string;
  readonly extractEntityMessage: (message: TMsg) => unknown;
  readonly numShards: number;
  readonly role?: string;
  readonly proxy: boolean;
  readonly rememberEntities: boolean;
  readonly passivationIdleMs: number;
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
export class ShardRegion<TMsg = unknown> extends Actor<TMsg | ShardingMessage | Terminated | Passivate> {
  private readonly shardHomes = new Map<number, string>(); // shardId → region path
  private readonly shardHomeNodes = new Map<number, NodeAddress>();
  private readonly localShards = new Set<number>();
  private readonly shardState = new Map<number, ShardState>();
  private readonly entities = new Map<string, EntityState>(); // entityId → state
  private readonly entityShard = new Map<string, number>(); // entityId → shardId
  private readonly shardEntities = new Map<number, Set<string>>(); // shardId → entityIds
  /** Messages buffered while their shard home is unknown or in transition. */
  private readonly buffer = new Map<number, Array<{ msg: TMsg; sender: ActorRef | null }>>();

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

  constructor(public readonly cfg: ShardRegionConfig<TMsg>) { super(); }

  static settingsToConfig<TMsg>(
    s: ShardingSettings<TMsg>,
    cluster: Cluster,
    localResolver: (path: string) => ActorRef | null,
  ): ShardRegionConfig<TMsg> {
    return {
      typeName: s.typeName,
      entityProps: s.entityProps,
      extractEntityId: s.extractEntityId,
      extractEntityMessage: s.extractEntityMessage ?? ((m: TMsg) => m as unknown),
      numShards: s.numShards ?? 64,
      role: s.role,
      proxy: s.proxy ?? false,
      rememberEntities: s.rememberEntities ?? false,
      passivationIdleMs: s.passivationIdleMs ?? 0,
      cluster,
      localResolver,
    };
  }

  override preStart(): void {
    this.unsubscribe = this.cfg.cluster.subscribe(evt =>
      match(evt)
        .with(P.instanceOf(LeaderChanged), () => this.onLeaderChanged())
        .with(P.instanceOf(MemberRemoved), (e) => {
          this.invalidateHomesOnNode(e.member.address);
          this.ensureRegistered();
        })
        .with(P.instanceOf(MemberUp), () => this.ensureRegistered())
        .otherwise(() => { /* other events irrelevant here */ }),
    );

    this.ensureRegistered();

    if (this.cfg.passivationIdleMs > 0) {
      this.passivationTimer = this.system.scheduler.scheduleAtFixedRateFn(
        this.cfg.passivationIdleMs, this.cfg.passivationIdleMs,
        () => this.passivationSweep(),
      );
    }

    this.asksSweepTimer = this.system.scheduler.scheduleAtFixedRateFn(
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

  override onReceive(message: TMsg | ShardingMessage | Terminated | Passivate): void {
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
    this.routeUserMessage(message as TMsg, this.sender.toNullable());
  }

  /* ----------------------------- Routing -------------------------------- */

  private routeUserMessage(message: TMsg, sender: ActorRef | null): void {
    const entityId = this.cfg.extractEntityId(message);
    const shardId = hashShardId(entityId, this.cfg.numShards);
    const entityMsg = this.cfg.extractEntityMessage(message) as TMsg;

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
      this.deliverLocal(shardId, entityId, entityMsg, sender);
    } else {
      const node = this.shardHomeNodes.get(shardId);
      if (!node) { this.bufferShard(shardId, message, sender); this.askCoordinator(shardId); return; }
      this.deliverRemote(node, ownerPath, message, sender);
    }
  }

  private deliverLocal(shardId: number, entityId: string, message: TMsg, sender: ActorRef | null): void {
    if (this.cfg.proxy) {
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
      state = this.createEntity(shardId, entityId);
    }
    state.lastActivity = Date.now();
    // Forward the original sender so that ask-pattern replies bypass the
    // region and reach the caller directly.
    state.ref.tell(message as never, sender);
  }

  private deliverRemote(node: NodeAddress, path: string, message: TMsg, sender: ActorRef | null): void {
    if (sender === null) {
      // Nothing to reply to — skip the envelope wrapping.
      new RemoteActorRef<TMsg>(node, path, this.cfg.cluster).tell(message);
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
      originNode = this.cfg.cluster.selfAddress;
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
    new RemoteActorRef<ShardingMessage>(node, path, this.cfg.cluster).tell(envelope);
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
    const ref = this.context.actorOf(this.cfg.entityProps, `entity-${sanitizeName(entityId)}`);
    this.context.watch(ref);
    const state: EntityState = { ref: ref as ActorRef<unknown>, lastActivity: Date.now(), passivating: null };
    this.entities.set(entityId, state);
    this.entityShard.set(entityId, shardId);
    let set = this.shardEntities.get(shardId);
    if (!set) { set = new Set(); this.shardEntities.set(shardId, set); }
    set.add(entityId);
    if (this.cfg.rememberEntities) {
      this.tellCoordinator({ $t: 'sharding.EntityStarted', shardId, entityId });
    }
    return state;
  }

  /* ----------------------------- Coordinator ---------------------------- */

  private ensureRegistered(): void {
    const leaderOpt = this.cfg.cluster.leader();
    if (leaderOpt.isNone()) { this.scheduleRegisterRetry(); return; }
    const leader = leaderOpt.value;
    // Always re-target the coordinator on each leader change.
    const coordPath = coordinatorPath(this.cfg.cluster.system.name, this.cfg.typeName);
    if (leader.address.equals(this.cfg.cluster.selfAddress)) {
      const local = this.cfg.localResolver(coordPath) as ActorRef<ShardingMessage> | null;
      if (!local) { this.scheduleRegisterRetry(); return; }
      this.coordinatorRef = local;
    } else {
      this.coordinatorRef = new RemoteActorRef<ShardingMessage>(
        leader.address, coordPath, this.cfg.cluster,
      );
    }
    this.register();
  }

  private scheduleRegisterRetry(): void {
    this.registerTimer?.cancel();
    this.registerTimer = this.system.scheduler.scheduleOnceFn(500, () => this.ensureRegistered());
  }

  private register(): void {
    const msg: RegisterRegion = {
      $t: 'sharding.Register',
      region: this.self.path.toString(),
      node: this.cfg.cluster.selfAddress.toJSON(),
      proxy: this.cfg.proxy,
      hostedShards: Array.from(this.localShards),
    };
    this.tellCoordinator(msg);
    // Re-ask for every pending shard home.
    for (const shardId of this.buffer.keys()) this.askCoordinator(shardId);
  }

  private tellCoordinator(msg: ShardingMessage): void {
    if (!this.coordinatorRef) { this.ensureRegistered(); return; }
    this.coordinatorRef.tell(msg);
  }

  private askCoordinator(shardId: number): void {
    const q: GetShardHome = {
      $t: 'sharding.GetShardHome',
      shardId,
      requester: this.self.path.toString(),
      requesterNode: this.cfg.cluster.selfAddress.toJSON(),
    };
    this.tellCoordinator(q);
  }

  /* ---------------------------- Sharding msgs -------------------------- */

  private handleShardingMessage(msg: ShardingMessage): void {
    match(msg)
      .with({ $t: 'sharding.RegisterAck' }, (m) => this.onRegisterAck(m))
      .with({ $t: 'sharding.ShardHome' }, (m) => this.onShardHome(m))
      .with({ $t: 'sharding.HandOff' }, (m) => this.onHandOff(m))
      .with({ $t: 'sharding.RememberedEntities' }, (m) => this.onRememberedEntities(m))
      .with({ $t: 'sharding.Envelope' }, (m) => this.onShardEnvelope(m))
      .with({ $t: 'sharding.Reply' }, (m) => this.onShardReply(m))
      // Coordinator-only messages; regions ignore them.
      .otherwise(() => { /* no-op */ });
  }

  private onShardEnvelope(msg: ShardEnvelope): void {
    const senderRef =
      msg.correlationId !== null && msg.originRegion !== null && msg.originNode !== null
        ? new ShardSenderRef(
            NodeAddress.fromJSON(msg.originNode),
            msg.originRegion,
            msg.correlationId,
            this.cfg.cluster,
            (path) => this.cfg.localResolver(path),
          )
        : null;
    this.routeUserMessage(msg.message as TMsg, senderRef);
  }

  private onShardReply(msg: ShardReply): void {
    const entry = this.pendingAsks.get(msg.correlationId);
    if (!entry) return;
    this.pendingAsks.delete(msg.correlationId);
    entry.sender.tell(msg.message as never);
  }

  private onRegisterAck(_msg: RegisterAck): void {
    this.registered = true;
    this.registerTimer?.cancel();
    this.registerTimer = null;
  }

  private onShardHome(msg: ShardHome): void {
    const node = NodeAddress.fromJSON(msg.node);
    this.shardHomes.set(msg.shardId, msg.region);
    this.shardHomeNodes.set(msg.shardId, node);
    if (node.equals(this.cfg.cluster.selfAddress) && msg.region === this.self.path.toString()) {
      this.localShards.add(msg.shardId);
      this.shardState.set(msg.shardId, 'owned');
    } else {
      this.localShards.delete(msg.shardId);
      this.shardState.delete(msg.shardId);
    }
    this.flushBuffer(msg.shardId);
  }

  private onHandOff(msg: HandOff): void {
    this.shardState.set(msg.shardId, 'handing-off');
    const ack: BeginHandOffAck = { $t: 'sharding.BeginHandOffAck', shardId: msg.shardId };
    this.tellCoordinator(ack);

    const entityIds = Array.from(this.shardEntities.get(msg.shardId) ?? []);
    for (const entityId of entityIds) {
      const e = this.entities.get(entityId);
      if (!e) continue;
      e.ref.stop();
      this.entities.delete(entityId);
      this.entityShard.delete(entityId);
      if (this.cfg.rememberEntities) {
        this.tellCoordinator({ $t: 'sharding.EntityStopped', shardId: msg.shardId, entityId });
      }
    }
    this.shardEntities.delete(msg.shardId);
    this.localShards.delete(msg.shardId);
    this.shardHomes.delete(msg.shardId);
    this.shardHomeNodes.delete(msg.shardId);
    this.shardState.delete(msg.shardId);

    const complete: HandOffComplete = {
      $t: 'sharding.HandOffComplete',
      shardId: msg.shardId,
      region: this.self.path.toString(),
      node: this.cfg.cluster.selfAddress.toJSON(),
    };
    this.tellCoordinator(complete);
  }

  private onRememberedEntities(msg: RememberedEntities): void {
    // Pre-create entities we've been told about but haven't materialised yet.
    if (!this.localShards.has(msg.shardId)) return;
    for (const entityId of msg.entityIds) {
      if (this.entities.has(entityId)) continue;
      this.createEntity(msg.shardId, entityId);
    }
  }

  /* ----------------------------- Passivation --------------------------- */

  private handlePassivate(msg: Passivate): void {
    const candidate = msg.entity ?? this.sender.toNullable();
    if (!candidate) return;
    let foundId: string | null = null;
    for (const [id, s] of this.entities) {
      if (s.ref.equals(candidate)) { foundId = id; break; }
    }
    if (!foundId) return;
    const state = this.entities.get(foundId)!;
    state.passivating = [];
    candidate.tell(msg.stopMessage as never);
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
        if (this.cfg.rememberEntities) {
          this.tellCoordinator({ $t: 'sharding.EntityStopped', shardId, entityId: id });
        }
        // Flush buffered messages by replaying through the normal route.
        for (const m of buffered) this.routeUserMessage(m as TMsg, null);
        return;
      }
    }
  }

  private passivationSweep(): void {
    if (this.cfg.passivationIdleMs <= 0) return;
    const now = Date.now();
    for (const [id, s] of this.entities) {
      if (s.passivating) continue;
      if (now - s.lastActivity < this.cfg.passivationIdleMs) continue;
      s.passivating = [];
      s.ref.stop();
    }
  }

  /* -------------------------------- Buffer ----------------------------- */

  private bufferShard(shardId: number, msg: TMsg, sender: ActorRef | null): void {
    let q = this.buffer.get(shardId);
    if (!q) { q = []; this.buffer.set(shardId, q); }
    q.push({ msg, sender });
  }

  private flushBuffer(shardId: number): void {
    const q = this.buffer.get(shardId);
    if (!q || q.length === 0) return;
    this.buffer.delete(shardId);
    for (const { msg, sender } of q) this.routeUserMessage(msg, sender);
  }

  /* -------------------------------- Misc ------------------------------ */

  private onLeaderChanged(): void {
    this.registered = false;
    this.coordinatorRef = null;
    this.ensureRegistered();
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
