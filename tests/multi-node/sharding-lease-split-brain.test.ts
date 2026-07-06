/**
 * Multi-node split-brain test for ShardCoordinator + Lease (#60).
 *
 * Scenario:
 *
 *   1. Three roles a, b, c form a cluster.  All three start a
 *      sharded region with the SAME `name` lease, sharing an
 *      InMemoryLease store.  This simulates an external arbiter
 *      (K8s API) that's reachable from every node — exactly the
 *      shape Lease integration is designed to protect.
 *   2. The cluster converges; whichever role becomes leader
 *      acquires the lease and starts serving shards.  The other
 *      coordinators sit passive (they're not leader).
 *   3. We then force a network partition that splits the leader
 *      from the rest.  The remaining nodes' downing eventually
 *      promotes a new leader on the other side.  WITHOUT a lease,
 *      both sides could briefly run active coordinators — the
 *      classic split-brain.  WITH a lease, the original holder
 *      keeps the lease (we don't simulate K8s revoking it during
 *      the partition window) and the new "leader" on the surviving
 *      side blocks on `lease.acquire()` — never becoming active.
 *
 *   The split-brain bug we're guarding against: two coordinators
 *   each issuing `AllocateShard` for the same shard.  We assert
 *   that at most ONE coordinator is in `leaseState === 'held'`
 *   at any point during the experiment.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { Props } from '../../src/Props.js';
import { ClusterSharding, StartShardingOptions } from '../../src/cluster/sharding/ClusterSharding.js';
import { ShardCoordinator } from '../../src/cluster/sharding/ShardCoordinator.js';
import {
  InMemoryLease,
  inMemoryLeaseStore,
} from '../../src/coordination/leases/InMemoryLease.js';
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

/**
 * Peek into the coordinator instance for the `leaseState` field —
 * we use this as the assertion target.  `(coord as any).leaseState`
 * is fine because the field is on the same class we just imported.
 */
function leaseStateOf(coord: ShardCoordinator): 'none' | 'acquiring' | 'held' {
  return (coord as unknown as { leaseState: 'none' | 'acquiring' | 'held' }).leaseState;
}

/** Ferret out the local ShardCoordinator instance from a system + typeName. */
function findCoordinator(
  spec: MultiNodeSpec, role: string, typeName: string,
): ShardCoordinator | null {
  const sys = spec.systemFor(role);
  // Coordinator lives at /user/sharding-coordinator-{typeName}
  const seg = `sharding-coordinator-${typeName}`;
  const refOpt = sys._resolvePath(['user', seg]);
  if (refOpt.isNone()) return null;
  // Internal hop: the LocalActorRef's cell holds the actor instance.
  const ref = refOpt.value as unknown as { getCell?: () => { actor?: ShardCoordinator } };
  const actor = ref.getCell?.().actor;
  return actor ?? null;
}

describe('multi-node sharding lease — split-brain protection', () => {
  test('only one coordinator ever holds the lease, even under partition', async () => {
    inMemoryLeaseStore._clear();
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

      // Each role gets its own InMemoryLease binding, but they all
      // share the same underlying store (`inMemoryLeaseStore`),
      // which is what makes this a meaningful arbiter — only one
      // owner can hold it across the three coordinators at once.
      const regions: Record<'a' | 'b' | 'c', ActorRef<Cmd>> = {
        a: spec.clusterFor('a').sharding.start<Cmd>(
          StartShardingOptions.create<Cmd>()
            .withTypeName('entity')
            .withEntityProps(Props.create(() => new Entity()))
            .withExtractEntityId((m) => m.id)
            .withNumShards(8)
            .withRebalanceIntervalMs(200)
            .withLease(new InMemoryLease({
              name: 'shard-coord-lease', owner: 'a', ttlMs: 10_000,
              renewalIntervalMs: 80,
            }))
            .withAcquireRetryIntervalMs(100),
        ),
        b: spec.clusterFor('b').sharding.start<Cmd>(
          StartShardingOptions.create<Cmd>()
            .withTypeName('entity')
            .withEntityProps(Props.create(() => new Entity()))
            .withExtractEntityId((m) => m.id)
            .withNumShards(8)
            .withRebalanceIntervalMs(200)
            .withLease(new InMemoryLease({
              name: 'shard-coord-lease', owner: 'b', ttlMs: 10_000,
              renewalIntervalMs: 80,
            }))
            .withAcquireRetryIntervalMs(100),
        ),
        c: spec.clusterFor('c').sharding.start<Cmd>(
          StartShardingOptions.create<Cmd>()
            .withTypeName('entity')
            .withEntityProps(Props.create(() => new Entity()))
            .withExtractEntityId((m) => m.id)
            .withNumShards(8)
            .withRebalanceIntervalMs(200)
            .withLease(new InMemoryLease({
              name: 'shard-coord-lease', owner: 'c', ttlMs: 10_000,
              renewalIntervalMs: 80,
            }))
            .withAcquireRetryIntervalMs(100),
        ),
      };
      void regions;

      // Wait for the cluster to settle into a leader.  At-most-one
      // coordinator becomes `held`; the other two stay `none` /
      // `acquiring`.
      await Bun.sleep(800);
      const states = ['a', 'b', 'c'].map((r) => {
        const c = findCoordinator(spec, r, 'entity');
        return c ? leaseStateOf(c) : 'unknown';
      });
      const heldCount = states.filter((s) => s === 'held').length;
      expect(heldCount).toBe(1);

      // Sanity: ask via any region — the system is functional.
      const reply = await regions.a.ask<string>({ id: 'e-1', op: 'ping' }, 3_000);
      expect(reply).toBe('pong');

      // Now partition.  Whichever role is currently active stays
      // active (the InMemoryLease store is untouched by the
      // partition); the other side's coordinators try to step up
      // when downing converges, but they can't acquire.
      const heldRole = ['a', 'b', 'c'][states.indexOf('held')]!;
      const others = ['a', 'b', 'c'].filter((r) => r !== heldRole);

      // Cut the held side off from both others.
      spec.partition(heldRole, others[0]!);
      spec.partition(heldRole, others[1]!);

      // Allow downing + lease retry to settle.  The held side
      // continues to renew its lease (renewalIntervalMs = 80 ms),
      // so the followers' acquire retries (100 ms) consistently
      // fail.
      await Bun.sleep(1_500);

      // INVARIANT: still at most one coordinator in `held` state.
      const statesAfter = ['a', 'b', 'c'].map((r) => {
        const c = findCoordinator(spec, r, 'entity');
        return c ? leaseStateOf(c) : 'unknown';
      });
      const heldAfter = statesAfter.filter((s) => s === 'held').length;
      expect(heldAfter).toBeLessThanOrEqual(1);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
      inMemoryLeaseStore._clear();
    }
  }, 30_000);
});
