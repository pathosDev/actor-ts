/**
 * The `cluster` stream (#204) — topology and membership history.
 *
 * Uses `cluster.subscribe`, not the event stream: only the direct
 * listener replays current state on subscribe, so a panel opened ten
 * minutes into a run still renders the cluster as it actually is
 * instead of waiting for the next membership change.
 *
 * Shard maps arrive through `ShardMapChanged`.  There is no way to
 * enumerate sharded types up front — the framework never registers them
 * centrally — so the tap learns each type the first time the
 * coordinator republishes it.  A freshly opened panel therefore shows
 * shards from the first republish onwards, which is at most one
 * coordinator tick away.  The event carries the region table alongside
 * the assignment map, so the panel renders both without having to read
 * the coordinator's DistributedData snapshot the way the management
 * endpoint does.
 */
import type { Cluster } from '../../cluster/Cluster.js';
import type { Member } from '../../cluster/Member.js';
import {
  CurrentClusterState,
  LeaderChanged,
  MemberDown,
  MemberJoined,
  MemberLeft,
  MemberReachable,
  MemberRemoved,
  MemberUnreachable,
  MemberUp,
  MemberWeaklyUp,
  ReachabilityChanged,
  SelfRemoved,
  SelfUp,
  ShardMapChanged,
  type ClusterEvent,
} from '../../cluster/ClusterEvents.js';
import { match, P } from 'ts-pattern';
import {
  clusterEventPayload,
  clusterSnapshotPayload,
  shardMapChangedPayload,
  type ClusterEventName,
  type ClusterMemberInfo,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
  type ShardMapInfo,
} from '../protocol/index.js';
import type { ActorSystem } from '../../ActorSystem.js';
import type { Cancellable } from '../../Scheduler.js';
import type { DevToolsTap } from '../DevToolsServer.js';
import type { ClusterMembership } from '../internal/ClusterMembership.js';

/** How often departed members are checked for expiry. */
const SWEEP_INTERVAL_MS = 30_000;

/** Constructor of one of the member-carrying cluster events. */
type MemberEventClass = new (member: Member) => { readonly member: Member };

/** Constructor identity → wire name, for the structurally identical family. */
const MEMBER_EVENT_NAMES = new Map<MemberEventClass, ClusterEventName>([
  [SelfUp, 'self-up'],
  [SelfRemoved, 'self-removed'],
  [MemberJoined, 'member-joined'],
  [MemberUp, 'member-up'],
  [MemberWeaklyUp, 'member-weakly-up'],
  [MemberUnreachable, 'member-unreachable'],
  [MemberReachable, 'member-reachable'],
  [MemberDown, 'member-down'],
  [MemberLeft, 'member-left'],
  [MemberRemoved, 'member-removed'],
]);

export class ClusterTap implements DevToolsTap {
  readonly stream: DevToolsStreamId = 'cluster';

