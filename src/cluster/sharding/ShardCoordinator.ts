import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Lease } from '../../coordination/Lease.js';
import type { Cancellable } from '../../Scheduler.js';
import type { Cluster } from '../Cluster.js';
import { LeaderChanged, MemberRemoved } from '../ClusterEvents.js';
import { NodeAddress, type NodeAddressData } from '../NodeAddress.js';
import { RemoteActorRef } from '../RemoteActorRef.js';
import { type AllocationStrategy, HashAllocationStrategy } from './AllocationStrategy.js';
import type {
  BeginHandOffAck,
  EntityStarted,
  EntityStopped,
  GetShardHome,
  HandOffComplete,
  RegionTerminated,
  RegisterAck,
  RegisterRegion,
  ShardingMessage,
} from './ShardingProtocol.js';

/* ----------------------- internal mailbox events ----------------------- */
/**
 * The lease-aware path uses internal events instead of inline awaits so
 * cluster-event triggers can't interleave their `reconcile` calls with
 * an in-flight `lease.acquire()`.  Mirrors the same pattern used in
 * `ClusterSingletonManager` (#38).
 */
type CoordinatorEvent =
  | { t: 'reconcile' }
  | { t: 'lease-acquire-result'; got: boolean; error?: Error }
  | { t: 'lease-lost'; reason: string }
  | { t: 'acquire-retry' };

type CoordinatorInbox = ShardingMessage | CoordinatorEvent;

function isCoordinatorEvent(msg: CoordinatorInbox): msg is CoordinatorEvent {
  if (!msg || typeof msg !== 'object') return false;
  const t = (msg as { t?: unknown; $t?: unknown }).t;
  return t === 'reconcile' || t === 'lease-acquire-result'
    || t === 'lease-lost' || t === 'acquire-retry';
}

interface RegionInfo {
  readonly node: NodeAddress;
  readonly path: string;
  readonly proxy: boolean;
  readonly shards: Set<number>;
}

function regionKey(node: NodeAddress, path: string): string {
  return `${node}|${path}`;
}

export interface ShardCoordinatorSettings {
  readonly typeName: string;
  readonly cluster: Cluster;
  readonly allocationStrategy: AllocationStrategy;
  readonly role?: string;
  readonly rebalanceIntervalMs?: number;
  readonly handOffTimeoutMs?: number;
  readonly rememberEntities?: boolean;
  /** Resolver for local actor paths — used when coordinator lives on the same node as a region. */
  readonly localResolver: (path: string) => ActorRef | null;
  /**
   * Optional split-brain protection.  When set, the elected leader's
   * coordinator must hold the lease before it processes shard
   * messages.  Under a network partition where two nodes converge to
   * "I am the leader" gossip views, only the side that successfully
   * acquires the lease ever issues `AllocateShard` / `HandOff`
   * directives — the other side stays passive and drops messages
   * (regions retry naturally on their next cache miss).
   *
   * Without a lease the coordinator gates only on `isLeader()` —
   * v1 behaviour, no extra coordination.
   */
  readonly lease?: Lease;
  /** Retry interval for `lease.acquire()` after a failed attempt.  Default: 5 s. */
  readonly acquireRetryIntervalMs?: number;
}

/**
 * Cluster-wide authoritative source of shard-to-region assignments.  Runs on
 * every node but only responds to requests when the local node is the
 * cluster leader.  Non-leader coordinators ignore incoming messages so that
 * duplicate coordinators during a leader transition are harmless.
 *
 * State is reconstructed from Register messages: each region reports the
 * shards it currently hosts, and the coordinator merges that with any new
 * allocation requests.  This is deliberately lightweight — a production
 * upgrade would snapshot state to a journal so the coordinator can recover
 * across restarts without re-allocating every shard from scratch.
 */
export class ShardCoordinator extends Actor<CoordinatorInbox> {
  private readonly regions = new Map<string, RegionInfo>();
  private readonly shardHome = new Map<number, string>(); // shardId → regionPath
  private readonly pending = new Map<number, Array<GetShardHome>>(); // waiting queries
  private readonly rebalanceInProgress = new Map<number, { from: string; timer: Cancellable }>();
  private readonly entitiesPerShard = new Map<number, Set<string>>();

  private rebalanceTimer: Cancellable | null = null;
  private unsubscribeCluster: (() => void) | null = null;
  private unsubscribeLeaseLost: (() => void) | null = null;
  private acquireRetryTimer: Cancellable | null = null;

  /**
   * Lease lifecycle (only used when `settings.lease` is set).
   * Drives the `isActive()` predicate — coordinator only processes
   * shard messages while `isLeader() && leaseState === 'held'`.
   */
  private leaseState: 'none' | 'acquiring' | 'held' = 'none';

