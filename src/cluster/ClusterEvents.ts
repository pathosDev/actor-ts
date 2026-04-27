import { Member } from './Member.js';
import type { Option } from '../util/Option.js';

/* -------------------------------- Self events ------------------------------ */

/** Fired on the local node when its own member transitions to Up. */
export class SelfUp { constructor(public readonly member: Member) {} }

/** Fired on the local node when its own member has been removed. */
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

/** Member removed from the cluster entirely. */
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
