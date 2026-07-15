import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import {
  HashAllocationStrategy,
  LeastShardAllocationStrategy,
} from '../../src/cluster/sharding/AllocationStrategy.js';

const n1 = new NodeAddress('s', 'h', 1);
const n2 = new NodeAddress('s', 'h', 2);
const n3 = new NodeAddress('s', 'h', 3);

function loadsOf(map: Array<[NodeAddress, number[]]>): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [addr, shards] of map) out.set(addr.toString(), new Set(shards));
  return out;
}

describe('HashAllocationStrategy.allocate', () => {
  test('is deterministic regardless of candidate order', () => {
    const strategy = new HashAllocationStrategy();
    for (let sh = 0; sh < 32; sh++) {
      const allocationA = strategy.allocate(sh, [n1, n2, n3], new Map());
      const allocationB = strategy.allocate(sh, [n3, n1, n2], new Map());
      expect(allocationA.equals(allocationB)).toBe(true);
    }
  });

  test('throws on empty candidates', () => {
    const strategy = new HashAllocationStrategy();
    expect(() => strategy.allocate(0, [], new Map())).toThrow(/no candidates/);
  });
});

describe('HashAllocationStrategy.rebalance', () => {
  test('returns empty when ownership matches the hash mapping', () => {
    const strategy = new HashAllocationStrategy();
    // With [n1,n2,n3], shard 0 -> n1, 1 -> n2, 2 -> n3.
    const current = loadsOf([
      [n1, [0]],
      [n2, [1]],
      [n3, [2]],
    ]);
    expect(Array.from(strategy.rebalance(current, [n1, n2, n3], new Set()))).toEqual([]);
  });

  test('flags shards whose current owner differs from the hash mapping', () => {
    const strategy = new HashAllocationStrategy();
    // Misplaced: shard 0 should be on n1 but lives on n3.
    const current = loadsOf([
      [n1, []],
      [n2, [1]],
      [n3, [0, 2]],
    ]);
    const out = strategy.rebalance(current, [n1, n2, n3], new Set());
    expect(out.has(0)).toBe(true);
    expect(out.has(1)).toBe(false);
    expect(out.has(2)).toBe(false);
  });

  test('skips shards already being rebalanced', () => {
    const strategy = new HashAllocationStrategy();
    const current = loadsOf([
      [n1, []],
      [n2, [1]],
      [n3, [0]],
    ]);
    const out = strategy.rebalance(current, [n1, n2, n3], new Set([0]));
    expect(out.has(0)).toBe(false);
  });
});

describe('LeastShardAllocationStrategy.allocate', () => {
  test('picks an empty candidate when one exists', () => {
    const strategy = new LeastShardAllocationStrategy();
    const current = loadsOf([
      [n1, [0, 1, 2]],
      [n2, []],
      [n3, [3]],
    ]);
    expect(strategy.allocate(9, [n1, n2, n3], current).equals(n2)).toBe(true);
  });

  test('breaks ties by address order', () => {
    const strategy = new LeastShardAllocationStrategy();
    const current = loadsOf([
      [n1, [0]],
      [n2, [1]],
      [n3, [2]],
    ]); // all equal loads
    expect(strategy.allocate(9, [n1, n2, n3], current).equals(n1)).toBe(true);
  });

  test('throws on empty candidates', () => {
    const strategy = new LeastShardAllocationStrategy();
    expect(() => strategy.allocate(0, [], new Map())).toThrow(/no candidates/);
  });
});

describe('LeastShardAllocationStrategy.rebalance', () => {
  test('returns empty when load spread is below threshold', () => {
    const strategy = new LeastShardAllocationStrategy(5, 10);
    const current = loadsOf([
      [n1, [0, 1, 2]],
      [n2, [3, 4]],
    ]);
    expect(strategy.rebalance(current, [n1, n2], new Set()).size).toBe(0);
  });

  test('returns shards from the busiest candidate when spread ≥ threshold', () => {
    const strategy = new LeastShardAllocationStrategy(1, 10);
    const current = loadsOf([
      [n1, [0, 1, 2, 3]],
      [n2, []],
    ]);
    const out = strategy.rebalance(current, [n1, n2], new Set());
    expect(out.size).toBeGreaterThan(0);
    // Every picked shard should live on n1 in `current`.
    for (const sh of out) expect(current.get(n1.toString())!.has(sh)).toBe(true);
  });

  test('respects maxSimultaneousRebalance', () => {
    const strategy = new LeastShardAllocationStrategy(1, 2);
    const current = loadsOf([
      [n1, [0, 1, 2, 3, 4]],
      [n2, []],
    ]);
    const out = strategy.rebalance(current, [n1, n2], new Set());
    expect(out.size).toBeLessThanOrEqual(2);
  });

  test('skips shards already being rebalanced', () => {
    const strategy = new LeastShardAllocationStrategy(1, 10);
    const current = loadsOf([
      [n1, [0, 1, 2, 3]],
      [n2, []],
    ]);
    const out = strategy.rebalance(current, [n1, n2], new Set([0, 1]));
    expect(out.has(0)).toBe(false);
    expect(out.has(1)).toBe(false);
  });

  test('returns empty when only one candidate exists', () => {
    const strategy = new LeastShardAllocationStrategy(1, 10);
    const current = loadsOf([[n1, [0, 1, 2]]]);
    expect(strategy.rebalance(current, [n1], new Set()).size).toBe(0);
  });
});