  /**
   * Sharding messages received while we're the leader but waiting
   * for the lease.  Drained on the `acquiring → held` transition so
   * regions that asked early get an answer instead of having to
   * wait for the next cluster event to retrigger their ask.
   *
   * Non-leader messages are NOT buffered — they're dropped because
   * the regions on this node will retry against whichever node is
   * the actual leader on their next attempt.
   *
   * Capped to avoid unbounded growth if the lease never resolves.
   */
  private acquireBuffer: ShardingMessage[] = [];
  private static readonly ACQUIRE_BUFFER_CAP = 1_000;

  constructor(public readonly settings: ShardCoordinatorSettings) { super(); }

  /** Path used by ClusterSharding to locate the coordinator on any node. */
  static pathFor(typeName: string): string {
    return `actor-ts://SYSTEM/user/sharding-coordinator-${typeName}`;
  }

  override preStart(): void {
    this.unsubscribeCluster = this.settings.cluster.subscribe(evt =>
      match(evt)
        .with(P.instanceOf(MemberRemoved), (e) => this.onMemberRemoved(e.member.address))
        .with(P.instanceOf(LeaderChanged), () => this.onLeaderChanged())
        .otherwise(() => { /* other events are not observed here */ }),
    );
    if (this.settings.lease) {
      this.unsubscribeLeaseLost = this.settings.lease.onLost((reason) => {
        this.self.tell({ t: 'lease-lost', reason } satisfies CoordinatorEvent);
      });
      // Kick the initial reconcile through the mailbox so the lease
      // path serialises with subsequent cluster events.
      this.self.tell({ t: 'reconcile' } satisfies CoordinatorEvent);
    }
    this.rebalanceTimer = this.system.scheduler.scheduleAtFixedRateFn(
      this.settings.rebalanceIntervalMs ?? 2_000,
      this.settings.rebalanceIntervalMs ?? 2_000,
      () => { if (this.isActive()) this.rebalanceTick(); },
    );
  }

  override async postStop(): Promise<void> {
    this.unsubscribeCluster?.();
    this.unsubscribeLeaseLost?.();
    this.rebalanceTimer?.cancel();
    this.acquireRetryTimer?.cancel();
    for (const r of this.rebalanceInProgress.values()) r.timer.cancel();
    if (this.settings.lease && this.leaseState === 'held') {
      try { await this.settings.lease.release(); } catch { /* best-effort */ }
      this.leaseState = 'none';
    }
  }

  override onReceive(msg: CoordinatorInbox): void {
    // Internal coordinator events drive the lease state machine — they
    // run regardless of `isActive()` because they're how we transition
    // INTO `isActive()` in the first place.
    if (isCoordinatorEvent(msg)) {
      this.handleCoordinatorEvent(msg);
      return;
    }
    if (!this.isLeader()) return;
    if (this.settings.lease && this.leaseState !== 'held') {
      // Leader, but lease not yet held — buffer instead of drop so
      // regions don't need to retry on the next cluster event.
      if (this.acquireBuffer.length < ShardCoordinator.ACQUIRE_BUFFER_CAP) {
        this.acquireBuffer.push(msg);
      }
      return;
    }
    this.dispatchShardingMessage(msg);
  }

  private dispatchShardingMessage(msg: ShardingMessage): void {
    match(msg)
      .with({ $t: 'sharding.Register' }, (m) => this.handleRegister(m))
      .with({ $t: 'sharding.GetShardHome' }, (m) => this.handleGetShardHome(m))
      .with({ $t: 'sharding.HandOffComplete' }, (m) => this.handleHandOffComplete(m))
      .with({ $t: 'sharding.BeginHandOffAck' }, () => { /* informational only */ })
      .with({ $t: 'sharding.RegionTerminated' }, (m) => this.onRegionTerminated(m))
      .with({ $t: 'sharding.EntityStarted' }, (m) => this.handleEntityStarted(m))
      .with({ $t: 'sharding.EntityStopped' }, (m) => this.handleEntityStopped(m))
      .otherwise(() => { /* other ShardingMessage variants are region-side */ });
  }

  private isLeader(): boolean { return this.settings.cluster.isLeader(); }

  /**
   * True iff this coordinator is the authoritative one — i.e. should
   * be processing shard messages.  Without a lease this is just
   * `isLeader()`; with a lease it additionally requires that the
   * lease be currently held by this replica.
   */
  private isActive(): boolean {
    if (!this.settings.lease) return this.isLeader();
    return this.isLeader() && this.leaseState === 'held';
  }

