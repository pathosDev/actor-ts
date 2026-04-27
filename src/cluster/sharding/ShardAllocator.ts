import { NodeAddress } from '../NodeAddress.js';

/** Strategy: given a shard id and the active member addresses, return the owner. */
export type ShardAllocator = (
  shardId: number,
  members: ReadonlyArray<NodeAddress>,
) => NodeAddress;

/**
 * Simple modulo allocator: sort addresses and pick shardId % n.  Every node
 * computes the same assignment deterministically.  Works well when the
 * member set is stable; moves a lot of shards when it changes.
 */
export const moduloAllocator: ShardAllocator = (shardId, members) => {
  if (members.length === 0) throw new Error('No members available to allocate shard');
  const sorted = [...members].sort((a, b) => a.compareTo(b));
  return sorted[shardId % sorted.length]!;
};

/**
 * Stable ring-hash allocator: for each shard, hash together (shardId, address)
 * and pick the address with the highest hash (highest-random-weight / rendezvous
 * hashing).  When one node leaves, only its shards relocate — the rest stay
 * put.  Better rebalance behaviour than modulo at the cost of a bit more
 * computation.
 */
export const rendezvousAllocator: ShardAllocator = (shardId, members) => {
  if (members.length === 0) throw new Error('No members available to allocate shard');
  let bestHash = -1;
  let best: NodeAddress = members[0]!;
  for (const addr of members) {
    const h = hashCombine(shardId, addr.toString());
    if (h > bestHash) { bestHash = h; best = addr; }
  }
  return best;
};

/**
 * Helper used by the default ShardRegion to map an entityId to a shard.
 * Uses a stable string hash; callers may supply their own extractShardId.
 */
export function hashShardId(entityId: string, numShards: number): number {
  return Math.abs(stringHash(entityId)) % numShards;
}

function stringHash(s: string): number {
  let h = 2166136261; // FNV-1a 32-bit basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}

function hashCombine(a: number, b: string): number {
  let h = stringHash(b) ^ (a * 2654435761);
  h ^= h >>> 13;
  h = Math.imul(h, 1540483477);
  return h >>> 0;
}
