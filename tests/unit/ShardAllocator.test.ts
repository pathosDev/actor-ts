import { describe, expect, test } from 'bun:test';
import { NodeAddress } from '../../src/cluster/NodeAddress.js';
import {
  hashShardId,
  moduloAllocator,
  rendezvousAllocator,
} from '../../src/cluster/sharding/ShardAllocator.js';

const n1 = new NodeAddress('s', 'h', 1);
const n2 = new NodeAddress('s', 'h', 2);
const n3 = new NodeAddress('s', 'h', 3);

describe('hashShardId', () => {
  test('is deterministic — same id + numShards → same result', () => {
    const a = hashShardId('alpha', 64);
    const b = hashShardId('alpha', 64);
    expect(a).toBe(b);
  });

  test('result is in [0, numShards)', () => {
    for (let i = 0; i < 200; i++) {
      const v = hashShardId(`entity-${i}`, 32);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(32);
    }
  });

  test('distribution is non-trivially spread across 16 shards (sanity)', () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 500; i++) buckets.add(hashShardId(`e-${i}`, 16));
    // Should hit a decent fraction of the 16 slots.
    expect(buckets.size).toBeGreaterThanOrEqual(10);
  });
});

describe('moduloAllocator', () => {
  test('deterministic independent of member order', () => {
    for (let sh = 0; sh < 32; sh++) {
      expect(moduloAllocator(sh, [n1, n2, n3]).equals(moduloAllocator(sh, [n3, n2, n1]))).toBe(true);
    }
  });

  test('throws on empty member list', () => {
    expect(() => moduloAllocator(0, [])).toThrow();
  });

  test('single member always gets the shard', () => {
    for (let sh = 0; sh < 10; sh++) {
      expect(moduloAllocator(sh, [n2]).equals(n2)).toBe(true);
    }
  });

  test('matches sorted-by-address modulo semantics', () => {
    // sorted([n1,n2,n3]) = [n1,n2,n3] (by compareTo string order), so
    // shard 0 -> n1, 1 -> n2, 2 -> n3, 3 -> n1 ...
    expect(moduloAllocator(0, [n1, n2, n3]).equals(n1)).toBe(true);
    expect(moduloAllocator(1, [n1, n2, n3]).equals(n2)).toBe(true);
    expect(moduloAllocator(2, [n1, n2, n3]).equals(n3)).toBe(true);
    expect(moduloAllocator(3, [n1, n2, n3]).equals(n1)).toBe(true);
  });
});

describe('rendezvousAllocator', () => {
  test('deterministic independent of member order', () => {
    for (let sh = 0; sh < 32; sh++) {
      const a = rendezvousAllocator(sh, [n1, n2, n3]);
      const b = rendezvousAllocator(sh, [n3, n1, n2]);
      expect(a.equals(b)).toBe(true);
    }
  });

  test('throws on empty member list', () => {
    expect(() => rendezvousAllocator(0, [])).toThrow();
  });

  test('stable: removing one node only relocates shards that lived on it', () => {
    const before: string[] = [];
    const after: string[] = [];
    for (let sh = 0; sh < 256; sh++) {
      before.push(rendezvousAllocator(sh, [n1, n2, n3]).toString());
      after.push(rendezvousAllocator(sh, [n1, n3]).toString()); // n2 removed
    }
    for (let sh = 0; sh < 256; sh++) {
      if (before[sh] === n2.toString()) {
        // Was on n2 → must move to one of the survivors.
        expect([n1.toString(), n3.toString()]).toContain(after[sh]);
      } else {
        // Was NOT on n2 → must stay put.
        expect(after[sh]).toBe(before[sh]);
      }
    }
  });
});
