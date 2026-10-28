/**
 * `LeastShardAllocationStrategy` and the shards of a node that is no candidate
 * (#1467).
 *
 * The coordinator hands `rebalance` the shards of every registered region whose
 * member is up, with the eligible regions as candidates.  A region in that map
 * can be no candidate — refused over its shard count (#633), or on a member
 * without the type's role — and hold shards all the same.  The strategy used to
 * weigh the candidates' loads alone, so it never proposed those shards, and a
 * refused region went on being named their home: the split routing the refusal
 * exists to prevent.
 *
 * Pure strategy calls, no coordinator: what each answer is made of.  The
 * coordinator's side is `ShardPlacementReachability.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { LeastShardAllocationStrategy } from '../../../../src/cluster/sharding/AllocationStrategy.js';

const a = new NodeAddress('s', 'a', 1);
const b = new NodeAddress('s', 'b', 1);
/** A node the coordinator does not hand over as a candidate. */
const y = new NodeAddress('s', 'y', 1);
/** A second one, sorting after `y`. */
const z = new NodeAddress('s', 'z', 1);

function loadsOf(entries: ReadonlyArray<readonly [NodeAddress, ReadonlyArray<number>]>): Map<string, Set<number>> {
  return new Map(entries.map(([node, shardIds]) => [node.toString(), new Set(shardIds)]));
}

/** The answer in id order, so a case reads as a list. */
function sorted(shardIds: ReadonlySet<number>): number[] {
  return [...shardIds].sort((left, right) => left - right);
}

describe('LeastShardAllocationStrategy proposes the shards of a node that is no candidate (#1467)', () => {
  test('ahead of the threshold: candidates too level to balance still take them', () => {
    // A spread of 0 against a threshold of 5: balancing alone moves nothing.
    const strategy = new LeastShardAllocationStrategy(5, 10);
    const current = loadsOf([[a, [0]], [b, [1]], [y, [2, 3]]]);

    expect(sorted(strategy.rebalance(current, [a, b], new Set()))).toEqual([2, 3]);
  });

  test('with a single candidate, which has no one to balance against', () => {
    const strategy = new LeastShardAllocationStrategy(1, 10);
    const current = loadsOf([[a, [0, 1]], [y, [2, 3]]]);

    expect(sorted(strategy.rebalance(current, [a], new Set()))).toEqual([2, 3]);
  });

  test('counted against maxSimultaneousRebalance, in address order and then shard order', () => {
    const strategy = new LeastShardAllocationStrategy(1, 3);
    // Listed out of order on purpose: the answer does not follow the map's
    // order.  `y` sorts before `z`, so both of `y`'s go first (4 and 9), then
    // the lower of `z`'s (1) — not 7, and not `z`'s two ahead of `y`'s.
    const current = loadsOf([[a, []], [b, []], [z, [7, 1]], [y, [9, 4]]]);

    expect(sorted(strategy.rebalance(current, [a, b], new Set()))).toEqual([1, 4, 9]);
  });

  test('a shard already in flight is skipped and does not use up the budget', () => {
    const strategy = new LeastShardAllocationStrategy(1, 2);
    const current = loadsOf([[a, []], [b, []], [y, [2, 3, 4]]]);

    expect(sorted(strategy.rebalance(current, [a, b], new Set([2])))).toEqual([3, 4]);
  });

  test('what the budget leaves goes to balancing the candidates, as before', () => {
    const strategy = new LeastShardAllocationStrategy(1, 3);
    const current = loadsOf([[a, [10, 11, 12, 13]], [b, []], [y, [2]]]);

    const proposed = strategy.rebalance(current, [a, b], new Set());

    // The non-candidate's shard first, then two of the busiest candidate's.
    expect(proposed.size).toBe(3);
    expect(proposed.has(2)).toBe(true);
    expect(sorted(proposed).filter((shardId) => shardId !== 2).every((shardId) => shardId >= 10)).toBe(true);
  });

  test('a budget the non-candidates use up leaves nothing for balancing', () => {
    const strategy = new LeastShardAllocationStrategy(1, 2);
    const current = loadsOf([[a, [10, 11, 12, 13]], [b, []], [y, [2, 3]]]);

    expect(sorted(strategy.rebalance(current, [a, b], new Set()))).toEqual([2, 3]);
  });

  test('with no node outside the candidates the answer is the balancing one', () => {
    // The shape every pre-existing case has: nothing changes for it.
    const strategy = new LeastShardAllocationStrategy(1, 10);
    const current = loadsOf([[a, [0, 1, 2, 3]], [b, []]]);

    const proposed = strategy.rebalance(current, [a, b], new Set());
    expect(proposed.size).toBeGreaterThan(0);
    for (const shardId of proposed) expect(current.get(a.toString())!.has(shardId)).toBe(true);
  });
});
