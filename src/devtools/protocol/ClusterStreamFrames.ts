/**
 * Payloads of the `cluster` stream (#204) — a wire projection of
 * `ClusterEvents` plus the coordinator's shard maps.
 *
 * `Member` and the event classes are not serialisable as-is (they hold
 * `NodeAddress` objects and `Set`s), so the tap flattens them into the
 * plain shapes below.  The names mirror the runtime events one-to-one
 * to keep the mapping obvious.
 */

/** Membership status, mirrored from `MemberStatus`. */
export type ClusterMemberStatus =
  | 'joining'
  | 'weakly-up'
  | 'up'
  | 'unreachable'
  | 'leaving'
  | 'down'
  | 'removed';

/** One cluster member. */
export interface ClusterMemberInfo {
  /** `<systemName>@<host>:<port>`. */
  readonly address: string;
  readonly status: ClusterMemberStatus;
  readonly roles: ReadonlyArray<string>;
  readonly version: number;
  /** True for the node serving these DevTools. */
  readonly isSelf: boolean;
  /** When this member was last seen in the live membership. */
  readonly lastSeenAtMs: number;
  /**
   * The member is no longer in the membership at all, and is listed from
   * memory.
   *
   * A node that drops out is exactly the one you want to look at, and it
   * used to vanish from the panel at the moment it became interesting.
   * Retained entries age out after {@link CLUSTER_MEMBER_RETENTION_MS}.
   */
  readonly gone: boolean;
}

/**
 * How long a departed member stays listed.
 *
 * An hour, because the question "what happened to that node?" is often
 * asked long after it happened — by someone who was in a meeting when
 * the alert fired.
 */
export const CLUSTER_MEMBER_RETENTION_MS = 60 * 60 * 1000;

/** Where one shard currently lives. */
export interface ShardAssignment {
  readonly shard: number;
  readonly regionKey: string;
}

/** Shard distribution of one sharded entity type. */
export interface ShardMapInfo {
  readonly typeName: string;
  readonly leader: string;
  readonly takenAtMs: number;
  readonly regions: ReadonlyArray<ShardRegionInfo>;
  readonly shardHome: ReadonlyArray<ShardAssignment>;
}

/** One shard region participating in a sharded type. */
export interface ShardRegionInfo {
  readonly key: string;
  readonly address: string;
  readonly path: string;
  readonly proxy: boolean;
  readonly shardCount: number;
}

/** Names of the runtime `ClusterEvent` classes, as sent over the wire. */
export type ClusterEventName =
  | 'self-up'
  | 'self-removed'
  | 'leader-changed'
  | 'member-joined'
  | 'member-up'
  | 'member-weakly-up'
  | 'member-unreachable'
  | 'member-reachable'
  | 'member-down'
  | 'member-left'
  | 'member-removed'
  | 'shard-map-changed';

/** Full topology, sent once per `cluster` subscription. */
export interface ClusterSnapshotPayload {
  readonly kind: 'cluster-snapshot';
  readonly atMs: number;
  readonly selfAddress: string;
  readonly leader: string | null;
  readonly members: ReadonlyArray<ClusterMemberInfo>;
  readonly shardMaps: ReadonlyArray<ShardMapInfo>;
}

/** A membership / leadership transition. */
export interface ClusterEventPayload {
  readonly kind: 'cluster-event';
  readonly atMs: number;
  readonly event: ClusterEventName;
  /** Subject of the event — absent for `leader-changed`. */
  readonly member?: ClusterMemberInfo;
  /** New leader address — only for `leader-changed`. */
  readonly leader?: string | null;
}

/** The coordinator republished a shard map. */
export interface ShardMapChangedPayload {
  readonly kind: 'shard-map-changed';
  readonly atMs: number;
  readonly shardMap: ShardMapInfo;
}

/** Payloads carried by the `cluster` stream. */
export type ClusterStreamPayload =
  | ClusterSnapshotPayload
  | ClusterEventPayload
  | ShardMapChangedPayload;

/** @internal */
export function clusterSnapshotPayload(
  atMs: number,
  selfAddress: string,
  leader: string | null,
  members: ReadonlyArray<ClusterMemberInfo>,
  shardMaps: ReadonlyArray<ShardMapInfo>,
): ClusterSnapshotPayload {
  return { kind: 'cluster-snapshot', atMs, selfAddress, leader, members, shardMaps };
}

/** @internal */
export function clusterEventPayload(
  atMs: number,
  event: ClusterEventName,
  member?: ClusterMemberInfo,
  leader?: string | null,
): ClusterEventPayload {
  const payload: ClusterEventPayload = { kind: 'cluster-event', atMs, event };
  return {
    ...payload,
    ...(member === undefined ? {} : { member }),
    ...(leader === undefined ? {} : { leader }),
  };
}

/** @internal */
export function shardMapChangedPayload(atMs: number, shardMap: ShardMapInfo): ShardMapChangedPayload {
  return { kind: 'shard-map-changed', atMs, shardMap };
}
