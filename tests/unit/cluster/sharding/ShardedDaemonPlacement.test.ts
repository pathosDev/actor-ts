/**
 * One daemon per shard (#951).
 *
 * `ShardedDaemonProcess` governs its type with `numShards = numDaemons`, and the
 * region places an entity on `hashShardId(entityId, numShards)`.  With the
 * daemon index as the entity id, that hashed N ids into N buckets: 100 daemons
 * landed on 58 shards, four of them on one, and a shard is the unit of
 * allocation, so no rebalance could ever separate them.  The entity ids are now
 * chosen so the hash lands daemon `i` on shard `i` — a bijection, checked here
 * against the region's own hash.
 */
import { describe, expect, test } from 'bun:test';
import { hashShardId } from '../../../../src/cluster/sharding/ShardAllocator.js';
import { daemonEntityIds } from '../../../../src/cluster/sharding/ShardedDaemonProcess.js';

describe('daemonEntityIds — daemon index ↔ shard id is a bijection (#951)', () => {
  for (const numDaemons of [1, 10, 100, 1000]) {
    test(`numDaemons = ${numDaemons}: daemon i lands on shard i`, () => {
      const entityIds = daemonEntityIds(numDaemons);

      expect(entityIds).toHaveLength(numDaemons);
      expect(new Set(entityIds).size).toBe(numDaemons);
      const shards = entityIds.map((entityId) => hashShardId(entityId, numDaemons));
      expect(shards).toEqual(Array.from({ length: numDaemons }, (_, index) => index));
    });
  }

  test('an index whose plain decimal id already lands on its own shard keeps it', () => {
    // So a registry written before #951 keeps every daemon it can: those ids
    // are unchanged, and only the ones that were co-located move.
    const entityIds = daemonEntityIds(100);
    for (let index = 0; index < 100; index++) {
      if (hashShardId(String(index), 100) === index) expect(entityIds[index]).toBe(String(index));
    }
  });

  test('every node computes the same ids', () => {
    expect(daemonEntityIds(257)).toEqual(daemonEntityIds(257));
  });
});