  /* --------------------------- Lease state machine ------------------------ */

  private handleCoordinatorEvent(evt: CoordinatorEvent): void {
    match(evt)
      .with({ t: 'reconcile' }, () => this.reconcileLease())
      .with({ t: 'lease-acquire-result' }, (m) => this.handleAcquireResult(m))
      .with({ t: 'lease-lost' }, (m) => this.handleLeaseLost(m))
      .with({ t: 'acquire-retry' }, () => this.reconcileLease())
      .exhaustive();
  }

  private reconcileLease(): void {
    if (!this.settings.lease) return;
    const wantActive = this.isLeader();
    if (wantActive) {
      if (this.leaseState === 'held') return;        // already active
      if (this.leaseState === 'acquiring') return;   // already trying
      this.acquireRetryTimer?.cancel();
      this.acquireRetryTimer = null;
      this.leaseState = 'acquiring';
      void this.runAcquire();
    } else {
      if (this.leaseState === 'held') {
        // Stepped down — release so a follower can pick up faster
        // than waiting for the TTL to expire.
        void this.settings.lease.release().catch((e) =>
          this.system.log.warn(`[sharding] lease release failed`, e));
        this.leaseState = 'none';
        // Falling out of `held` already triggers our standard
        // "not-leader" cleanup via onLeaderChanged below — no extra
        // state reset needed here.
      } else if (this.leaseState === 'acquiring') {
        // Let the in-flight acquire finish; handleAcquireResult will
        // notice we no longer want it and release immediately.
      } else {
        this.acquireRetryTimer?.cancel();
        this.acquireRetryTimer = null;
      }
    }
  }

  private async runAcquire(): Promise<void> {
    try {
      const got = await this.settings.lease!.acquire();
      this.self.tell({ t: 'lease-acquire-result', got } satisfies CoordinatorEvent);
    } catch (error) {
      this.self.tell({
        t: 'lease-acquire-result', got: false, error: error as Error,
      } satisfies CoordinatorEvent);
    }
  }

  private handleAcquireResult(msg: { got: boolean; error?: Error }): void {
    if (this.leaseState !== 'acquiring') {
      // Spurious result — release if we somehow got it.
      if (msg.got) void this.settings.lease!.release().catch(() => { /* ignore */ });
      return;
    }
    if (!msg.got) {
      if (msg.error) this.system.log.warn(`[sharding] lease acquire failed`, msg.error);
      this.leaseState = 'none';
      this.scheduleAcquireRetry();
      return;
    }
    if (!this.isLeader()) {
      // Lost leadership during the acquire — release and let the
      // new leader (if any) take over.
      void this.settings.lease!.release().catch(() => { /* ignore */ });
      this.leaseState = 'none';
      return;
    }
    this.leaseState = 'held';
    this.system.log.info(
      `[sharding] coordinator '${this.settings.typeName}' became active (lease acquired)`,
    );
    // Drain any messages that arrived while we were acquiring.
    // Regions don't retry on a timer — they only re-ask on cluster
    // events — so without this drain a region that asked during
    // `acquiring` would sit forever on a buffered user message.
    if (this.acquireBuffer.length > 0) {
      const buffered = this.acquireBuffer;
      this.acquireBuffer = [];
      for (const m of buffered) this.dispatchShardingMessage(m);
    }
  }

  private handleLeaseLost(msg: { reason: string }): void {
    if (this.leaseState !== 'held') return;
    this.system.log.warn(
      `[sharding] coordinator '${this.settings.typeName}' lost lease — ${msg.reason}; stepping down`,
    );
    this.leaseState = 'none';
    // Cancel any in-flight rebalance handoff timers — those would
    // fire force-reallocations that we shouldn't be doing while
    // passive.  Pending queries get dropped (regions retry once we
    // become active again, or once cluster events flush their
    // register loop).
    for (const r of this.rebalanceInProgress.values()) r.timer.cancel();
    this.rebalanceInProgress.clear();
    this.pending.clear();
    this.acquireBuffer = [];
    // Deliberately do NOT clear `regions` or `shardHome` here.  We
    // stay leader and likely re-acquire — keeping the cached view
    // means subsequent re-acquires resume serving without waiting
    // for every region to re-register.  If another node took the
    // lease during our window and reallocated, our stale homes
    // self-correct via the standard "remote send fails →
    // MemberRemoved → invalidateHomesOnNode" flow on the regions.
    // Re-enter the acquire loop in case we're still the leader.
    this.self.tell({ t: 'reconcile' } satisfies CoordinatorEvent);
  }

