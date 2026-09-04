import { match, P } from 'ts-pattern';
import { Actor } from '../../Actor.js';
import type { ActorRef } from '../../ActorRef.js';
import type { Cancellable } from '../../Scheduler.js';
import { SHARD_MAP_PUBLISH_DELAY_MS } from '../Constants.js';
import {
  DEFAULT_ACQUIRE_RETRY_INTERVAL_MS,
  DEFAULT_HAND_OFF_TIMEOUT_MS,
  DEFAULT_REBALANCE_ABSOLUTE_LIMIT,
  DEFAULT_REBALANCE_INTERVAL_MS,
  DEFAULT_REBALANCE_RELATIVE_LIMIT,
  DEFAULT_REGION_STALE_AFTER_MS,
} from './ShardCoordinatorOptions.js';
import type { ShardCoordinatorOptions, ShardCoordinatorOptionsType } from './ShardCoordinatorOptions.js';
import { LeaderChanged, MemberRemoved } from '../ClusterEvents.js';
import { NodeAddress, type NodeAddressData } from '../NodeAddress.js';
import type { EnvelopeMessage } from '../Protocol.js';
import { RemoteActorRef } from '../RemoteActorRef.js';
import { HashAllocationStrategy } from './AllocationStrategy.js';
import type {
  CoordinatorStateData,
  RegionInfoData,
} from './CoordinatorState.js';
import { AuthenticatedShardingMessage, isShardingMessage } from './ShardingProtocol.js';
import type {
  BeginHandOffAcknowledgment,
  ClusterShardingStats,
  EntityStarted,
  EntityStopped,
  GetClusterShardingStats,
  GetRememberedEntities,
  GetShardHome,
  HandOffComplete,
  RegionHeartbeat,
  RegionTerminated,
  RegisterAcknowledgment,
  RegisterRefused,
  RegisterRegion,
  ShardingMessage,
  ShardLocation,
  ShardMapUpdate,
  ShardRegionStats,
} from './ShardingProtocol.js';

/* ----------------------- internal mailbox events ----------------------- */
/**
 * The lease-aware path uses internal events instead of inline awaits so
 * cluster-event triggers can't interleave their `reconcile` calls with
 * an in-flight `lease.acquire()`.  Mirrors the same pattern used in
 * `ClusterSingletonManager` (#38).
 */
type CoordinatorEvent =
  | { kind: 'reconcile' }
  | { kind: 'lease-acquire-result'; got: boolean; error?: Error }
  | { kind: 'lease-lost'; reason: string }
  | { kind: 'acquire-retry' };

type CoordinatorInbox = ShardingMessage | AuthenticatedShardingMessage | CoordinatorEvent;

function isCoordinatorEvent(message: CoordinatorInbox): message is CoordinatorEvent {
  if (!message || typeof message !== 'object') return false;
  const discriminator = (message as { kind?: unknown }).kind;
  return discriminator === 'reconcile' || discriminator === 'lease-acquire-result'
    || discriminator === 'lease-lost' || discriminator === 'acquire-retry';
}

/**
 * The node a coordinator-inbound frame claims to speak for, or `null` when the
 * kind carries no address at all.
 *
 * Seven of the eleven kinds a coordinator accepts name a node in their payload,
 * and every one of them is a statement only that node can truthfully make:
 * which shards it hosts, that its region is gone or still there, that a
 * hand-off finished, where to send a shard home or a statistics reply.  This is
 * the lookup the authority gate compares against the authenticated peer (#712).
 *
 * The four that return `null` — `EntityStarted`, `EntityStopped`,
 * `GetRememberedEntities`, `BeginHandOffAcknowledgment` — have no address to
 * compare, so attribution is all the gate can require of them.
 */
function claimedNode(message: ShardingMessage): NodeAddressData | null {
  return match(message)
    .with({ kind: 'sharding.Register' }, (m) => m.node)
    .with({ kind: 'sharding.RegionTerminated' }, (m) => m.node)
    .with({ kind: 'sharding.RegionHeartbeat' }, (m) => m.node)
    .with({ kind: 'sharding.HandOffComplete' }, (m) => m.node)
    .with({ kind: 'sharding.GetShardHome' }, (m) => m.requesterNode)
    .with({ kind: 'sharding.GetClusterShardingStats' }, (m) => m.requesterNode)
    .with({ kind: 'sharding.ShardRegionStats' }, (m) => m.node)
    .otherwise(() => null);
}

/**
 * Whether a payload-supplied address names exactly the peer whose connection
 * carried it.
 *
 * Compared field-wise rather than through `NodeAddress.fromJSON`, which
 * *throws* on a shape the wire is free to send — a gate that the frame it is
 * gating can make throw is not a gate.  The comparison is the one `equals()`
 * performs, so a payload that would not have rebuilt into a valid address
 * cannot match a peer that did.
 */
function namesPeer(claimed: NodeAddressData, peer: NodeAddress): boolean {
  if (typeof claimed !== 'object' || claimed === null) return false;
  return claimed.systemName === peer.systemName
    && claimed.host === peer.host
    && claimed.port === peer.port;
}

type RegionInfo = {
  readonly node: NodeAddress;
  readonly path: string;
  readonly proxy: boolean;
  readonly shards: Set<number>;
  /**
   * When this region was last heard from at all — its registration, its beat,
   * or any other frame that names it (#853).  Not `readonly`: it is the one
   * field of a `RegionInfo` that moves without the entry being replaced.
   *
   * Refreshed by ordinary traffic as well as by the beat, so a busy region is
   * never swept for having had nothing to say.
   */
  lastSeenAtMs: number;
  /**
   * When this region last sent a {@link RegionHeartbeat}, or `null` if it never
   * has — which is what makes a region eligible for the sweep at all.
   *
   * A region only beats when its own node has `staleRegionDetection` on, so
   * `null` means "this region did not opt in", and evicting it would be acting
   * on a signal it never agreed to send.  That is exactly a rolling deploy: for
   * the window in which the leader runs the new build and some regions do not,
   * a `lastSeenAtMs`-only rule would evict every one of them on a timer, they
   * would re-register, and the loop would run until the deploy finished.  It
   * also covers a region seeded out of a persisted snapshot that has not
   * registered this term.
   */
  lastHeartbeatAtMs: number | null;
};

/**
 * How one `Register`'s accepted ids divide against the allocation map, decided
 * before the handler writes anything — see {@link ShardCoordinator.adjudicateClaim}.
 */
type ClaimVerdict = {
  /** Ids this registration takes ownership of. */
  readonly adopted: ReadonlySet<number>;
  /** Ids another registered region owns; the claimant is released from these. */
  readonly conflicting: ReadonlySet<number>;
  /** What `RegionInfo.shards` becomes: `adopted` plus what this key already holds. */
  readonly owned: Set<number>;
};

/**
 * One in-flight `GetClusterShardingStats`.  The coordinator owns the shard map
 * but not the entity counts — only the region hosting a shard knows those — so
 * a cluster-wide answer is a fan-out that has to be collected back together.
 */
