import { Member } from './Member.js';
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

/** Shard ownership map recomputed. */
export class ShardMapChanged {
  constructor(
    public readonly type: string,
    public readonly shards: ReadonlyMap<number, string>,
    public readonly version: number,
  ) {}
}

export type ClusterEvent =
  | SelfUp
  | SelfRemoved
  | LeaderChanged
  | MemberJoined
  | MemberUp
  | MemberWeaklyUp
  | MemberUnreachable
  | MemberReachable
  | MemberDown
  | MemberLeft
  | MemberRemoved
  | ShardMapChanged;
