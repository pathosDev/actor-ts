import { NodeAddress } from '../NodeAddress.js';

/**
 * Instructs the ShardCoordinator how to place and rebalance shards.
 *
 * `allocate` is called when a shard needs a new home — e.g. right after it
 * is first requested.  `rebalance` is called periodically so strategies can
 * move shards away from busy nodes.
 */
export interface AllocationStrategy {
  /** Pick an owner for a newly-discovered shard. */
  allocate(shardId: number, candidates: ReadonlyArray<NodeAddress>, currentShards: ReadonlyMap<string, ReadonlySet<number>>): NodeAddress;

  /**
   * Return a set of shard ids that should be re-homed.  The coordinator
   * will send HandOff for each and then allocate() a new home once the
   * handoff completes.
   */
  rebalance(
    currentShards: ReadonlyMap<string, ReadonlySet<number>>,
    candidates: ReadonlyArray<NodeAddress>,
    rebalanceInProgress: ReadonlySet<number>,
  ): Set<number>;
}

/* --------------------------- Built-in strategies --------------------------- */

/**
 * Hash-based: allocate by modulo on the sorted candidate list.  Simple,
 * deterministic, minimal rebalance behaviour (only moves shards when the
 * candidate set changes).
 */
export class HashAllocationStrategy implements AllocationStrategy {
  allocate(shardId: number, candidates: ReadonlyArray<NodeAddress>): NodeAddress {
    if (candidates.length === 0) throw new Error('HashAllocationStrategy: no candidates');
    const sorted = [...candidates].sort((a, b) => a.compareTo(b));
    return sorted[shardId % sorted.length]!;
  }

  rebalance(
    currentShards: ReadonlyMap<string, ReadonlySet<number>>,
    candidates: ReadonlyArray<NodeAddress>,
    rebalanceInProgress: ReadonlySet<number>,
  ): Set<number> {
    // Find shards whose hashed owner is no longer their actual owner.
    const sorted = [...candidates].sort((a, b) => a.compareTo(b));
    if (sorted.length === 0) return new Set();
    const out = new Set<number>();
    for (const [addrStr, shards] of currentShards) {
      for (const shardId of shards) {
        if (rebalanceInProgress.has(shardId)) continue;
        const desired = sorted[shardId % sorted.length]!;
        if (desired.toString() !== addrStr) out.add(shardId);
      }
    }
    return out;
  }
}

/**
 * Pick the candidate currently hosting the fewest shards, breaking ties by
 * address order.  Over time this converges to a balanced distribution even
 * if the candidate set has changed repeatedly.
 *
 * @param rebalanceThreshold Minimum difference between the most- and least-loaded
 *        nodes before any shards are moved.  Avoids thrashing.
 * @param maxSimultaneousRebalance Cap on how many shards move in a single
 *        rebalance round.
 */
export class LeastShardAllocationStrategy implements AllocationStrategy {
  constructor(
    readonly rebalanceThreshold: number = 1,
    readonly maxSimultaneousRebalance: number = 3,
  ) {}

  allocate(
    _shardId: number,
    candidates: ReadonlyArray<NodeAddress>,
    currentShards: ReadonlyMap<string, ReadonlySet<number>>,
  ): NodeAddress {
    if (candidates.length === 0) throw new Error('LeastShardAllocationStrategy: no candidates');
    let best = candidates[0]!;
    let bestLoad = currentShards.get(best.toString())?.size ?? 0;
    for (const c of candidates) {
      const load = currentShards.get(c.toString())?.size ?? 0;
      if (load < bestLoad || (load === bestLoad && c.compareTo(best) < 0)) {
        best = c; bestLoad = load;
      }
    }
    return best;
  }

  rebalance(
    currentShards: ReadonlyMap<string, ReadonlySet<number>>,
    candidates: ReadonlyArray<NodeAddress>,
    rebalanceInProgress: ReadonlySet<number>,
  ): Set<number> {
    const out = new Set<number>();
    if (candidates.length < 2) return out;

    // Consider only candidate loads (others may be down or pre-Up).
    const loads: Array<[string, number, ReadonlySet<number>]> = candidates.map(c => [
      c.toString(),
      currentShards.get(c.toString())?.size ?? 0,
      currentShards.get(c.toString()) ?? new Set(),
    ]);
    loads.sort((a, b) => a[1] - b[1]);

    const [, min] = loads[0]!;
    const [, max] = loads[loads.length - 1]!;
    if (max - min < this.rebalanceThreshold) return out;

    // Drain from the busiest node(s) until budget is exhausted.
    let remaining = this.maxSimultaneousRebalance;
    for (let i = loads.length - 1; i >= 0 && remaining > 0; i--) {
      const load = loads[i]![1];
      if (load - min < this.rebalanceThreshold) break;
      for (const shardId of loads[i]![2]) {
        if (rebalanceInProgress.has(shardId)) continue;
        out.add(shardId);
        if (--remaining <= 0) break;
      }
    }
    return out;
  }
}
