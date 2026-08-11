import { Member } from './Member.js';
import type { NodeAddress } from './NodeAddress.js';
import type { Option } from '../util/Option.js';

/* -------------------------------- Self events ------------------------------ */

/** Fired on the local node when its own member transitions to Up. */
export class SelfUp { constructor(public readonly member: Member) {} }

/**
 * Fired on the local node when its own member has been removed.
 * After this event fires, the local cluster instance is effectively
 * dead — call `system.terminate()` to clean up.  The tombstone
 * behaviour described on {@link MemberRemoved} also applies: peers
 * keep this node's address as a `removed` tombstone until their
 * `tombstoneTtlMs` (default 24 h) expires (#75).
 */
export class SelfRemoved { constructor(public readonly member: Member) {} }

/** Fired on the local node when the cluster leader has changed. */
export class LeaderChanged {
  constructor(public readonly leader: Option<Member>) {}
}

/* --------------------------- Subscription snapshot ------------------------- */

/**
 * The cluster as it stands at the moment of subscription — the single event a
 * `replayMode: 'snapshot'` subscriber receives before the live stream starts
 * (#161).
 *
 * The other replay form (`'events'`, still the default) states the same
 * membership as the events that would have produced it: one `MemberJoined` per
 * member plus the status event each has already reached.  That form suits a
 * listener that only reacts to deltas, because it needs no separate
 * initial-state branch; it costs one callback per member, and it never says
 * where the replay ends.  This one is the opposite trade, and the reason it
 * exists.
 *
 * `unreachable` is a **subset** of `members`, not a disjoint set: an
 * unreachable peer is still a member, and excluding it would make
 * `members.length` mean something different depending on the cluster's health.
 *
 * There is no `seenBy`.  Akka's is the set of members that have observed the
 * current gossip version, which presumes a versioned whole; gossip here merges
 * member records individually, so there is no such version to have been seen.
 *
 * Never published on the event stream: it describes one subscriber's starting
 * point, not something that happened to the cluster.
 */
export class CurrentClusterState {
  constructor(
    /** Every current member — tombstones excluded — in address order. */
    public readonly members: ReadonlyArray<Member>,
    /** The members of {@link members} whose status is `unreachable`. */
    public readonly unreachable: ReadonlyArray<Member>,
    public readonly leader: Option<Member>,
  ) {}
}

/* ------------------------------- Member events ----------------------------- */

/** A member was added to the cluster (first time we see it). */
export class MemberJoined { constructor(public readonly member: Member) {} }

/** A member transitioned to the Up state and is ready to receive work. */
export class MemberUp { constructor(public readonly member: Member) {} }

/** A joining member has been tentatively upgraded to WeaklyUp. */
export class MemberWeaklyUp { constructor(public readonly member: Member) {} }

/** Heartbeats have been missed; the member may still come back. */
export class MemberUnreachable { constructor(public readonly member: Member) {} }

/** Previously-unreachable member responded again. */
export class MemberReachable { constructor(public readonly member: Member) {} }

/**
 * This node's own failure detector changed its verdict about one peer (#161).
 *
 * Two things separate it from {@link MemberUnreachable} / {@link
 * MemberReachable}, and both matter when the question is *what can this node
 * actually see*:
 *
 * - **It is always a local observation.**  Member status travels in gossip, so
 *   `MemberUnreachable` also fires for a peer that *someone else* has stopped
 *   hearing from while this node's own heartbeats to it arrive normally.
 * - **It does not depend on the member's status.**  `MemberUnreachable` is
 *   only emitted for a member that was `up`; a peer that falls silent while
 *   `joining`, `weakly-up` or `leaving` produces no reachability event at all,
 *   it simply gets downed later.
 *
 * Emitted on transition only, and never for a peer that has been healthy since
 * this node first saw it — the interesting edges are the fall and every
 * recovery after it.  The verdict is recomputed once per detector tick
 * (`heartbeatIntervalMs`) and turns negative at `unreachableAfterMs`, so this
 * fires well ahead of any downing decision.
 *
 * It carries no observer set.  *"Which other nodes also cannot reach X"* would
 * need an observer→subject table on the wire, and gossip carries a flat member
 * list — see #161 for the follow-up that would have to add one.
 */
export class ReachabilityChanged {
  constructor(
    public readonly address: NodeAddress,
    /** `true` when the detector has started hearing from the peer again. */
    public readonly reachable: boolean,
  ) {}
}

/** Confirmed down — taken out of the cluster and shards re-assigned. */
export class MemberDown { constructor(public readonly member: Member) {} }

/** Member is leaving gracefully (after calling cluster.leave()). */
export class MemberLeft { constructor(public readonly member: Member) {} }

/**
 * Member removed from the cluster.  Fires on two distinct paths:
 *
 *   - **Definitive removal** — `handleLeave` (peer sent `leave`)
 *     and `evaluateDowning` (force-down via a `DowningProvider`)
 *     mark the address as a **tombstone**: the entry stays in the
 *     local `members` map with `status === 'removed'` and a
 *     `removedAt` timestamp, so stale gossip from a slow peer
 *     can't resurrect the address.  The tombstone is reclaimed
 *     by `tombstonePruneTick` once `tombstoneTtlMs` (default 24 h)
 *     has elapsed — see #75 for the full lifecycle.
 *   - **FD-driven** — the failure detector's elapsed-time
 *     `unreachable → down → removed` cascade.  Here the entry is
 *     deleted outright (no tombstone) so a healed partition can
 *     re-discover the peer.
 *
 * Public APIs (`getMembers`, `upMembers`, `reachableMembers`) skip
 * `removed` entries, so most user code stays unaffected.  Code that
 * iterates the raw membership view directly should check
 * `member.status !== 'removed'` (or use `member.isReachable()`,
 * which already returns false for `removed`).  An attempt to
 * `Cluster.join` on the same `host:port` after `MemberRemoved` will
 * still work — the framework detects the new incarnation via
 * `mergeMember`'s wall-clock version epoch and supersedes the
 * tombstone.  See `tests/cluster.test.ts` → "a node that
 * gracefully left can rejoin on the same address".
 */
export class MemberRemoved { constructor(public readonly member: Member) {} }

/** One region participating in a sharded type, as carried by {@link ShardMapChanged}. */
export type ShardMapRegion = {
  /** `<node>|<path>` — the same key the coordinator uses in the shard map. */
  readonly key: string;
  readonly address: string;
  readonly path: string;
  readonly proxy: boolean;
  readonly shardCount: number;
};

/**
 * Shard ownership map recomputed.  Published by every node's region whenever
 * the coordinator reallocates, so a listener sees the same map wherever it
 * subscribes — the coordinator itself only runs on the leader.
 *
 * Bursty by nature (a fresh cluster places every shard at once), so the
 * coordinator coalesces a burst into one broadcast; `version` counts
 * broadcasts, not individual assignments.
 */
export class ShardMapChanged {
  constructor(
    public readonly type: string,
    /** shardId → region key. */
    public readonly shards: ReadonlyMap<number, string>,
    public readonly version: number,
    public readonly regions: ReadonlyArray<ShardMapRegion> = [],
  ) {}
}

export type ClusterEvent =
  | SelfUp
  | SelfRemoved
  | LeaderChanged
  | CurrentClusterState
  | MemberJoined
  | MemberUp
  | MemberWeaklyUp
  | MemberUnreachable
  | MemberReachable
  | ReachabilityChanged
  | MemberDown
  | MemberLeft
  | MemberRemoved
  | ShardMapChanged;
