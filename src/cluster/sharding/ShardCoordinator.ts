import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Cancellable } from '../../Scheduler.js';
import type { ShardCoordinatorOptions, ShardCoordinatorOptionsType } from './ShardCoordinatorOptions.js';
import { LeaderChanged, MemberRemoved } from '../ClusterEvents.js';
import { NodeAddress, type NodeAddressData } from '../NodeAddress.js';
import { RemoteActorRef } from '../RemoteActorRef.js';
import { HashAllocationStrategy } from './AllocationStrategy.js';
import type {
  CoordinatorStateData,
  RegionInfoData,
} from './CoordinatorState.js';
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
   * Lease lifecycle (only used when `options.lease` is set).
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

  /**
   * Promise chain over remembered-entity persistence.  Each new
   * `EntityStarted` / `EntityStopped` chains its append onto the tail
   * of this promise so writes serialise — `Journal.append`'s
   * optimistic `expectedSeq` would otherwise race when two events
   * fire in fast succession.  `.catch` on each link prevents a
   * failed write from breaking the chain for subsequent writes.
   */
  private rememberWriteChain: Promise<void> = Promise.resolve();

  /**
   * Coalesced save state for `coordinatorStateStore`.  State
   * mutations are bursty during rebalance; rather than fire one
   * disk write per mutation we mark the state dirty and the
   * in-flight save's `.finally` kicks off a follow-up if more
   * changes accumulated meanwhile.  Same pattern as
   * `DistributedData.scheduleDurableSave` from #40.
   */
  private coordinatorStateInFlight = false;
  private coordinatorStateDirty = false;

  public readonly options: ShardCoordinatorOptionsType;

  constructor(options: ShardCoordinatorOptions) {
    super();
    this.options = options as ShardCoordinatorOptionsType;
  }

  /** Path used by ClusterSharding to locate the coordinator on any node. */
  static pathFor(typeName: string): string {
    return `actor-ts://SYSTEM/user/sharding-coordinator-${typeName}`;
  }

  override async preStart(): Promise<void> {
    // 1. Replay the persisted remembered-entities log so the
    //    in-memory map is populated BEFORE we accept any messages.
    //    Without this, a fresh-cluster start would treat every
    //    rememberEntities=true sharded type as empty and only
    //    re-register entities lazily as messages arrive.
    if (this.options.rememberEntities && this.options.rememberEntitiesStore) {
      try {
        const events = await this.options.rememberEntitiesStore
          .load(this.options.typeName);
        for (const ev of events) this.applyRememberEvent(ev);
      } catch (err) {
        this.system.log.warn(
          `[sharding] failed to load remembered entities for '${this.options.typeName}'`,
          err,
        );
      }
    }

    this.unsubscribeCluster = this.options.cluster.subscribe(evt =>
      match(evt)
        .with(P.instanceOf(MemberRemoved), (e) => this.onMemberRemoved(e.member.address))
        .with(P.instanceOf(LeaderChanged), () => this.onLeaderChanged())
        .otherwise(() => { /* other events are not observed here */ }),
    );
    if (this.options.lease) {
      this.unsubscribeLeaseLost = this.options.lease.onLost((reason) => {
        this.self.tell({ t: 'lease-lost', reason } satisfies CoordinatorEvent);
      });
      // Kick the initial reconcile through the mailbox so the lease
      // path serialises with subsequent cluster events.
      this.self.tell({ t: 'reconcile' } satisfies CoordinatorEvent);
    }
    this.rebalanceTimer = this.system.scheduler.scheduleAtFixedRateFn(
      this.options.rebalanceIntervalMs ?? 2_000,
      this.options.rebalanceIntervalMs ?? 2_000,
      () => { if (this.isActive()) this.rebalanceTick(); },
    );
  }

  /** Apply a single `RememberEvent` to the in-memory `entitiesPerShard`
   *  map.  Used by both the preStart replay AND
   *  `handleEntityStarted` / `handleEntityStopped` so the in-memory
   *  derivation rule lives in exactly one place. */
  private applyRememberEvent(
    ev: { kind: 'started' | 'stopped'; shardId: number; entityId: string },
  ): void {
    if (ev.kind === 'started') {
      const set = this.entitiesPerShard.get(ev.shardId) ?? new Set();
      set.add(ev.entityId);
      this.entitiesPerShard.set(ev.shardId, set);
    } else {
      const set = this.entitiesPerShard.get(ev.shardId);
      if (!set) return;
      set.delete(ev.entityId);
      if (set.size === 0) this.entitiesPerShard.delete(ev.shardId);
    }
  }

  override async postStop(): Promise<void> {
    this.unsubscribeCluster?.();
    this.unsubscribeLeaseLost?.();
    this.rebalanceTimer?.cancel();
    this.acquireRetryTimer?.cancel();
    for (const r of this.rebalanceInProgress.values()) r.timer.cancel();
    if (this.options.lease && this.leaseState === 'held') {
      try { await this.options.lease.release(); } catch { /* best-effort */ }
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
    if (this.options.lease && this.leaseState !== 'held') {
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

  private isLeader(): boolean { return this.options.cluster.isLeader(); }

  /**
   * True iff this coordinator is the authoritative one — i.e. should
   * be processing shard messages.  Without a lease this is just
   * `isLeader()`; with a lease it additionally requires that the
   * lease be currently held by this replica.
   */
  private isActive(): boolean {
    if (!this.options.lease) return this.isLeader();
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
    if (!this.options.lease) return;
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
        void this.options.lease.release().catch((e) =>
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
      const got = await this.options.lease!.acquire();
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
      if (msg.got) void this.options.lease!.release().catch(() => { /* ignore */ });
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
      void this.options.lease!.release().catch(() => { /* ignore */ });
      this.leaseState = 'none';
      return;
    }
    this.leaseState = 'held';
    this.system.log.info(
      `[sharding] coordinator '${this.options.typeName}' became active (lease acquired)`,
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
      `[sharding] coordinator '${this.options.typeName}' lost lease — ${msg.reason}; stepping down`,
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
    const interval = this.options.acquireRetryIntervalMs ?? 5_000;
    this.acquireRetryTimer?.cancel();
    this.acquireRetryTimer = this.system.scheduler.scheduleOnceFn(interval, () => {
      this.self.tell({ t: 'acquire-retry' } satisfies CoordinatorEvent);
    });
  }

  private candidates(): NodeAddress[] {
    const role = this.options.role;
    const activeRegions = Array.from(this.regions.values()).filter(r => !r.proxy);
    const addrs = activeRegions.map(r => r.node);
    if (!role) return addrs;
    return addrs.filter(a => {
      const m = this.options.cluster.getMembers().find(x => x.address.equals(a));
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

    if (this.options.rememberEntities) {
      for (const shardId of msg.hostedShards) this.shipRememberedEntities(shardId);
    }
    this.scheduleCoordinatorStateSave();
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
    const owner = this.options.allocationStrategy.allocate(
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
    if (this.options.rememberEntities) this.shipRememberedEntities(shardId);
    this.scheduleCoordinatorStateSave();
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
    // tryAllocate already calls scheduleCoordinatorStateSave, so a
    // second save here would be redundant.
    this.tryAllocate(shardId);
  }

  private handleEntityStarted(msg: EntityStarted): void {
    if (!this.options.rememberEntities) return;
    this.applyRememberEvent({ kind: 'started', shardId: msg.shardId, entityId: msg.entityId });
    this.persistRememberEvent({ kind: 'started', shardId: msg.shardId, entityId: msg.entityId });
  }

  private handleEntityStopped(msg: EntityStopped): void {
    if (!this.options.rememberEntities) {
      // Existing behaviour: tidy the in-memory map even when we're
      // not remembering entities, so an unwise external trigger
      // doesn't leave stale data in the map.
      const set = this.entitiesPerShard.get(msg.shardId);
      if (set) { set.delete(msg.entityId); if (set.size === 0) this.entitiesPerShard.delete(msg.shardId); }
      return;
    }
    this.applyRememberEvent({ kind: 'stopped', shardId: msg.shardId, entityId: msg.entityId });
    this.persistRememberEvent({ kind: 'stopped', shardId: msg.shardId, entityId: msg.entityId });
  }

  /**
   * Append a remembered-entity event to the persistent store.  Chains
   * onto `rememberWriteChain` so two events fired in fast succession
   * don't race the journal's optimistic-`expectedSeq` check — each
   * append awaits the previous one.  Errors are caught + logged so a
   * transient store failure doesn't break the chain for subsequent
   * writes.
   */
  private persistRememberEvent(
    event: { kind: 'started' | 'stopped'; shardId: number; entityId: string },
  ): void {
    const store = this.options.rememberEntitiesStore;
    if (!store) return;
    this.rememberWriteChain = this.rememberWriteChain
      .catch(() => { /* prior failure already logged */ })
      .then(() => store.append(this.options.typeName, event))
      .catch((err) => {
        this.system.log.warn(
          `[sharding] failed to persist remembered-entity event ${event.kind}/${event.shardId}/${event.entityId}`,
          err,
        );
      });
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
    // tryAllocate already schedules saves for each re-allocation;
    // an extra one here would be redundant.  But if `info.shards`
    // was empty (region had no shards) we still removed it from the
    // regions map and need to record that.
    if (info.shards.size === 0) this.scheduleCoordinatorStateSave();
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
    if (!this.isLeader()) {
      // No longer leader — drop the in-memory view; the new leader
      // owns the canonical state now.
      this.regions.clear();
      this.shardHome.clear();
      this.pending.clear();
      this.acquireBuffer = [];
      for (const r of this.rebalanceInProgress.values()) r.timer.cancel();
      this.rebalanceInProgress.clear();
    } else {
      // Just became leader (or re-elected).  If a state store is
      // configured, try to seed `regions` + `shardHome` from the
      // last known snapshot — saves the from-scratch reallocation
      // storm of every shard re-registering through a fresh
      // tryAllocate call.  Failure is tolerated: we fall back to
      // the v1 rebuild-from-Register path when the load fails or
      // returns nothing.
      if (this.options.coordinatorStateStore) {
        void this.loadCoordinatorState();
      }
    }
    // Lease-aware coordinators re-evaluate the acquire/release cycle
    // any time the leader role flips — see `reconcileLease()`.  We
    // route through the mailbox so the state machine serialises with
    // any in-flight acquire result.
    if (this.options.lease) {
      this.self.tell({ t: 'reconcile' } satisfies CoordinatorEvent);
    }
  }

  /* ------------------- Coordinator-state persistence ------------------ */

  /**
   * Read the most recent snapshot from `coordinatorStateStore` and
   * seed `regions` + `shardHome` from it.  Drops any region whose
   * node has left the cluster between the snapshot and now —
   * otherwise we'd happily route shards to dead pods.  Existing
   * pending queries get a fresh allocation pass via the regular
   * onMessage flow.
   */
  private async loadCoordinatorState(): Promise<void> {
    const store = this.options.coordinatorStateStore;
    if (!store) return;
    let data: CoordinatorStateData | null;
    try {
      data = await store.load(this.options.typeName);
    } catch (err) {
      this.system.log.warn(
        `[sharding] coordinator-state load failed for '${this.options.typeName}'`,
        err,
      );
      return;
    }
    if (!data) return;

    // If we already have local state (e.g. preStart already absorbed
    // some Register messages), merge — keep what we know AND what
    // the snapshot says.  The snapshot's `regions` may be stale (a
    // node may have died), so we filter by current cluster membership.
    const livingNodes = new Set(
      this.options.cluster.upMembers().map((m) => m.address.toString()),
    );

    for (const r of data.regions) {
      if (!livingNodes.has(r.node.systemName + '@' + r.node.host + ':' + r.node.port)) {
        // Node dropped out of the cluster between snapshot and now
        // — skip the entry; the dead region won't be re-resurrected.
        continue;
      }
      const node = NodeAddress.fromJSON(r.node);
      if (this.regions.has(r.key)) continue; // already known via Register
      this.regions.set(r.key, {
        node, path: r.path, proxy: r.proxy, shards: new Set(r.shards),
      });
    }
    for (const [shardId, regionKey] of data.shardHome) {
      // Only adopt the home if the region survived the filter above.
      if (this.regions.has(regionKey) && !this.shardHome.has(shardId)) {
        this.shardHome.set(shardId, regionKey);
      }
    }
  }

  /**
   * Mark coordinator state dirty + schedule a save.  Called after
   * every meaningful mutation — handleRegister, tryAllocate,
   * handleHandOffComplete, onRegionTerminated.  Coalesces
   * overlapping bursts into 1-2 store writes via the
   * `inFlight + dirty` flag pair.
   */
  private scheduleCoordinatorStateSave(): void {
    const store = this.options.coordinatorStateStore;
    if (!store) return;
    if (!this.isLeader()) return;
    if (this.coordinatorStateInFlight) {
      this.coordinatorStateDirty = true;
      return;
    }
    this.coordinatorStateInFlight = true;
    const snapshot = this.snapshotCoordinatorState();
    void store.save(this.options.typeName, snapshot)
      .catch((err) => {
        this.system.log.warn(
          `[sharding] coordinator-state save failed for '${this.options.typeName}'`,
          err,
        );
      })
      .finally(() => {
        this.coordinatorStateInFlight = false;
        if (this.coordinatorStateDirty) {
          this.coordinatorStateDirty = false;
          this.scheduleCoordinatorStateSave();
        }
      });
  }

  private snapshotCoordinatorState(): CoordinatorStateData {
    const regions: RegionInfoData[] = [];
    for (const [key, info] of this.regions) {
      regions.push({
        key,
        node: info.node.toJSON(),
        path: info.path,
        proxy: info.proxy,
        shards: Array.from(info.shards),
      });
    }
    const shardHome: Array<readonly [number, string]> = [];
    for (const [shardId, regionKey] of this.shardHome) {
      shardHome.push([shardId, regionKey]);
    }
    return {
      leader: this.options.cluster.selfAddress.toString(),
      takenAt: Date.now(),
      regions,
      shardHome,
    };
  }

  /* ------------------------------- Rebalance ------------------------------- */

  private rebalanceTick(): void {
    const shardsToMove = this.options.allocationStrategy.rebalance(
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

    const timeout = this.options.handOffTimeoutMs ?? 10_000;
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
    if (node.equals(this.options.cluster.selfAddress)) {
      const ref = this.options.localResolver(path) as ActorRef<ShardingMessage> | null;
      if (ref) ref.tell(msg);
      return;
    }
    const remote = new RemoteActorRef<ShardingMessage>(node, path, this.options.cluster);
    remote.tell(msg);
  }
}