  private scheduleAcquireRetry(): void {
    const interval = this.settings.acquireRetryIntervalMs ?? 5_000;
    this.acquireRetryTimer?.cancel();
    this.acquireRetryTimer = this.system.scheduler.scheduleOnceFn(interval, () => {
      this.self.tell({ t: 'acquire-retry' } satisfies CoordinatorEvent);
    });
  }

  private candidates(): NodeAddress[] {
    const role = this.settings.role;
    const activeRegions = Array.from(this.regions.values()).filter(r => !r.proxy);
    const addrs = activeRegions.map(r => r.node);
    if (!role) return addrs;
    return addrs.filter(a => {
      const m = this.settings.cluster.getMembers().find(x => x.address.equals(a));
      return m?.hasRole(role) ?? false;
    });
  }

  private currentShardCounts(): Map<string, Set<number>> {
    // Keyed by node address string so AllocationStrategy can match against
    // the NodeAddress it returned in `allocate`.
    const out = new Map<string, Set<number>>();
    for (const info of this.regions.values()) {
      if (info.proxy) continue;
      const addr = info.node.toString();
      const existing = out.get(addr) ?? new Set<number>();
      for (const s of info.shards) existing.add(s);
      out.set(addr, existing);
    }
    return out;
  }

  /* ------------------------------- Handlers -------------------------------- */

  private handleRegister(msg: RegisterRegion): void {
    const node = NodeAddress.fromJSON(msg.node);
    const key = regionKey(node, msg.region);
    this.regions.set(key, {
      node,
      path: msg.region,
      proxy: msg.proxy,
      shards: new Set(msg.hostedShards),
    });
    for (const shardId of msg.hostedShards) {
      this.shardHome.set(shardId, key);
    }
    const ack: RegisterAck = {
      $t: 'sharding.RegisterAck',
      coordinator: this.self.path.toString(),
    };
    this.replyTo(msg.region, msg.node, ack);

    for (const shardId of msg.hostedShards) this.flushPending(shardId);

    if (this.settings.rememberEntities) {
      for (const shardId of msg.hostedShards) this.shipRememberedEntities(shardId);
    }
  }

  private handleGetShardHome(msg: GetShardHome): void {
    const home = this.shardHome.get(msg.shardId);
    if (home && this.regions.has(home)) {
      const info = this.regions.get(home)!;
      this.replyTo(msg.requester, msg.requesterNode, {
        $t: 'sharding.ShardHome',
        shardId: msg.shardId,
        region: info.path,
        node: info.node.toJSON(),
      });
      return;
    }

    const list = this.pending.get(msg.shardId) ?? [];
    list.push(msg);
    this.pending.set(msg.shardId, list);

    if (!this.rebalanceInProgress.has(msg.shardId)) this.tryAllocate(msg.shardId);
  }

  private tryAllocate(shardId: number): void {
    const cs = this.candidates();
    if (cs.length === 0) return;
    const owner = this.settings.allocationStrategy.allocate(
      shardId, cs, this.currentShardCounts(),
    );
    const key = this.findRegionKey(owner);
    if (!key) return;
    this.shardHome.set(shardId, key);
    const info = this.regions.get(key)!;
    info.shards.add(shardId);
    // Proactively notify the new owner — they may not have asked, but need
    // to know they are now responsible for the shard (and, when remembering
    // entities, need that knowledge before RememberedEntities arrives).
    this.sendToRegion(key, {
      $t: 'sharding.ShardHome',
      shardId,
      region: info.path,
      node: info.node.toJSON(),
    });
    this.flushPending(shardId);
    if (this.settings.rememberEntities) this.shipRememberedEntities(shardId);
  }

  private handleHandOffComplete(msg: HandOffComplete): void {
    const shardId = msg.shardId;
    const inProgress = this.rebalanceInProgress.get(shardId);
    if (!inProgress) return;
    inProgress.timer.cancel();
    this.rebalanceInProgress.delete(shardId);

    // Remove ownership from old region.
    const oldPath = inProgress.from;
    const old = this.regions.get(oldPath);
    if (old) old.shards.delete(shardId);
    this.shardHome.delete(shardId);

    // Reallocate (the pending queries will get the new home).
    this.tryAllocate(shardId);
  }

  private handleEntityStarted(msg: EntityStarted): void {
    if (!this.settings.rememberEntities) return;
    const set = this.entitiesPerShard.get(msg.shardId) ?? new Set();
    set.add(msg.entityId);
    this.entitiesPerShard.set(msg.shardId, set);
  }

  private handleEntityStopped(msg: EntityStopped): void {
    const set = this.entitiesPerShard.get(msg.shardId);
    if (set) { set.delete(msg.entityId); if (set.size === 0) this.entitiesPerShard.delete(msg.shardId); }
  }

