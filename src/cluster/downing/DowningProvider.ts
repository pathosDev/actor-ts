import type { Member } from '../Member.js';
import type { NodeAddress } from '../NodeAddress.js';

export type ClusterPartitionView = {
  /** All members the local node currently knows about. */
  readonly allMembers: ReadonlyArray<Member>;
  /** Subset of `allMembers` this node considers unreachable. */
  readonly unreachable: ReadonlySet<string>; // addr.toString() keys
  /** This node's own address. */
  readonly self: NodeAddress;
};

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

  /**
   * Called once when this node leaves its cluster, after the failure-detector
   * tick that calls {@link decide} has been cancelled: give back whatever the
   * provider holds, so a node that left keeps no claim and arms nothing.  A
   * lease-majority resolver releases its lease here (#1454).
   *
   * Both ways of leaving call it: `Cluster.leave()`, and the leave at once of a
   * node its own decision downed or that gave its join up.  Optional, because
   * a strategy that holds nothing has nothing to give back.  A hook that throws
   * or rejects is logged, and the leave goes on without it.
   */
  shutdown?(): Promise<void>;
}

/** Helper — `address.toString()` used as map keys consistently. */
export function addrKey(member: Member): string {
  return member.address.toString();
}
