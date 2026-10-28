import { NodeAddress } from '../NodeAddress.js';

/**
 * Instructs the ShardCoordinator how to place and rebalance shards.
 *
 * `allocate` is called when a shard needs a new home — right after it is
 * first requested, once a hand-off has completed, and when its region is gone.
 * `rebalance` is called periodically so strategies can move shards away from
 * busy nodes.
 *
 * **The call protocol (#1467).**  The coordinator never places a shard on a
 * region whose member is not `up`, and it tracks how long the set of regions
 * whose member is up — the *eligible* regions — has held still:
 *
 * - While that set is **settling**, `allocate` may be asked **twice** for one
 *   shard: first with every registered region that could host the type and
 *   the shards every registered region holds — where the shard would go with
 *   everyone in view — and, only when it picks one whose member is not up,
 *   again with the eligible regions alone and their shards.  `rebalance` is
 *   not called at all.
 * - Once the set has held still for the settle window — failure-detector
 *   `down-after`, or the split-brain resolver's `stable-after` when a resolver
 *   is configured and that is longer — `allocate` is asked **once**, with the
 *   eligible regions and their shards, and `rebalance` is called with the
 *   eligible regions as candidates and the shards of every region whose
 *   member is up.  That map is wider than the candidates: it also lists a
 *   region that is registered on an up member but is no candidate — refused
 *   over its shard count, or without the type's role — so that its shards
 *   can be proposed for a move onto a candidate.
 *
 * Either way a pick outside the candidates a call was given is not placed — the
 * coordinator logs it at warn, once per shard until that shard is placed — and
 * a `rebalance` proposal for a shard whose current owner's member is not up is
 * dropped.  So an `allocate` call is a question, not a placement: a strategy
 * that keeps state must not count one as a shard having landed anywhere.
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
 * Hash-based: allocate by modulo on the sorted candidate list.  Simple and
 * deterministic, but **not** minimal: a shard's owner is its id modulo the
 * number of candidates, so a candidate set that changes size moves most shards
 * at once — 16 of 24 when three candidates become two, 42 of 64 when two
 * become three.  The coordinator's rebalance ceiling bounds how many of them
 * move concurrently, not how many move in total.
 */
export class HashAllocationStrategy implements AllocationStrategy {
  /**
   * `currentShards` is declared and ignored: hashing needs only the
   * candidate list.  Leaving the parameter off still satisfies
   * `implements AllocationStrategy`, but the class is exported from
   * `src/cluster/index.ts`, so a caller holding the concrete type got
   * `Expected 2 arguments, but got 3` on the three-argument call the
   * interface — and every other strategy — documents (#540).
   */
  allocate(
    shardId: number,
    candidates: ReadonlyArray<NodeAddress>,
    _currentShards?: ReadonlyMap<string, ReadonlySet<number>>,
  ): NodeAddress {
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
    for (const candidate of candidates) {
      const load = currentShards.get(candidate.toString())?.size ?? 0;
      if (load < bestLoad || (load === bestLoad && candidate.compareTo(best) < 0)) {
        best = candidate; bestLoad = load;
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

    // Only the candidates' loads count.  The coordinator hands `rebalance` the
    // eligible regions — those whose member is up — as candidates, and its map
    // may also list a region on an up member that is no candidate; that one is
    // not weighed here, so this strategy never proposes moving its shards.
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