  private onRegionTerminated(msg: RegionTerminated): void {
    const addr = NodeAddress.fromJSON(msg.node);
    const key = regionKey(addr, msg.region);
    const info = this.regions.get(key);
    if (!info) return;
    this.regions.delete(key);
    for (const shardId of info.shards) {
      this.shardHome.delete(shardId);
      const inProg = this.rebalanceInProgress.get(shardId);
      if (inProg) { inProg.timer.cancel(); this.rebalanceInProgress.delete(shardId); }
      this.tryAllocate(shardId);
    }
  }

  private onMemberRemoved(addr: NodeAddress): void {
    for (const [_key, info] of Array.from(this.regions.entries())) {
      if (info.node.equals(addr)) {
        this.onRegionTerminated({
          $t: 'sharding.RegionTerminated',
          region: info.path,
          node: addr.toJSON(),
        });
      }
    }
  }

  private onLeaderChanged(): void {
    // New leader starts with fresh state; regions will re-register.
    if (!this.isLeader()) {
      this.regions.clear();
      this.shardHome.clear();
      this.pending.clear();
      this.acquireBuffer = [];
      for (const r of this.rebalanceInProgress.values()) r.timer.cancel();
      this.rebalanceInProgress.clear();
    }
    // Lease-aware coordinators re-evaluate the acquire/release cycle
    // any time the leader role flips — see `reconcileLease()`.  We
    // route through the mailbox so the state machine serialises with
    // any in-flight acquire result.
    if (this.settings.lease) {
      this.self.tell({ t: 'reconcile' } satisfies CoordinatorEvent);
    }
  }

  /* ------------------------------- Rebalance ------------------------------- */

  private rebalanceTick(): void {
    const shardsToMove = this.settings.allocationStrategy.rebalance(
      this.currentShardCounts(),
      this.candidates(),
      new Set(this.rebalanceInProgress.keys()),
    );
    for (const shardId of shardsToMove) this.beginHandOff(shardId);
  }

  private beginHandOff(shardId: number): void {
    const ownerKey = this.shardHome.get(shardId);
    if (!ownerKey) return;
    const owner = this.regions.get(ownerKey);
    if (!owner) return;

    const timeout = this.settings.handOffTimeoutMs ?? 10_000;
    const timer = this.system.scheduler.scheduleOnceFn(timeout, () => {
      if (this.rebalanceInProgress.delete(shardId)) {
        this.system.log.warn(`[sharding] handoff timeout for shard ${shardId}; forcing reallocate`);
        this.shardHome.delete(shardId);
        this.tryAllocate(shardId);
      }
    });
    this.rebalanceInProgress.set(shardId, { from: ownerKey, timer });
    this.sendToRegion(ownerKey, { $t: 'sharding.HandOff', shardId });
  }

  /* --------------------------------- Helpers ------------------------------- */

  private findRegionKey(node: NodeAddress): string | null {
    for (const [key, info] of this.regions) {
      if (!info.proxy && info.node.equals(node)) return key;
    }
    return null;
  }

  private flushPending(shardId: number): void {
    const pending = this.pending.get(shardId);
    if (!pending || pending.length === 0) return;
    const home = this.shardHome.get(shardId);
    if (!home) return;
    const info = this.regions.get(home);
    if (!info) return;
    for (const q of pending) {
      this.replyTo(q.requester, q.requesterNode, {
        $t: 'sharding.ShardHome',
        shardId,
        region: info.path,
        node: info.node.toJSON(),
      });
    }
    this.pending.delete(shardId);
  }

  private shipRememberedEntities(shardId: number): void {
    const set = this.entitiesPerShard.get(shardId);
    if (!set || set.size === 0) return;
    const home = this.shardHome.get(shardId);
    if (!home) return;
    this.sendToRegion(home, {
      $t: 'sharding.RememberedEntities',
      shardId,
      entityIds: Array.from(set),
    });
  }

  private sendToRegion(key: string, msg: ShardingMessage): void {
    const info = this.regions.get(key);
    if (!info) return;
    this.replyTo(info.path, info.node.toJSON(), msg);
  }

  private replyTo(path: string, nodeData: NodeAddressData, msg: ShardingMessage): void {
    const node = NodeAddress.fromJSON(nodeData);
    if (node.equals(this.settings.cluster.selfAddress)) {
      const ref = this.settings.localResolver(path) as ActorRef<ShardingMessage> | null;
      if (ref) ref.tell(msg);
      return;
    }
    const remote = new RemoteActorRef<ShardingMessage>(node, path, this.settings.cluster);
    remote.tell(msg);
  }
}
