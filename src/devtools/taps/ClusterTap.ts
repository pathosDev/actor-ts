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
 * coordinator tick away.
 */
import type { Cluster } from '../../cluster/Cluster.js';
import type { Member } from '../../cluster/Member.js';
import {
  LeaderChanged,
  MemberDown,
  MemberJoined,
  MemberLeft,
  MemberReachable,
  MemberRemoved,
  MemberUnreachable,
  MemberUp,
  MemberWeaklyUp,
  SelfRemoved,
  SelfUp,
  ShardMapChanged,
  type ClusterEvent,
} from '../../cluster/ClusterEvents.js';
import { match, P } from 'ts-pattern';
import {
  CLUSTER_MEMBER_RETENTION_MS,
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
  /**
   * Every member seen since attach, live or not.
   *
   * Kept on the server rather than in the browser so the record survives
   * a page reload — the reload usually happens *because* something went
   * wrong, which is the worst moment to forget which node left.
   */
  private readonly seen = new Map<string, ClusterMemberInfo>();

  constructor(
    private readonly cluster: Cluster,
    private readonly system: ActorSystem,
  ) {}

  install(emit: (payload: DevToolsStreamPayload) => void): void {
    this.emit = emit;
    this.sweeper = this.system.scheduler.scheduleAtFixedRateFunction(
      SWEEP_INTERVAL_MS,
      SWEEP_INTERVAL_MS,
      () => this.sweep(),
    );
    // Subscribing replays the current membership, which would otherwise
    // be re-emitted to every client as events.  Swallow that initial
    // burst: `snapshot()` already gives a new subscriber the same
    // information in one frame.
    let replaying = true;
    this.unsubscribe = this.cluster.subscribe((event) => {
      if (replaying) return;
      this.onClusterEvent(event);
    });
    replaying = false;
  }

  uninstall(): void {
    this.sweeper?.cancel();
    this.sweeper = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.seen.clear();
    this.emit = null;
  }

  snapshot(): ReadonlyArray<DevToolsStreamPayload> {
    return [this.currentSnapshot()];
  }

  /**
   * Live membership, plus everyone recently in it.
   *
   * Refreshed from the cluster each time rather than accumulated from
   * events alone: the cluster's own view is authoritative, and rebuilding
   * from it means a missed event cannot leave a ghost behind.
   */
  private currentSnapshot(): DevToolsStreamPayload {
    const now = Date.now();
    const live = new Set<string>();
    for (const member of this.cluster.getMembers()) {
      const info = this.toMemberInfo(member, now, false);
      live.add(info.address);
      this.seen.set(info.address, info);
    }
    for (const [address, info] of this.seen) {
      if (live.has(address) || info.gone) continue;
      this.seen.set(address, { ...info, gone: true });
    }
    this.sweep(now);

    return clusterSnapshotPayload(
      now,
      this.cluster.selfAddress.toString(),
      this.cluster.leader().fold(() => null as string | null, (m) => m.address.toString()),
      [...this.seen.values()],
      [...this.shardMaps.values()],
    );
  }

  /** Forget departed members once they are older than the retention. */
  private sweep(nowMs = Date.now()): void {
    let removed = false;
    for (const [address, info] of this.seen) {
      if (!info.gone || nowMs - info.lastSeenAtMs < CLUSTER_MEMBER_RETENTION_MS) continue;
      this.seen.delete(address);
      removed = true;
    }
    if (removed) this.emit?.(this.currentSnapshot());
  }

  private onClusterEvent(event: ClusterEvent): void {
    match(event)
      .with(P.instanceOf(LeaderChanged), (e) => this.onLeaderChanged(e))
      .with(P.instanceOf(ShardMapChanged), (e) => this.onShardMapChanged(e))
      .otherwise((e) => this.onMemberEvent(e));
  }

  /**
   * The ten member events are structurally identical — every one is
   * `{ member: Member }` — so neither TypeScript nor `ts-pattern` can
   * tell them apart in the union, and only the constructor identity
   * carries the distinction.  Hence a lookup rather than ten arms.
   */
  private onMemberEvent(event: Exclude<ClusterEvent, LeaderChanged | ShardMapChanged>): void {
    const name = MEMBER_EVENT_NAMES.get(event.constructor as MemberEventClass);
    if (name === undefined) {
      this.onUnknownEvent();
      return;
    }
    this.emit?.(clusterEventPayload(
      Date.now(), name, this.toMemberInfo(event.member, Date.now(), false),
    ));
    // Membership moved, so re-state the whole list.  Events alone tell a
    // client what changed but not that a departed node is still being
    // remembered, which is the point of keeping it.
    this.emit?.(this.currentSnapshot());
  }

  private onLeaderChanged(event: LeaderChanged): void {
    const leader = event.leader.fold(() => null as string | null, (m) => m.address.toString());
    this.emit?.(clusterEventPayload(Date.now(), 'leader-changed', undefined, leader));
  }

  private onShardMapChanged(event: ShardMapChanged): void {
    const shardMap: ShardMapInfo = {
      typeName: event.type,
      leader: this.cluster.leader().fold(() => '', (m) => m.address.toString()),
      takenAtMs: Date.now(),
      // The event carries shard → region-key only; the region detail the
      // management endpoint reads from DistributedData is not on this
      // path, so the panel renders the assignment map alone.
      regions: [],
      shardHome: [...event.shards].map(([shard, regionKey]) => ({ shard, regionKey })),
    };
    this.shardMaps.set(event.type, shardMap);
    this.emit?.(shardMapChangedPayload(Date.now(), shardMap));
  }

  /** A cluster event added after this build — ignore it. */
  private onUnknownEvent(): void {}

  private toMemberInfo(member: Member, nowMs: number, gone: boolean): ClusterMemberInfo {
    return {
      address: member.address.toString(),
      status: member.status,
      roles: [...member.roles],
      version: member.version,
      isSelf: member.address.equals(this.cluster.selfAddress),
      lastSeenAtMs: nowMs,
      gone,
    };
  }
}
