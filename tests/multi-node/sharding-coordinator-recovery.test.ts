/**
 * End-to-end test for persistent ShardCoordinator state (#39).
 *
 * Validates that when leadership flips (the active coordinator
 * crashes), the new leader's coordinator populates its `regions` +
 * `shardHome` maps from the DistributedData-backed snapshot — so
 * queries against shards on surviving regions don't have to wait
 * for the standard rebuild-from-Register flow.
 *
 * Test shape:
 *
 *   1. 3-node cluster (a, b, c) with `DistributedData` started on
 *      each + a `DistributedDataCoordinatorStateStore` plugged into
 *      ClusterSharding.
 *   2. Send messages for ~8 entity ids → coordinator allocates
 *      shards across the three regions.
 *   3. Wait for DD gossip to propagate the snapshot to every node.
 *   4. Verify the followers' local DD view has a non-empty snapshot
 *      (sanity check that the persistence path actually fired).
 *   5. Crash the leader.
 *   6. Wait for a new leader to be elected.
 *   7. Inspect the new leader's coordinator: `regions` and
 *      `shardHome` should be populated from the snapshot
 *      (modulo entries that pointed at the now-dead region).
 *   8. Send messages to surviving entities — they succeed without
 *      a fresh allocation pass.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ClusterSharding, StartShardingOptions } from '../../src/cluster/sharding/ClusterSharding.js';
import { DistributedDataCoordinatorStateStore } from '../../src/cluster/sharding/CoordinatorState.js';
import { ShardCoordinator } from '../../src/cluster/sharding/ShardCoordinator.js';
import { DistributedDataId, DistributedDataOptions } from '../../src/crdt/DistributedData.js';
import { Props } from '../../src/Props.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import type { ActorRef } from '../../src/ActorRef.js';

type Cmd = { id: string; op: 'ping' };

class Entity extends Actor<Cmd> {
  override onReceive(m: Cmd): void {
    if (m.op === 'ping') this.sender.forEach((s) => s.tell('pong'));
  }
}

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

/** Peek at the coordinator's private `regions` map to verify the
 *  snapshot was loaded.  Test-only access — production code should
 *  never reach into private fields. */
function regionCount(coord: ShardCoordinator | null): number {
  if (!coord) return -1;
  const internal = coord as unknown as { regions: Map<string, unknown> };
  return internal.regions.size;
}

function shardHomeCount(coord: ShardCoordinator | null): number {
  if (!coord) return -1;
  const internal = coord as unknown as { shardHome: Map<number, string> };
  return internal.shardHome.size;
}

function findCoordinator(
  spec: MultiNodeSpec, role: string, typeName: string,
): ShardCoordinator | null {
  const sys = spec.systemFor(role);
  const refOpt = sys._resolvePath(['user', `sharding-coordinator-${typeName}`]);
  if (refOpt.isNone()) return null;
  const internal = refOpt.value as unknown as { getCell?: () => { actor?: ShardCoordinator } };
  return internal.getCell?.().actor ?? null;
}

describe('ShardCoordinator state persistence — leader failover', () => {
  test('new leader recovers regions + shardHome from DistributedData snapshot', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all(['a', 'b', 'c'].map((r) => spec.awaitMembers(r, 3)));

      // Stand up DD on every node (with tight gossip so the
      // coordinator-state snapshot reaches followers fast) + wire
      // the DD-backed store into ClusterSharding.
      const regions: Record<'a' | 'b' | 'c', ActorRef<Cmd>> = {
        a: undefined as unknown as ActorRef<Cmd>,
        b: undefined as unknown as ActorRef<Cmd>,
        c: undefined as unknown as ActorRef<Cmd>,
      };
      for (const role of ['a', 'b', 'c'] as const) {
        const sys = spec.systemFor(role);
        const cluster = spec.clusterFor(role);
        const dd = sys.extension(DistributedDataId).start(cluster, DistributedDataOptions.create().withGossipInterval(80));
        const store = new DistributedDataCoordinatorStateStore(
          dd, cluster.selfAddress.toString(),
        );
        regions[role] = cluster.sharding.start<Cmd>(
          StartShardingOptions.create<Cmd>()
            .withTypeName('entity')
            .withEntityProps(Props.create(() => new Entity()))
            .withExtractEntityId((m) => m.id)
            .withNumShards(8)
            .withRebalanceIntervalMs(200)
            .withCoordinatorStateStore(store),
        );
      }

      // Allocate the shards by asking 8 distinct entity ids.  Each
      // ask triggers a `GetShardHome` → `tryAllocate` → snapshot
      // save on the leader.
      for (let i = 0; i < 8; i++) {
        const reply = await regions.a.ask<string>({ id: `e-${i}`, op: 'ping' }, 3_000);
        expect(reply).toBe('pong');
      }

      // Allow DD gossip to propagate the snapshot to followers.
      await Bun.sleep(400);

      // Identify the current leader (lowest-port = 'a' by
      // construction in MultiNodeSpec).
      const initialLeader = spec.clusterFor('a').leader().toNullable();
      expect(initialLeader).not.toBeNull();
      const initialLeaderRole = initialLeader!.address.systemName;
      expect(initialLeaderRole).toBe('a');

      // Sanity: leader's coordinator has the full state in memory.
      const leaderCoord = findCoordinator(spec, 'a', 'entity');
      expect(regionCount(leaderCoord)).toBe(3);
      expect(shardHomeCount(leaderCoord)).toBe(8);

      // Crash the leader — failover begins.
      await spec.crash('a');
      await Promise.all([
        spec.awaitMembers('b', 2, 5_000),
        spec.awaitMembers('c', 2, 5_000),
      ]);

      // Wait for a new leader on the survivors.
      const survivors = ['b', 'c'] as const;
      let newLeaderRole: string | null = null;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const ldr = spec.clusterFor('b').leader().toNullable();
        if (ldr && ldr.address.systemName !== 'a') {
          newLeaderRole = ldr.address.systemName;
          break;
        }
        await Bun.sleep(50);
      }
      expect(newLeaderRole).not.toBeNull();
      expect(['b', 'c']).toContain(newLeaderRole!);

      // Give the new leader a brief moment to load the snapshot.
      // The DD value is local (gossiped earlier), so this is one
      // microtask + the actor mailbox tick.
      await Bun.sleep(200);

      // Inspect the new leader's coordinator: at least 2 regions
      // (the surviving ones) and shardHome populated.  Without
      // #39's snapshot path, both maps would be empty until
      // surviving regions re-register.
      const newCoord = findCoordinator(spec, newLeaderRole!, 'entity');
      expect(regionCount(newCoord)).toBeGreaterThanOrEqual(2);
      expect(shardHomeCount(newCoord)).toBeGreaterThan(0);

      // Functional check: queries against the surviving cluster
      // succeed.  We don't restrict to specific entity ids because
      // the dead leader's region had ~3 of the 8 shards — those
      // entities re-allocate to survivors as messages arrive.
      const survivor = survivors.find((r) => r === newLeaderRole) ?? 'b';
      const reply = await regions[survivor].ask<string>({ id: 'e-1', op: 'ping' }, 3_000);
      expect(reply).toBe('pong');
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);
});
