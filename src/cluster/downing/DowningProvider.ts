import type { Member } from '../Member.js';
import type { NodeAddress } from '../NodeAddress.js';

export interface ClusterPartitionView {
  /** All members the local node currently knows about. */
  readonly allMembers: ReadonlyArray<Member>;
  /** Subset of `allMembers` this node considers unreachable. */
  readonly unreachable: ReadonlySet<string>; // addr.toString() keys
  /** This node's own address. */
  readonly self: NodeAddress;
}

/**
 * Decision from a downing strategy — the addresses (serialised as strings)
 * that should be forcibly downed.  An empty set means "do nothing, wait
 * for more information".
 */
export type DowningDecision = ReadonlySet<string>;

/**
 * Pluggable split-brain resolver.  Given the current partition view, pick
 * the set of nodes to mark down.  Strategies differ in how they break ties
 * (keep the majority, keep the oldest member, require an admin-defined
 * quorum, …).
 */
export interface DowningProvider {
  /**
   * Return addresses to forcibly down.  The empty set means "not yet —
   * wait for stability or more heartbeats".
   */
  decide(view: ClusterPartitionView): DowningDecision;
}

/** Helper — `address.toString()` used as map keys consistently. */
export function addrKey(member: Member): string {
  return member.address.toString();
}