type StatsQuery = {
  readonly requester: string;
  readonly requesterNode: NodeAddressData;
  readonly correlationId: number;
  /** Region keys we are still waiting on. */
  readonly awaiting: Set<string>;
  readonly entityCounts: Map<number, number>;
  /** Shards whose owning region reported a materialised actor. */
  readonly residents: Set<number>;
  timer: Cancellable | null;
};

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
  private readonly statsQueries = new Map<number, StatsQuery>();
  private nextStatsQuery = 0;
  /**
   * Region keys refused for a `numShards` mismatch (#633).  Refusing the
   * registration is not enough on its own: `onGetShardHome` never required one,
   * so a refused region's first buffered message would still get a home
   * allocated — under *its* hash of the entity id, which is the split the
   * refusal exists to prevent.
   */
  private readonly refusedRegions = new Set<string>();

  private rebalanceTimer: Cancellable | null = null;
  private unsubscribeCluster: (() => void) | null = null;
  private unsubscribeLeaseLost: (() => void) | null = null;
  private unsubscribeEnvelope: (() => void) | null = null;
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

  /**
   * Broadcast counter for `ShardMapChanged` — it counts *broadcasts*, not
   * individual assignments, because a burst is coalesced into one.
   */
  private shardMapVersion = 0;
  private shardMapPublishTimer: Cancellable | null = null;

  /**
   * Latch for {@link warnRoleMatchesNoRegion} — one line per episode of "the
   * configured role matches no registered region", not one per shard id.
   */
  private roleMismatchWarned = false;

  public readonly options: ShardCoordinatorOptionsType;

  constructor(options: ShardCoordinatorOptions) {
    super();
    this.options = options as ShardCoordinatorOptionsType;
  }

  override async preStart(): Promise<void> {
    // 0. Claim the coordinator's own well-known path on the envelope router
    //    before anything can arrive, so every inbound frame is stamped with the
    //    peer whose connection carried it.  #584 did exactly this for the
    //    region; the coordinator kept taking raw bodies through generic path
    //    resolution, which resolves the path and calls `ref.tell(body)` with no
    //    sender at all — throwing away the one field of an inbound frame the
    //    sender cannot choose, and the only thing that could have told a
    //    region's own claims apart from a peer's claims about it (#712).
    this.unsubscribeEnvelope = this.options.cluster._registerEnvelopeHandler(
      this.self.path.toString(),
      (envelope, from) => this.onRemoteEnvelope(envelope, from),
    );

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
        .otherwise(() => this.onOtherClusterEvent()),
    );
    if (this.options.lease) {
      this.unsubscribeLeaseLost = this.options.lease.onLost((reason) => {
        this.self.tell({ kind: 'lease-lost', reason } satisfies CoordinatorEvent);
      });
      // Kick the initial reconcile through the mailbox so the lease
      // path serialises with subsequent cluster events.
      this.self.tell({ kind: 'reconcile' } satisfies CoordinatorEvent);
    }
    const rebalanceIntervalMs = this.options.rebalanceIntervalMs ?? DEFAULT_REBALANCE_INTERVAL_MS;
    this.rebalanceTimer = this.system.scheduler.scheduleAtFixedRateFunction(
      rebalanceIntervalMs,
      rebalanceIntervalMs,
      () => { if (this.isActive()) this.rebalanceTick(); },
    );
  }

  /** Apply a single `RememberEvent` to the in-memory `entitiesPerShard`
   *  map.  Used by both the preStart replay AND
   *  `onEntityStarted` / `onEntityStopped` so the in-memory
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
    this.unsubscribeEnvelope?.();
    this.rebalanceTimer?.cancel();
    this.acquireRetryTimer?.cancel();
    this.shardMapPublishTimer?.cancel();
    for (const rebalance of this.rebalanceInProgress.values()) rebalance.timer.cancel();
    for (const query of this.statsQueries.values()) query.timer?.cancel();
    this.statsQueries.clear();
    if (this.options.lease && this.leaseState === 'held') {
      try { await this.options.lease.release(); } catch { /* best-effort */ }
      this.leaseState = 'none';
    }
  }

  override onReceive(message: CoordinatorInbox): void {
    if (message instanceof AuthenticatedShardingMessage) {
      this.receiveShardingMessage(message.message, message.peer);
      return;
    }
    // Internal coordinator events drive the lease state machine — they
    // run regardless of `isActive()` because they're how we transition
    // INTO `isActive()` in the first place.
    if (isCoordinatorEvent(message)) {
      this.handleCoordinatorEvent(message);
      return;
    }
    this.receiveShardingMessage(message, null);
  }

  /**
   * An envelope addressed to this coordinator arrived from `from`, whose
   * identity the transport authenticated.
   *
   * Re-enqueued through `self.tell` so the coordinator still processes it on its
   * own turn — the handler runs on the receive path, not in the actor.  A
   * coordinator is not a routing target for anything but sharding traffic, so a
   * body that is not a sharding frame is junk and goes no further.
   */
  private onRemoteEnvelope(envelope: EnvelopeMessage, from: NodeAddress): void {
    if (!isShardingMessage(envelope.body)) {
      this.log.debug(
        `[sharding] dropping a non-sharding envelope addressed to the '${this.options.typeName}' `
        + `coordinator from ${from}`,
      );
      return;
    }
    this.self.tell(new AuthenticatedShardingMessage(from, envelope.body));
  }

  /**
   * @param peer the node whose authenticated connection carried the frame, or
   *   `null` for one that reached the mailbox unattributed — a bare local
   *   `tell`, or an inbound envelope that dodged the per-path handler.  Every
   *   coordinator-inbound kind refuses the second case outright.
   */
  private receiveShardingMessage(message: ShardingMessage, peer: NodeAddress | null): void {
    if (!this.isLeader()) return;
    // Refused before the lease buffer, not after: an unauthorised frame is
    // never going to be dispatched, and letting it take a slot in a bounded
    // buffer would let a flood of forgeries crowd out the registrations the
    // buffer exists to keep.
    if (!this.maySpeakFor(message, peer)) return;
    if (this.options.lease && this.leaseState !== 'held') {
      // Leader, but lease not yet held — buffer instead of drop so
      // regions don't need to retry on the next cluster event.
      if (this.acquireBuffer.length < ShardCoordinator.ACQUIRE_BUFFER_CAP) {
        this.acquireBuffer.push(message);
      }
      return;
    }
    this.dispatchShardingMessage(message);
  }

  /**
   * Whether `peer` is allowed to say `message` on behalf of the region it names.
   *
   * The coordinator's only gate used to be `isLeader()` plus, with a lease,
   * `leaseState === 'held'` — which answers *"am I the authoritative
   * coordinator?"*, never *"may this sender speak for that region?"*.  So one
   * well-formed `Register` frame naming somebody else's node seized every shard
   * of a type, and one `RegionTerminated` evicted its region; the authenticated
   * peer was in the transport's hand the whole time and discarded on the way in
   * (#712).
   *
   * Two conditions, mirroring `ShardRegion.fromCoordinator` in the other
   * direction (#584).  The frame must have arrived inside an
   * {@link AuthenticatedShardingMessage}, which a JSON body cannot mint — so
   * the wrapper is proof the frame came through the per-path envelope handler
   * (or from a region on this very node) rather than out of an attacker's
   * `body`, and it survives the non-canonical-`to` bypass, where a trailing
   * slash misses the handler and generic path resolution delivers unwrapped.
   * And the address the payload claims must be the peer's own.
   *
   * Refusing is safe: a region re-registers and re-asks for every buffered
   * shard on the next leader or membership event, so a frame dropped during a
   * leadership handover is re-sent rather than lost.
   *
   * The internal `onMemberRemoved` → `onRegionTerminated` path deliberately does
   * not come through here — it synthesises its message from the cluster event's
   * own address, which is not a claim anyone made over the wire.
   */
  private maySpeakFor(message: ShardingMessage, peer: NodeAddress | null): boolean {
    if (peer === null) {
      this.log.warn(
        `[sharding] refusing an unattributed '${message.kind}' for type `
        + `"${this.options.typeName}" — a coordinator directive has to arrive on an `
        + `authenticated connection`,
      );
      return false;
    }
    const claimed = claimedNode(message);
    if (claimed === null || namesPeer(claimed, peer)) return true;
    // The claimed address is deliberately not interpolated: it is caller-chosen
    // and unbounded, and this log line is reachable by anyone who can complete a
    // `hello`.  The peer is the transport's own value, which is enough to find
    // the sender.
    this.log.warn(
      `[sharding] refusing '${message.kind}' for type "${this.options.typeName}" from ${peer} — `
      + `it names a different node, and only that node may speak for its region`,
    );
    return false;
  }

  private dispatchShardingMessage(message: ShardingMessage): void {
    match(message)
      .with({ kind: 'sharding.Register' }, (m) => this.onRegister(m))
      .with({ kind: 'sharding.GetShardHome' }, (m) => this.onGetShardHome(m))
      .with({ kind: 'sharding.HandOffComplete' }, (m) => this.onHandOffComplete(m))
      .with({ kind: 'sharding.BeginHandOffAcknowledgment' }, () => this.onBeginHandOffAcknowledgment())
      .with({ kind: 'sharding.RegionTerminated' }, (m) => this.onRegionTerminated(m))
      .with({ kind: 'sharding.RegionHeartbeat' }, (m) => this.onRegionHeartbeat(m))
      .with({ kind: 'sharding.EntityStarted' }, (m) => this.onEntityStarted(m))
      .with({ kind: 'sharding.EntityStopped' }, (m) => this.onEntityStopped(m))
      .with({ kind: 'sharding.GetRememberedEntities' }, (m) => this.onGetRememberedEntities(m))
      .with({ kind: 'sharding.GetClusterShardingStats' }, (m) => this.onGetClusterShardingStats(m))
      .with({ kind: 'sharding.ShardRegionStats' }, (m) => this.onShardRegionStats(m))
      .otherwise(() => this.onUnhandled());
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
      .with({ kind: 'reconcile' }, () => this.onReconcile())
      .with({ kind: 'lease-acquire-result' }, (m) => this.onLeaseAcquireResult(m))
      .with({ kind: 'lease-lost' }, (m) => this.onLeaseLost(m))
      .with({ kind: 'acquire-retry' }, () => this.onAcquireRetry())
      .exhaustive();
  }

  private onReconcile(): void {
    this.reconcileLease();
  }

  private onAcquireRetry(): void {
    this.reconcileLease();
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
        // Let the in-flight acquire finish; onLeaseAcquireResult will
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
      this.self.tell({ kind: 'lease-acquire-result', got } satisfies CoordinatorEvent);
    } catch (error) {
      this.self.tell({
        kind: 'lease-acquire-result', got: false, error: error as Error,
      } satisfies CoordinatorEvent);
    }
  }

  private onLeaseAcquireResult(result: { got: boolean; error?: Error }): void {
    if (this.leaseState !== 'acquiring') {
      // Spurious result — release if we somehow got it.
      if (result.got) void this.options.lease!.release().catch(() => { /* ignore */ });
      return;
    }
    if (!result.got) {
      if (result.error) this.system.log.warn(`[sharding] lease acquire failed`, result.error);
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
      for (const message of buffered) this.dispatchShardingMessage(message);
    }
  }

  private onLeaseLost(message: { reason: string }): void {
    if (this.leaseState !== 'held') return;
    this.system.log.warn(
      `[sharding] coordinator '${this.options.typeName}' lost lease — ${message.reason}; stepping down`,
    );
    this.leaseState = 'none';
    // Cancel any in-flight rebalance handoff timers — those would
    // fire force-reallocations that we shouldn't be doing while
    // passive.  Pending queries get dropped (regions retry once we
    // become active again, or once cluster events flush their
    // register loop).
    for (const rebalance of this.rebalanceInProgress.values()) rebalance.timer.cancel();
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
    this.self.tell({ kind: 'reconcile' } satisfies CoordinatorEvent);
  }

  private scheduleAcquireRetry(): void {
    const interval = this.options.acquireRetryIntervalMs ?? DEFAULT_ACQUIRE_RETRY_INTERVAL_MS;
    this.acquireRetryTimer?.cancel();
    this.acquireRetryTimer = this.system.scheduler.scheduleOnceFunction(interval, () => {
      this.self.tell({ kind: 'acquire-retry' } satisfies CoordinatorEvent);
    });
  }

  private candidates(): NodeAddress[] {
    const role = this.options.role;
    const activeRegions = Array.from(this.regions.values()).filter(r => !r.proxy);
    const addrs = activeRegions.map(r => r.node);
    if (!role) return addrs;
    return addrs.filter(a => {
      const member = this.options.cluster.getMembers().find(x => x.address.equals(a));
      return member?.hasRole(role) ?? false;
    });
  }

  /**
   * Say out loud that a configured role matches none of the regions that did
   * register — the one shape of "no candidates" that is a misconfiguration
   * rather than a phase of startup (#847).
   *
   * `tryAllocate` returns silently on an empty candidate set, which is correct
   * and unremarkable while nobody has registered yet.  The same silence over a
   * role that no member carries is a deployment stuck forever with every
   * message for the type accumulating in the regions' routing buffers (#849),
   * and nothing anywhere naming the cause.  Per-type in code that risk is one
   * `withRole` typo; read from a shared config file it is every sharded type on
   * every node, which is what makes it worth a line.
   *
   * Registered-but-filtered-out is the discriminating condition: with no
   * non-proxy region at all the cause is "nobody has registered", so warning
   * there would fire on every healthy cold start. One line per episode, cleared
   * as soon as an allocation succeeds, so a role that becomes wrong again is
   * still reported — the latch shape #849's buffer overflow uses.
   */
  private warnRoleMatchesNoRegion(): void {
    const role = this.options.role;
    if (!role || this.roleMismatchWarned) return;
    const registered = Array.from(this.regions.values()).filter(r => !r.proxy).length;
    if (registered === 0) return;
    this.roleMismatchWarned = true;
    this.log.warn(
      `[sharding] no member hosting type "${this.options.typeName}" carries role "${role}", so none of `
      + `the ${registered} registered region(s) can be allocated a shard; every message for the type will `
      + 'buffer until one does. Set actor-ts.sharding.role (or withRole) to a role the hosting nodes '
      + 'actually declare via ClusterOptions.withRoles',
    );
  }

  private currentShardCounts(): Map<string, Set<number>> {
    // Keyed by node address string so AllocationStrategy can match against
    // the NodeAddress it returned in `allocate`.
    const out = new Map<string, Set<number>>();
    for (const info of this.regions.values()) {
      if (info.proxy) continue;
      const addr = info.node.toString();
      const existing = out.get(addr) ?? new Set<number>();
      for (const shardId of info.shards) existing.add(shardId);
      out.set(addr, existing);
    }
    return out;
  }

  /* ------------------------------- Handlers -------------------------------- */

  private onBeginHandOffAcknowledgment(): void {
    /* informational only */
  }

  /**
   * A region says it is still there (#853).
   *
   * The frame carries no claim beyond its own identity, so the handler has
   * nothing to adjudicate — see {@link RegionHeartbeat} for why a periodic
   * re-`Register` was not an option.  An unknown key is silently ignored: a
   * region that beats before its registration lands, or after a leader change
   * cleared the map, has nothing here to refresh, and its next `Register` is
   * what puts it back.
   */
  private onRegionHeartbeat(message: RegionHeartbeat): void {
    const info = this.regionFor(message.region, message.node);
    if (!info) return;
    const now = Date.now();
    info.lastSeenAtMs = now;
    info.lastHeartbeatAtMs = now;
  }

  /**
   * The registry entry a frame's `(region, node)` pair names, if there is one.
   *
   * The address is safe to rebuild here even though `NodeAddress.fromJSON`
   * throws on a shape the wire is free to send: `maySpeakFor` has already
   * compared this very field against the authenticated peer, so anything that
   * reaches a handler matched a real member's address.
   */
  private regionFor(path: string, nodeData: NodeAddressData): RegionInfo | undefined {
    return this.regions.get(regionKey(NodeAddress.fromJSON(nodeData), path));
  }

  /**
   * Note that a region spoke, whatever it said (#853).
   *
   * Called from every coordinator-inbound kind that names a region *and* the
   * node hosting it, which is what `regionKey` needs to resolve one:
   * `GetShardHome`, `HandOffComplete` and `ShardRegionStats`.  A region under
   * load therefore never needs the beat at all, and the beat only has to cover
   * an idle one.
   *
   * `EntityStarted` / `EntityStopped` name no region and are deliberately not
   * here.  The peer alone could be matched against `RegionInfo.node`, but a
   * node may host a proxy and a real region for the same type, and refreshing
   * both on one frame would credit liveness to a region that said nothing.
   *
   * It deliberately does **not** touch `lastHeartbeatAtMs`: ordinary traffic
   * says the region is alive, not that it has opted into being swept when it
   * stops.  Only the beat says that.
   */
  private markRegionSeen(path: string, nodeData: NodeAddressData): void {
    const info = this.regionFor(path, nodeData);
    if (info) info.lastSeenAtMs = Date.now();
  }

  private onUnhandled(): void {
    /* other ShardingMessage variants are region-side */
  }

  /**
   * A region claiming a different shard count than this coordinator governs is
   * refused outright (#633).
   *
   * `hash(entityId) % numShards` is computed independently on every node, so
   * two counts split the routing: entity `x` hashes to 45 under 64 shards and
   * to 13 under 32, both nodes own the shard their own hash produced, and both
   * instantiate `x` — at `shard-13/x` and `shard-45/x`, paths that never
   * collide, which is why nothing warned.  The bound added in #583 catches only
   * one direction of this (a region asking for an id above the coordinator's
   * range) and turns it into a silent hang; the other direction passes cleanly
   * and double-homes.  Refusing the registration is what makes both directions
   * fail the same, loud way: an unregistered region is never a placement
   * candidate, so it can never be handed a shard to double-home.
   *
   * Compared against the coordinator's own configured count rather than the
   * first registrant's, which is not a durable authority — `onLeaderChanged`
   * clears `regions` wholesale and `loadCoordinatorState` restores no shard
   * count, so "first" would be re-decided at every election.
   */
  private isAgreedNumShards(message: RegisterRegion): boolean {
    const key = regionKey(NodeAddress.fromJSON(message.node), message.region);
    if (message.numShards === this.options.numShards) {
      this.refusedRegions.delete(key);
      return true;
    }
    this.refusedRegions.add(key);
    this.log.error(
      `refusing to register region ${message.region} on ${message.node.host}:${message.node.port} `
      + `for type "${this.options.typeName}": it hashes with numShards=${message.numShards} but this `
      + `coordinator governs the type with numShards=${this.options.numShards}. Routing would split `
      + `and the same entity id would run on both nodes at once.`,
    );
    const refusal: RegisterRefused = {
      kind: 'sharding.RegisterRefused',
      coordinator: this.self.path.toString(),
      numShards: this.options.numShards,
      regionNumShards: message.numShards,
    };
    this.replyTo(message.region, message.node, refusal);
    return false;
  }

  private onRegister(message: RegisterRegion): void {
    if (!this.isAgreedNumShards(message)) return;
    const hostedShards = this.acceptedHostedShards(message);
    const node = NodeAddress.fromJSON(message.node);
    const key = regionKey(node, message.region);
    // Judged against the map as it stands *before* any write below — the whole
    // point is that the claim does not get to decide what it is compared with.
    const verdict = this.adjudicateClaim(key, hostedShards);
    this.regions.set(key, {
      node,
      path: message.region,
      proxy: message.proxy,
      shards: verdict.owned,
      // A registration is the loudest possible "I am here", so a re-registering
      // region gets a full `stale-after` to produce its first beat (#853).  The
      // beat record is carried across a re-registration rather than reset: a
      // region that has proved it beats does not stop being a sweep candidate
      // because a leader change made it register again.
      lastSeenAtMs: Date.now(),
      lastHeartbeatAtMs: this.regions.get(key)?.lastHeartbeatAtMs ?? null,
    });
    for (const shardId of verdict.adopted) {
      const previous = this.shardHome.get(shardId);
      // Defensive, and one line: under the classification above an adopted id's
      // previous home is either absent, this same key, or a key that has left
      // `regions`, so the optional call is a no-op today.  It is what keeps
      // "ownership moving away clears the old owner's set" true by construction
      // rather than by case analysis, for whichever write path drifts next.
      if (previous !== undefined && previous !== key) this.regions.get(previous)?.shards.delete(shardId);
      this.shardHome.set(shardId, key);
    }
    const ack: RegisterAcknowledgment = {
      kind: 'sharding.RegisterAcknowledgment',
      coordinator: this.self.path.toString(),
    };
    this.replyTo(message.region, message.node, ack);
    // Strictly after the acknowledgment: the ack is what cancels the claimant's
    // 500 ms register retry (`ShardRegion.onRegisterAcknowledgment`), and a
    // directive that overtakes it lands on a region still re-registering.
    this.releaseConflictingShards(key, message, verdict.conflicting);

    // Adopted only.  Run over the whole claim these would answer a pending
    // `GetShardHome` for a shard this registration did not get, and re-ship the
    // entire remembered-entity registry of a shard to the region that just lost
    // the argument about owning it.
    for (const shardId of verdict.adopted) this.flushPending(shardId);

    if (this.options.rememberEntities) {
      for (const shardId of verdict.adopted) this.shipRememberedEntities(shardId);
    }
    this.afterShardMapChange();
  }

  /**
   * Split an accepted claim into what this registration may take and what it
   * may not (#948).
   *
   * `hostedShards` is a region's statement about *itself*, and #712 made the
   * sender honest — the frame is attributed to the peer and its ids are in
   * range — without making the claim true.  A region whose `localShards` has
   * gone stale keeps claiming what it used to own: nothing clears that set when
   * a node is downed by a false positive (`ShardRegion.invalidateHomesOnNode`
   * deliberately leaves it alone), and `ensureRegistered()` re-sends the claim
   * on every `MemberUp`, `MemberRemoved` and `LeaderChanged` plus a 500 ms
   * retry.  Written straight into `shardHome`, that takes the shard back from
   * whoever took over and runs the same entity ids on both nodes — two writers
   * on one `persistenceId` for a `PersistentActor`.
   *
   * So an id is **adopted** only when the map does not already hand it to
   * somebody else: no home at all, a home naming a key that has since left
   * `regions` (a leader term that cleared the map, or a terminated region whose
   * entry dangled), or a home that is this claimant's already.  An id homed to a
   * *different* key that is still registered is **conflicting**: ownership does
   * not move, and the claimant is released from it instead.
   *
   * `owned` is what `RegionInfo.shards` becomes, and it is a **merge**, not the
   * claim.  `tryAllocate` writes `shardHome[N] = K` and `K.shards.add(N)` and
   * only then pushes `ShardHome` at K, so a `Register` from K that was already
   * in flight carries a `localShards` without N and used to drop N from
   * `RegionInfo.shards` while `shardHome` still named K — after which
   * `onRegionTerminated(K)` iterates `info.shards` and never reallocates N, and
   * `snapshotCoordinatorState` persists the hole.  Adding back every id
   * `shardHome` already assigns to this key closes that in the same pass.
   *
   * The guard shape is `loadCoordinatorState`'s (`regions.has` / `!shardHome.has`
   * before writing); the limit is the same one it has.  A fresh leader term
   * clears `regions` and `shardHome` wholesale, so in the first moments of a
   * term every claim is unowned and the rule degenerates to first-claim-wins by
   * mailbox order.  That is better than the last-claim-wins it replaces — the
   * later claim is the likelier stale one — but it does not *resolve* a
   * double-homing that predates the election; it stops new ones.
   */
  private adjudicateClaim(key: string, claimed: ReadonlySet<number>): ClaimVerdict {
    const adopted = new Set<number>();
    const conflicting = new Set<number>();
    for (const shardId of claimed) {
      const home = this.shardHome.get(shardId);
      if (home === undefined || home === key || !this.regions.has(home)) {
        adopted.add(shardId);
        continue;
      }
      conflicting.add(shardId);
    }
    const owned = new Set<number>(adopted);
    for (const [shardId, home] of this.shardHome) {
      if (home === key) owned.add(shardId);
    }
    return { adopted, conflicting, owned };
  }

  /**
   * Tell a claimant to give up the shards it does not own.
   *
   * A `HandOff` rather than an authoritative `ShardHome`, because the region's
   * `onShardHome` remote branch only forgets the id — it leaves the `Shard`
   * actor and its entities running, and `sweepEmptyShards` filters on the entry
   * it just deleted, so the orphan is unreclaimable (#953).  `onHandOff` is the
   * one region-side path that actually stops them: it marks the shard
   * `handing-off`, acknowledges, forgets its entities and stops the `Shard`, so
   * a persistent entity runs `postStop` and flushes before the true owner's copy
   * takes traffic.  Nothing new is needed for it — the frame is in the protocol
   * and `replyTo` already authenticates the local leg.
   *
   * Deliberately **not** recorded in `rebalanceInProgress`.  That map's timeout
   * callback deletes `shardHome[shardId]` and reallocates, which here would
   * destroy the *true owner's* ownership on a timer over a hand-off it never
   * agreed to.  Left out, the claimant's `HandOffComplete` meets
   * `if (!inProgress) return` and is the harmless no-op it should be.
   *
   * A shard already mid-rebalance is skipped for the mirror-image reason:
   * `onHandOffComplete` checks no ownership and is handed no peer (#1231), so
   * the claimant's completion would end the true owner's genuine rebalance
   * early. Its stale copy stays up for now — the status quo for that id, minus
   * the map corruption — and the next registration releases it once the
   * rebalance has finished.
   */
  private releaseConflictingShards(
    key: string, message: RegisterRegion, conflicting: ReadonlySet<number>,
  ): void {
    if (conflicting.size === 0) return;
    const owners = new Set<string>();
    let released = 0;
    for (const shardId of conflicting) {
      // The owner's *address*, never its region key: a key carries the
      // caller-chosen path it was built from, and this line is reachable by
      // anyone who can register.  Every conflicting id has a registered owner by
      // construction, so nothing is lost by having no fallback.
      const owner = this.regions.get(this.shardHome.get(shardId) ?? '');
      if (owner) owners.add(owner.node.toString());
      if (this.rebalanceInProgress.has(shardId)) continue;
      this.sendToRegion(key, { kind: 'sharding.HandOff', shardId });
      released += 1;
    }
    // One line per registration, never one per id — the same rule
    // `acceptedHostedShards` states, and for the same reason: the claim is
    // caller-sized, and a stale region re-registers on every membership event.
    this.log.warn(
      `[sharding] region ${message.region} on ${message.node.host}:${message.node.port} claimed `
      + `${conflicting.size} shard(s) of type "${this.options.typeName}" that ${Array.from(owners).sort().join(', ')} `
      + `already own${owners.size === 1 ? 's' : ''}; ownership stays put and ${released} hand-off(s) were sent `
      + `to give the stale copies up`,
    );
  }

  /**
   * The ids from a `Register` claim this coordinator is willing to record.
   *
   * `hostedShards` is the one coordinator input that is a caller-*sized* array,
   * and `onRegister` used to write a `shardHome` entry for every entry in it
   * with no range check and no length cap — while `onGetShardHome`, the other
   * write path into the same map, has had the bound since #583.  So a single
   * frame could plant millions of out-of-range ids in state that is broadcast to
   * every region and persisted to `coordinatorStateStore`, and the growth
   * survived restarts (#712, #948).
   *
   * Both bounds fall out of one rule.  A shard id is `hash(entityId) %
   * numShards`, so the accepted set can only ever hold ids in
   * `0 .. numShards - 1` — which means it is *full* at `numShards` entries and
   * nothing later in the array can add to it.  The range check is therefore the
   * length cap as well, and the early exit is what keeps an over-long claim from
   * costing a `flushPending` and a `shipRememberedEntities` per entry.  Iterating
   * the set rather than the array does the same for duplicates.
   *
   * The surplus is dropped rather than the whole registration refused: a region
   * that disagrees about `numShards` already has its own loud verdict (#633),
   * and refusing here would take a misbehaving region's *legitimate* shards down
   * with the bad ids.
   */
  private acceptedHostedShards(message: RegisterRegion): ReadonlySet<number> {
    const claimed: readonly unknown[] = Array.isArray(message.hostedShards) ? message.hostedShards : [];
    const accepted = new Set<number>();
    let scanned = 0;
    for (const shardId of claimed) {
      if (accepted.size >= this.options.numShards) break;
      scanned += 1;
      if (this.isShardIdInRange(shardId)) accepted.add(shardId);
    }
    if (accepted.size !== claimed.length) {
      // One line per registration, never one per id: the claim is caller-sized,
      // so a per-id warning is itself the amplification.
      this.log.warn(
        `[sharding] region ${message.region} claimed ${claimed.length} hosted shard(s) for type `
        + `"${this.options.typeName}"; keeping ${accepted.size} after scanning ${scanned} — the rest `
        + `were duplicates or outside 0..${this.options.numShards - 1}`,
      );
    }
    return accepted;
  }

  /**
   * One meaningful change to `regions` / `shardHome`: persist the snapshot and
   * tell every region.  Both are coalesced, so calling this per mutation
   * during a rebalance burst is fine.
   */
  private afterShardMapChange(): void {
    this.scheduleCoordinatorStateSave();
    this.scheduleShardMapPublish();
  }

  /**
   * A shard id is `hash(entityId) % numShards`, so no honest region can ask
   * for one outside the range.  Nothing checked that: the coordinator
   * allocated, recorded and *persisted* whatever id it was handed, and the
   * allocation map is durable state replayed at every coordinator start — so a
   * peer could grow it without limit, and the growth survived restarts (#583).
   */
  private isKnownShardId(shardId: number): boolean {
    if (this.isShardIdInRange(shardId)) return true;
    this.log.warn(
      `ignoring a shard request for id ${shardId} — outside 0..${this.options.numShards - 1} `
      + `for type "${this.options.typeName}"`,
    );
    return false;
  }

  /**
   * The range rule itself, without the log line — `acceptedHostedShards` checks
   * a caller-sized array against it and cannot afford a warning per entry, so
   * the rule has to live somewhere both callers can reach it.  `unknown` rather
   * than `number` because the wire is free to put anything in either field.
   */
  private isShardIdInRange(shardId: unknown): shardId is number {
    return typeof shardId === 'number' && Number.isInteger(shardId)
      && shardId >= 0 && shardId < this.options.numShards;
  }

  private onGetShardHome(message: GetShardHome): void {
    this.markRegionSeen(message.requester, message.requesterNode);
    if (!this.isKnownShardId(message.shardId)) return;
    // A refused region's shard ids are drawn from a different modulus, so
    // answering one places the *same* entity id in a second shard — the exact
    // split refusing its registration was meant to stop.  It stays buffered
    // instead, which is the fail-stop; the error the region logged on the
    // refusal says why.
    if (this.refusedRegions.has(regionKey(NodeAddress.fromJSON(message.requesterNode), message.requester))) {
      return;
    }
    const home = this.shardHome.get(message.shardId);
    if (home && this.regions.has(home)) {
      const info = this.regions.get(home)!;
      this.replyTo(message.requester, message.requesterNode, {
        kind: 'sharding.ShardHome',
        shardId: message.shardId,
        region: info.path,
        node: info.node.toJSON(),
      });
      return;
    }

    const list = this.pending.get(message.shardId) ?? [];
    list.push(message);
    this.pending.set(message.shardId, list);

    if (!this.rebalanceInProgress.has(message.shardId)) this.tryAllocate(message.shardId);
  }

  private tryAllocate(shardId: number): void {
    const cs = this.candidates();
    if (cs.length === 0) {
      this.warnRoleMatchesNoRegion();
      return;
    }
    this.roleMismatchWarned = false;
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
      kind: 'sharding.ShardHome',
      shardId,
      region: info.path,
      node: info.node.toJSON(),
    });
    this.flushPending(shardId);
    if (this.options.rememberEntities) this.shipRememberedEntities(shardId);
    this.afterShardMapChange();
  }

  private onHandOffComplete(message: HandOffComplete): void {
    this.markRegionSeen(message.region, message.node);
    const shardId = message.shardId;
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

  private onEntityStarted(message: EntityStarted): void {
    if (!this.options.rememberEntities) return;
    this.applyRememberEvent({ kind: 'started', shardId: message.shardId, entityId: message.entityId });
    this.persistRememberEvent({ kind: 'started', shardId: message.shardId, entityId: message.entityId });
  }

  private onEntityStopped(message: EntityStopped): void {
    if (!this.options.rememberEntities) {
      // Existing behaviour: tidy the in-memory map even when we're
      // not remembering entities, so an unwise external trigger
      // doesn't leave stale data in the map.
      const set = this.entitiesPerShard.get(message.shardId);
      if (set) { set.delete(message.entityId); if (set.size === 0) this.entitiesPerShard.delete(message.shardId); }
      return;
    }
    // A shard that is mid-rebalance is not losing entities, it is losing a
    // *host* — and the registry has to outlive the move for `tryAllocate` to
    // hand it to the new owner.  The departing region no longer announces its
    // entities as stopped (#632), but an entity passivating on its own in the
    // window between `HandOff` and `HandOffComplete` still would, and that one
    // would be just as wrongly forgotten.
    if (this.rebalanceInProgress.has(message.shardId)) return;
    this.applyRememberEvent({ kind: 'stopped', shardId: message.shardId, entityId: message.entityId });
    this.persistRememberEvent({ kind: 'stopped', shardId: message.shardId, entityId: message.entityId });
  }

  /**
   * A region lost a shard's entities without losing the shard itself — its
   * shard actor died outside a handoff (#894).  Ownership never moved, so the
   * two paths that normally ship the registry (`onRegister`, `tryAllocate`)
   * cannot fire, and the shard would come back empty while we still list what
   * it held.
   */
  private onGetRememberedEntities(message: GetRememberedEntities): void {
    if (!this.options.rememberEntities) return;
    this.shipRememberedEntities(message.shardId);
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

  /* ------------------------------ Statistics ----------------------------- */

  /**
   * Answer "what shards exist, where, and how full are they?" (#151).
   *
   * The coordinator owns the shard map, but a shard's entity count is only
   * known to the region hosting it, so this fans `GetShardRegionStats` out to
   * every non-proxy region and joins the answers against `shardHome`.  The
   * timeout is a *partial-answer* deadline, not a failure: a region that is
   * slow or already gone contributes zero rather than turning the whole query
   * into a timeout at the caller.
   */
  private onGetClusterShardingStats(message: GetClusterShardingStats): void {
    const targets = Array.from(this.regions.entries()).filter(([, info]) => !info.proxy);
    const query: StatsQuery = {
      requester: message.requester,
      requesterNode: message.requesterNode,
      correlationId: message.correlationId,
      awaiting: new Set(targets.map(([key]) => key)),
      entityCounts: new Map(),
      residents: new Set(),
      timer: null,
    };
    if (query.awaiting.size === 0) { this.answerStatsQuery(query); return; }

    const queryId = ++this.nextStatsQuery;
    this.statsQueries.set(queryId, query);
    query.timer = this.system.scheduler.scheduleOnceFunction(message.timeoutMs, () => {
      const pending = this.statsQueries.get(queryId);
      if (!pending) return;
      this.statsQueries.delete(queryId);
      this.answerStatsQuery(pending);
    });
    for (const [key] of targets) {
      this.sendToRegion(key, {
        kind: 'sharding.GetShardRegionStats',
        queryId,
        requester: this.self.path.toString(),
        requesterNode: this.options.cluster.selfAddress.toJSON(),
      });
    }
  }

  private onShardRegionStats(message: ShardRegionStats): void {
    this.markRegionSeen(message.region, message.node);
    const query = this.statsQueries.get(message.queryId);
    if (!query) return;
    const key = regionKey(NodeAddress.fromJSON(message.node), message.region);
    if (!query.awaiting.delete(key)) return;
    for (const entry of message.shards) {
      query.entityCounts.set(
        entry.shardId,
        (query.entityCounts.get(entry.shardId) ?? 0) + entry.entityCount,
      );
      if (entry.resident) query.residents.add(entry.shardId);
    }
    if (query.awaiting.size > 0) return;
    query.timer?.cancel();
    this.statsQueries.delete(message.queryId);
    this.answerStatsQuery(query);
  }

  private answerStatsQuery(query: StatsQuery): void {
    const shards: ShardLocation[] = [];
    for (const [shardId, key] of this.shardHome) {
      const info = this.regions.get(key);
      if (!info) continue;
      shards.push({
        shardId,
        node: info.node.toJSON(),
        regionPath: info.path,
        entityCount: query.entityCounts.get(shardId) ?? 0,
        // A region that timed out contributes neither a count nor residency,
        // so an unanswered shard reads as "allocated, not known to be up" —
        // the same conservative direction `entityCount: 0` already takes.
        resident: query.residents.has(shardId),
      });
    }
    shards.sort((a, b) => a.shardId - b.shardId);
    const reply: ClusterShardingStats = {
      kind: 'sharding.ClusterShardingStats',
      correlationId: query.correlationId,
      shards,
    };
    this.replyTo(query.requester, query.requesterNode, reply);
  }

  private onRegionTerminated(message: RegionTerminated): void {
    const addr = NodeAddress.fromJSON(message.node);
    const key = regionKey(addr, message.region);
    const info = this.regions.get(key);
    if (!info) return;
    this.regions.delete(key);
    for (const shardId of info.shards) {
      this.shardHome.delete(shardId);
      const inProg = this.rebalanceInProgress.get(shardId);
      if (inProg) { inProg.timer.cancel(); this.rebalanceInProgress.delete(shardId); }
      this.tryAllocate(shardId);
    }
    // Losing the region is itself a change to the map even when it hosted
    // nothing, and `tryAllocate` bails out early when there is nowhere left
    // to put the shards — so record it unconditionally.  Both the save and
    // the broadcast coalesce, so the overlap with tryAllocate costs nothing.
    this.afterShardMapChange();
  }

  private onMemberRemoved(addr: NodeAddress): void {
    for (const [_key, info] of Array.from(this.regions.entries())) {
      if (info.node.equals(addr)) {
        this.onRegionTerminated({
          kind: 'sharding.RegionTerminated',
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
      // A refusal is a verdict of *this* leader term.  Every region
      // re-registers on the leader change, so the next term re-derives it.
      this.refusedRegions.clear();
      this.acquireBuffer = [];
      for (const rebalance of this.rebalanceInProgress.values()) rebalance.timer.cancel();
      this.rebalanceInProgress.clear();
      // In-flight stats queries answered from a view we no longer own would
      // be worse than the caller's own timeout — drop them.
      for (const query of this.statsQueries.values()) query.timer?.cancel();
      this.statsQueries.clear();
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
      this.self.tell({ kind: 'reconcile' } satisfies CoordinatorEvent);
    }
  }

  private onOtherClusterEvent(): void {
    /* other events are not observed here */
  }

  /* ------------------- Coordinator-state persistence ------------------ */

  /**
   * Read the most recent snapshot from `coordinatorStateStore` and
   * seed `regions` + `shardHome` from it.  Drops any region whose
   * node has left the cluster between the snapshot and now —
   * otherwise we'd happily route shards to dead pods.  Existing
   * pending queries get a fresh allocation pass via the regular
   * onMessage flow.
   *
   * Two things a snapshot may not do, both of them ways round the `numShards`
   * refusal (#633).  It may not carry a *different* modulus than this
   * coordinator governs — every shard id in it was produced by
   * `hash(entityId) % numShards`, so the whole allocation map is meaningless
   * under another count, and adopting it hands regions shards under two
   * different hashes at once.  And it may not restore a region this coordinator
   * has already refused: `candidates()` is built from `regions` and
   * `tryAllocate` pushes a `ShardHome` at whoever the strategy picks, so a
   * restored refusal is a full placement candidate again.
   *
   * The refusal check sits *inside* the loop rather than in front of it because
   * the load is fire-and-forget (`void this.loadCoordinatorState()` on the
   * promotion) — a `Register` refused while the store call is still in flight
   * leaves `regions.has(key)` false when the loop finally runs, so a guard
   * hoisted above the loop would read an empty refusal set and let the entry
   * through anyway.
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
    if (data.numShards !== this.options.numShards) {
      this.log.warn(
        `[sharding] ignoring the coordinator-state snapshot for '${this.options.typeName}' written by `
        + `${data.leader}: it was taken with numShards=${data.numShards ?? 'unstated'} and this `
        + `coordinator governs the type with numShards=${this.options.numShards}, so every shard id `
        + `in it was hashed under a different modulus. Rebuilding from region registrations instead.`,
      );
      return;
    }

    // If we already have local state (e.g. preStart already absorbed
    // some Register messages), merge — keep what we know AND what
    // the snapshot says.  The snapshot's `regions` may be stale (a
    // node may have died), so we filter by current cluster membership.
    const livingNodes = new Set(
      this.options.cluster.upMembers().map((m) => m.address.toString()),
    );

    for (const region of data.regions) {
      if (!livingNodes.has(region.node.systemName + '@' + region.node.host + ':' + region.node.port)) {
        // Node dropped out of the cluster between snapshot and now
        // — skip the entry; the dead region won't be re-resurrected.
        continue;
      }
      if (this.refusedRegions.has(region.key)) continue; // refused this term; see the note above
      const node = NodeAddress.fromJSON(region.node);
      if (this.regions.has(region.key)) continue; // already known via Register
      this.regions.set(region.key, {
        node,
        path: region.path,
        proxy: region.proxy,
        shards: new Set(region.shards),
        // Stamped fresh at seed time, not carried from the snapshot: the entry
        // is being adopted now, and a `takenAt` from the previous leader would
        // hand a region a debt it never ran up (#853).  `lastHeartbeatAtMs`
        // stays `null` — nothing has beaten to *this* coordinator — so a seeded
        // region is exempt from the sweep until it registers and beats, which
        // is the "startup grace" the issue asked for, derived rather than
        // configured.
        lastSeenAtMs: Date.now(),
        lastHeartbeatAtMs: null,
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
   * every meaningful mutation — onRegister, tryAllocate,
   * onHandOffComplete, onRegionTerminated.  Coalesces
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

  /* ------------------------- Shard-map broadcast ---------------------- */

  /**
   * Tell every region that the allocation map moved.  Coalesced, because
   * allocation changes arrive one shard at a time and a fresh cluster places
   * every shard at once — one broadcast per shard would be pure noise for the
   * DevTools panel and for any application listener.
   */
  private scheduleShardMapPublish(): void {
    if (this.shardMapPublishTimer) return;
    this.shardMapPublishTimer = this.system.scheduler.scheduleOnceFunction(
      SHARD_MAP_PUBLISH_DELAY_MS,
      () => { this.shardMapPublishTimer = null; this.publishShardMap(); },
    );
  }

  private publishShardMap(): void {
    if (!this.isActive()) return;
    const update: ShardMapUpdate = {
      kind: 'sharding.ShardMapUpdate',
      typeName: this.options.typeName,
      version: ++this.shardMapVersion,
      shards: Array.from(this.shardHome.entries()),
      regions: Array.from(this.regions.entries()).map(([key, info]) => ({
        key,
        address: info.node.toString(),
        path: info.path,
        proxy: info.proxy,
        shardCount: info.shards.size,
      })),
    };
    // Proxies included: they route for this type and a panel on a proxy-only
    // node has as much reason to render the map as one anywhere else.
    for (const key of this.regions.keys()) this.sendToRegion(key, update);
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
      // The modulus every id above was produced under, so the next leader can
      // tell whether the map means anything to it — see `loadCoordinatorState`.
      numShards: this.options.numShards,
    };
  }

  /* ------------------------------- Rebalance ------------------------------- */

  /**
   * One voluntary rebalance pass, bounded by the configured ceiling (#850).
   *
   * The bound lives here rather than in an `AllocationStrategy` because
   * only one strategy in the tree caps itself, and it is not the default one:
   * `ClusterSharding.ensureCoordinator` wires {@link HashAllocationStrategy},
   * which returns *every* shard whose `shardId % candidates.length` no longer
   * matches its owner — 42 of the shipped 64 when a third node joins.  A cap
   * inside a strategy would also say nothing about a user-supplied one.
   *
   * The budget subtracts what is already in flight, which is what makes this a
   * bound on *concurrency* rather than on batch size.  Both shipped strategies
   * skip shards in `rebalanceInProgress`, so a per-tick-only cap would simply
   * stack: the tick fires every `rebalanceIntervalMs` (2 s) while a hand-off
   * may stand for a whole `handOffTimeoutMs` (10 s), so a per-tick six would
   * admit roughly thirty at once.
   *
   * Nothing is dropped — whatever the budget leaves behind the strategy
   * proposes again on the next tick, so the cluster still converges, just over
   * more ticks.
   */
  private rebalanceTick(): void {
    // Before the strategy is consulted, so a shard whose owner has just been
    // declared gone is re-homed on this tick rather than being proposed for a
    // voluntary move away from a region that no longer exists.
    this.sweepStaleRegions();
    const shardsToMove = this.options.allocationStrategy.rebalance(
      this.currentShardCounts(),
      this.candidates(),
      new Set(this.rebalanceInProgress.keys()),
    );
    const budget = this.rebalanceCeiling() - this.rebalanceInProgress.size;
    if (budget <= 0) return;
    for (const shardId of this.shardsWithinBudget(shardsToMove, budget)) this.beginHandOff(shardId);
  }

  /**
   * Evict every registered region that has gone silent (#853).
   *
   * The gap this closes is narrow and worth naming precisely, because the
   * obvious one is already covered: a node that stops gossiping is force-downed
   * by the failure detector at `down-after` (5 s by default, and it cannot be
   * switched off), which emits `MemberRemoved`, which this coordinator already
   * turns into an eviction.  What nothing covered is a region that is gone or
   * wedged on a node that is **still up and heartbeating** — #648's
   * `RegionTerminated` is single-shot, unacknowledged, and its send error is
   * swallowed on the way down, and `candidates()` is derived from the registry
   * with no liveness check, so a lost one left the shards allocated to an actor
   * that does not exist, permanently.
   *
   * Three properties, each of which is the difference between a backstop and a
   * new failure mode:
   *
   * - **It rides the existing rebalance tick**, inside the `isActive()` guard
   *   that tick already carries.  A passive coordinator must not evict regions
   *   it does not own, and a second timer would have needed its own copy of
   *   that guard as well as its own key.
   * - **Only a region that has beaten is a candidate** — see
   *   {@link RegionInfo.lastHeartbeatAtMs}.
   * - **Eviction goes through {@link onRegionTerminated}**, the same
   *   synthesised-frame path `onMemberRemoved` uses.  It bypasses `maySpeakFor`
   *   deliberately: the message is built here from this coordinator's own
   *   state, not from anything a peer said, and reusing it is what keeps
   *   eviction, reallocation and `afterShardMapChange` in one place instead of
   *   two that can drift.  A region that already sent its own
   *   `RegionTerminated` is gone from `regions`, so the sweep cannot
   *   double-evict it.
   */
  private sweepStaleRegions(): void {
    if (!this.options.staleRegionDetection) return;
    const staleAfterMs = this.options.regionStaleAfterMs ?? DEFAULT_REGION_STALE_AFTER_MS;
    const now = Date.now();
    // Snapshotted: `onRegionTerminated` deletes from the map being walked.
    for (const info of Array.from(this.regions.values())) {
      if (info.lastHeartbeatAtMs === null) continue;
      const silentForMs = now - info.lastSeenAtMs;
      if (silentForMs < staleAfterMs) continue;
      this.log.warn(
        `[sharding] region ${info.path} on ${info.node} has not been heard from for `
        + `${silentForMs} ms (stale-after ${staleAfterMs} ms) while its node is still in the cluster; `
        + `re-homing the ${info.shards.size} shard(s) of type "${this.options.typeName}" it held`,
      );
      this.onRegionTerminated({
        kind: 'sharding.RegionTerminated',
        region: info.path,
        node: info.node.toJSON(),
      });
    }
  }

  /**
   * Shards that may be in flight at once, or `Infinity` when both limits are
   * off — the pre-#850 behaviour, and the only way to express it.
   *
   * Where both are set the lower wins, and the result never floors below one:
   * `0.1 × 8` truncates to zero, and a cluster that can never move a single
   * shard does not rebalance at all rather than rebalancing slowly.
   */
  private rebalanceCeiling(): number {
    const absolute = this.options.rebalanceAbsoluteLimit ?? DEFAULT_REBALANCE_ABSOLUTE_LIMIT;
    const relative = this.options.rebalanceRelativeLimit ?? DEFAULT_REBALANCE_RELATIVE_LIMIT;
    const fromAbsolute = absolute > 0 ? absolute : Number.POSITIVE_INFINITY;
    const fromRelative = relative > 0
      ? Math.floor(relative * this.options.numShards)
      : Number.POSITIVE_INFINITY;
    const ceiling = Math.min(fromAbsolute, fromRelative);
    return Number.isFinite(ceiling) ? Math.max(1, ceiling) : Number.POSITIVE_INFINITY;
  }

  /**
   * Which `budget` of the proposed shards go first — **round-robin across their
   * current owners**, owners in address order and each owner's shards in id
   * order.
   *
   * Order matters as soon as a ceiling bites, and the obvious answer is wrong.
   * `HashAllocationStrategy` builds its set by iterating `currentShardCounts()`,
   * a map keyed by node address in region-registration order, so taking the
   * first `budget` entries would drain whichever node happens to sort first and
   * leave the others untouched for as many ticks as that takes — a ceiling that
   * empties one node is worse than no ceiling.  Sorting by shard id has the
   * same failure whenever ownership runs in id blocks.
   *
   * Round-robin is also fully determined by the shard map, so the same map
   * always yields the same hand-offs — an operator can predict it, and a test
   * can pin it.
   */
  private shardsWithinBudget(shardsToMove: ReadonlySet<number>, budget: number): number[] {
    const byOwner = new Map<string, number[]>();
    for (const shardId of shardsToMove) {
      const ownerKey = this.shardHome.get(shardId);
      // No home means nothing to hand off; `beginHandOff` would bail anyway,
      // and counting it against the budget would waste a slot.
      if (ownerKey === undefined) continue;
      const owned = byOwner.get(ownerKey);
      if (owned) owned.push(shardId);
      else byOwner.set(ownerKey, [shardId]);
    }
    const queues = Array.from(byOwner.entries())
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, shardIds]) => shardIds.sort((left, right) => left - right));

    const picked: number[] = [];
    for (let round = 0; picked.length < budget; round++) {
      let progressed = false;
      for (const queue of queues) {
        if (round >= queue.length) continue;
        progressed = true;
        picked.push(queue[round]!);
        if (picked.length >= budget) break;
      }
      if (!progressed) break;
    }
    return picked;
  }

  private beginHandOff(shardId: number): void {
    const ownerKey = this.shardHome.get(shardId);
    if (!ownerKey) return;
    const owner = this.regions.get(ownerKey);
    if (!owner) return;

    const timeout = this.options.handOffTimeoutMs ?? DEFAULT_HAND_OFF_TIMEOUT_MS;
    const timer = this.system.scheduler.scheduleOnceFunction(timeout, () => {
      if (this.rebalanceInProgress.delete(shardId)) {
        this.system.log.warn(`[sharding] handoff timeout for shard ${shardId}; forcing reallocate`);
        this.shardHome.delete(shardId);
        this.tryAllocate(shardId);
      }
    });
    this.rebalanceInProgress.set(shardId, { from: ownerKey, timer });
    this.sendToRegion(ownerKey, { kind: 'sharding.HandOff', shardId });
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
    for (const pendingQuery of pending) {
      this.replyTo(pendingQuery.requester, pendingQuery.requesterNode, {
        kind: 'sharding.ShardHome',
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
      kind: 'sharding.RememberedEntities',
      shardId,
      entityIds: Array.from(set),
    });
  }

  private sendToRegion(key: string, message: ShardingMessage): void {
    const info = this.regions.get(key);
    if (!info) return;
    this.replyTo(info.path, info.node.toJSON(), message);
  }

  /**
   * Every reply here goes to a region, and a region only honours a
   * coordinator directive that arrives inside an
   * {@link AuthenticatedShardingMessage} naming the coordinator's node (#584).
   * The remote leg gets that for free — the receiving node's per-path envelope
   * handler stamps the connection's peer on the way in — but a bare local
   * `ref.tell` is byte-identical to what an attacker's frame produces after the
   * generic path walk, so the local leg has to build the wrapper itself.
   * Without it a single-node cluster could not rebalance at all.
   */
  private replyTo(path: string, nodeData: NodeAddressData, message: ShardingMessage): void {
    const node = NodeAddress.fromJSON(nodeData);
    if (node.equals(this.options.cluster.selfAddress)) {
      const ref = this.options.localResolver(path) as
        ActorRef<ShardingMessage | AuthenticatedShardingMessage> | null;
      if (ref) ref.tell(new AuthenticatedShardingMessage(this.options.cluster.selfAddress, message));
      return;
    }
    const remote = new RemoteActorRef<ShardingMessage>(node, path, this.options.cluster);
    remote.tell(message);
  }
}
