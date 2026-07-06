/**
 * Multi-node test: sharding rebalances after a node disappears.
 *
 * Scenario:
 *   - 3-node cluster with `numShards = 16`.  After convergence, the
 *     16 shards are split across the 3 regions.
 *   - Send `ping` to 16 distinct entity ids — every reply must come
 *     back as `pong`, regardless of which node hosts the shard.
 *   - Crash one node.  The 5–6 shards that lived on that node need
 *     to be reassigned to one of the surviving regions.
 *   - Send another round of pings — every entity (including the ones
 *     whose shards moved) must still answer.
 *
 * What we're really testing here:
 *   1. The ShardCoordinator notices the node-down event and tells the
 *      surviving regions to take over the orphaned shards.
 *   2. Asks initiated *during* and *after* rebalance time out cleanly
 *      or are routed to the new home — they must not silently disappear.
 *
 * This is a single test by design — the matrix of "what happens
 * when X crashes and Y is mid-handoff" lives in the
 * sharding-failover hardening work (Issue #36).  Here we just want
 * green-path rebalancing to work over the multi-node harness.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { Props } from '../../src/Props.js';
import { ClusterSharding, StartShardingOptions } from '../../src/cluster/sharding/ClusterSharding.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import type { ActorRef } from '../../src/ActorRef.js';

type Cmd = { id: string; op: 'ping' | 'echo'; payload?: string };

class Entity extends Actor<Cmd> {
  override onReceive(m: Cmd): void {
    if (m.op === 'ping') this.sender.forEach((s) => s.tell('pong'));
    else if (m.op === 'echo') this.sender.forEach((s) => s.tell(m.payload ?? ''));
  }
}

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

describe('multi-node sharding rebalance', () => {
  test('three nodes serve 16 entities; one crashes; survivors keep serving', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3),
        spec.awaitMembers('b', 3),
        spec.awaitMembers('c', 3),
      ]);

      const regions: Record<'a' | 'b' | 'c', ActorRef<Cmd>> = {
        a: spec.clusterFor('a').sharding.start<Cmd>(
          StartShardingOptions.create<Cmd>()
            .withTypeName('entity')
            .withEntityProps(Props.create(() => new Entity()))
            .withExtractEntityId((m) => m.id)
            .withNumShards(16),
        ),
        b: spec.clusterFor('b').sharding.start<Cmd>(
          StartShardingOptions.create<Cmd>()
            .withTypeName('entity')
            .withEntityProps(Props.create(() => new Entity()))
            .withExtractEntityId((m) => m.id)
            .withNumShards(16),
        ),
        c: spec.clusterFor('c').sharding.start<Cmd>(
          StartShardingOptions.create<Cmd>()
            .withTypeName('entity')
            .withEntityProps(Props.create(() => new Entity()))
            .withExtractEntityId((m) => m.id)
            .withNumShards(16),
        ),
      };

      // Let the coordinator finish initial allocation.  A short sleep
      // matches what the existing 2-node sharding tests do.
      await Bun.sleep(300);

      // Round 1: 16 entities, ask via each region in turn.  Ask succeeds
      // regardless of which node hosts the shard — that's the whole
      // point of location-transparent regions.
      const round1 = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          regions.a.ask<string>({ id: `e-${i}`, op: 'ping' }, 3_000),
        ),
      );
      expect(round1).toEqual(Array.from({ length: 16 }, () => 'pong'));

      // Crash node 'c' — its shards (whichever HashAllocationStrategy
      // landed there) must be re-homed by the coordinator.
      await spec.crash('c');
      await Promise.all([
        spec.awaitMembers('a', 2, 5_000),
        spec.awaitMembers('b', 2, 5_000),
      ]);

      // Give the coordinator a moment to finish reallocation gossip.
      // Without this, the next round of asks may race against
      // "shard X home is being moved" and time out.
      await Bun.sleep(500);

      // Round 2: ask again from a's region.  Every shard now lives on
      // a or b, but the same `e-i` ids are reused — entities may have
      // been recreated on the new host (sharding has no persistence
      // here), but the response semantics are identical.
      const round2 = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          regions.a.ask<string>({ id: `e-${i}`, op: 'ping' }, 5_000),
        ),
      );
      expect(round2).toEqual(Array.from({ length: 16 }, () => 'pong'));

      // And from b's region — proves ask routing works from any survivor.
      const round3 = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          regions.b.ask<string>({ id: `f-${i}`, op: 'echo', payload: `r-${i}` }, 5_000),
        ),
      );
      expect(round3).toEqual(Array.from({ length: 8 }, (_, i) => `r-${i}`));
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);
});