  private emit: ((payload: DevToolsStreamPayload) => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private sweeper: Cancellable | null = null;
  /** Latest shard map per sharded type, as learned from events. */
  private readonly shardMaps = new Map<string, ShardMapInfo>();
  constructor(
    private readonly cluster: Cluster,
    private readonly system: ActorSystem,
    /**
     * Shared with the overview.  Two memories of who is in the cluster
     * disagreed the moment a node left: this panel kept it listed while
     * the overview counted only the living.
     */
    private readonly membership: ClusterMembership,
  ) {}

  install(emit: (payload: DevToolsStreamPayload) => void): void {
    this.emit = emit;
    this.sweeper = this.system.scheduler.scheduleAtFixedRateFunction(
      SWEEP_INTERVAL_MS,
      SWEEP_INTERVAL_MS,
      () => this.sweep(),
    );
    // Snapshot replay, so the current membership arrives as one event this tap
    // discards rather than as a burst of member events it would forward to
    // every client (#161).  This used to be a `replaying` flag around the
    // subscribe call — correct only because the replay happens to be
    // synchronous, and silently wrong the day it stops being.
    this.unsubscribe = this.cluster.subscribe(
      (event) => this.onClusterEvent(event),
      { replayMode: 'snapshot' },
    );
  }

  uninstall(): void {
    this.sweeper?.cancel();
    this.sweeper = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.emit = null;
  }

  snapshot(): ReadonlyArray<DevToolsStreamPayload> {
    return [this.currentSnapshot()];
  }

  /** Live membership, plus everyone recently in it. */
  private currentSnapshot(): DevToolsStreamPayload {
    const now = Date.now();
    return clusterSnapshotPayload(
      now,
      this.cluster.selfAddress.toString(),
      this.cluster.leader().fold(() => null as string | null, (m) => m.address.toString()),
      this.membership.members(now),
      [...this.shardMaps.values()],
    );
  }

  /** Re-state the list when a retained member ages out of it. */
  private sweep(): void {
    const before = this.membership.members().length;
    this.membership.refresh();
    if (this.membership.members().length !== before) this.emit?.(this.currentSnapshot());
  }

  private onClusterEvent(event: ClusterEvent): void {
    match(event)
      .with(P.instanceOf(LeaderChanged), (e) => this.onLeaderChanged(e))
      .with(P.instanceOf(ShardMapChanged), (e) => this.onShardMapChanged(e))
      .with(P.instanceOf(CurrentClusterState), () => this.onCurrentClusterState())
      .with(P.instanceOf(ReachabilityChanged), (e) => this.onReachabilityChanged(e))
      .otherwise((e) => this.onMemberEvent(e));
  }

  /**
   * The ten member events are structurally identical — every one is
   * `{ member: Member }` — so neither TypeScript nor `ts-pattern` can
   * tell them apart in the union, and only the constructor identity
   * carries the distinction.  Hence a lookup rather than ten arms.
   */
  private onMemberEvent(
    event: Exclude<
      ClusterEvent,
      LeaderChanged | ShardMapChanged | CurrentClusterState | ReachabilityChanged
    >,
  ): void {
    const name = MEMBER_EVENT_NAMES.get(event.constructor as MemberEventClass);
    if (name === undefined) {
      this.onUnknownEvent();
      return;
    }
    this.emit?.(clusterEventPayload(Date.now(), name, this.toMemberInfo(event.member)));
    // Membership moved, so re-state the whole list.  Events alone tell a
    // client what changed but not that a departed node is still being
    // remembered, which is the point of keeping it.
    this.emit?.(this.currentSnapshot());
  }

  private onLeaderChanged(event: LeaderChanged): void {
    const leader = event.leader.fold(() => null as string | null, (m) => m.address.toString());
    this.emit?.(clusterEventPayload(Date.now(), 'leader-changed', undefined, leader));
  }

  /**
   * The subscription's own replay.  Nothing to forward: no client is attached
   * when `install` runs, and every one that attaches later is handed the same
   * membership by {@link snapshot}, read from the cluster at that moment rather
   * than from whatever it looked like when the server started.
   */
  private onCurrentClusterState(): void {}

  /**
   * The serving node's failure detector gained or lost sight of a peer.
   *
   * Carried with the member so the panel has a subject to name, and because the
   * pair is the point: `status` is what the cluster agrees on, `reachable` is
   * what this node sees, and the two disagreeing is what a partition looks like
   * from inside one.
   */
  private onReachabilityChanged(event: ReachabilityChanged): void {
    const member = this.cluster
      .getMembers()
      .find((candidate) => candidate.address.equals(event.address));
    this.emit?.(clusterEventPayload(
      Date.now(),
      'reachability-changed',
      member === undefined ? undefined : this.toMemberInfo(member),
      undefined,
      event.reachable,
    ));
  }

  private onShardMapChanged(event: ShardMapChanged): void {
    const shardMap: ShardMapInfo = {
      typeName: event.type,
      leader: this.cluster.leader().fold(() => '', (m) => m.address.toString()),
      takenAtMs: Date.now(),
      regions: event.regions.map((region) => ({
        key: region.key,
        address: region.address,
        path: region.path,
        proxy: region.proxy,
        shardCount: region.shardCount,
      })),
      shardHome: [...event.shards].map(([shard, regionKey]) => ({ shard, regionKey })),
    };
    this.shardMaps.set(event.type, shardMap);
    this.emit?.(shardMapChangedPayload(Date.now(), shardMap));
  }

  /** A cluster event added after this build — ignore it. */
  private onUnknownEvent(): void {}

  private toMemberInfo(member: Member): ClusterMemberInfo {
    return {
      address: member.address.toString(),
      status: member.status,
      roles: [...member.roles],
      version: member.version,
      isSelf: member.address.equals(this.cluster.selfAddress),
      lastSeenAtMs: Date.now(),
      gone: false,
    };
  }
}
