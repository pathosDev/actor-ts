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
import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ClusterSharding } from '../../src/cluster/sharding/ClusterSharding.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { DistributedDataCoordinatorStateStore } from '../../src/cluster/sharding/CoordinatorState.js';
import { ShardCoordinator } from '../../src/cluster/sharding/ShardCoordinator.js';
import { coordinatorSegments } from '../util/SystemPaths.js';
import { DistributedDataId } from '../../src/crdt/DistributedData.js';
import { DistributedDataOptions } from '../../src/crdt/DistributedDataOptions.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import { awaitCondition } from '../util/AwaitCondition.js';
import type { ActorRef } from '../../src/ActorRef.js';

type PingCommand = { id: string; kind: 'ping' };

type Command = PingCommand;

class Entity extends Actor<Command> {
  override onReceive(m: Command): void {
    match(m)
      .with({ kind: 'ping' }, () => this.onPing())
      .exhaustive();
  }

  private onPing(): void {
    this.sender.forEach((s) => s.tell('pong'));
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
  const refOption = sys._resolvePath(coordinatorSegments(sys.name, typeName));
  if (refOption.isNone()) return null;
  const internal = refOption.value as unknown as { getCell?: () => { actor?: ShardCoordinator } };
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
      const regions: Record<'a' | 'b' | 'c', ActorRef<Command>> = {
        a: undefined as unknown as ActorRef<Command>,
        b: undefined as unknown as ActorRef<Command>,
        c: undefined as unknown as ActorRef<Command>,
      };
      // Kept per role so the test can read each node's *local* DD view of the
      // snapshot — that view is the precondition for a survivor recovering.
      const stores = new Map<string, DistributedDataCoordinatorStateStore>();
      for (const role of ['a', 'b', 'c'] as const) {
        const sys = spec.systemFor(role);
        const cluster = spec.clusterFor(role);
        const ddOptions = DistributedDataOptions.create()
          .withGossipInterval(80);
        const dd = sys.extension(DistributedDataId).start(cluster, ddOptions);
        const store = new DistributedDataCoordinatorStateStore(
          dd, cluster.selfAddress.toString(),
        );
        stores.set(role, store);
        const shardingOptions = StartShardingOptions.create<Command>()
          .withTypeName('entity')
          .withEntityActor(Entity)
          .withExtractEntityId((m) => m.id)
          .withNumShards(8)
          .withRebalanceIntervalMs(200)
          .withCoordinatorStateStore(store);
        regions[role] = cluster.sharding.start<Command>(shardingOptions);
      }

      // Allocate the shards by asking 8 distinct entity ids.  Each
      // ask triggers a `GetShardHome` → `tryAllocate` → snapshot
      // save on the leader.
      for (let i = 0; i < 8; i++) {
        const reply = await regions.a.ask<string>({ id: `e-${i}`, kind: 'ping' }, 3_000);
        expect(reply).toBe('pong');
      }

      // Wait for the snapshot to be complete on the leader *and* present in
      // both followers' local DD view — that is what a survivor recovers
      // from, and it is directly readable, so there is no reason to guess at
      // a gossip latency.  The 400 ms this replaced was two DD rounds on an
      // idle box; under load it could expire mid-round, and the failure then
      // surfaced further down as "the new leader recovered 0 regions", which
      // reads like a bug in #39's recovery path rather than a test that
      // crashed the leader too early.
      await awaitCondition(
        async () => {
          const leader = findCoordinator(spec, 'a', 'entity');
          if (regionCount(leader) !== 3 || shardHomeCount(leader) !== 8) return false;
          for (const role of ['b', 'c'] as const) {
            const snapshot = await stores.get(role)!.load('entity');
            if (!snapshot) return false;
            if (snapshot.regions.length !== 3 || snapshot.shardHome.length !== 8) return false;
          }
          return true;
        },
        {
          timeoutMs: 10_000,
          intervalMs: 25,
          label: 'both followers hold a coordinator snapshot with 3 regions and 8 shard homes',
        },
      );

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
      let newLeaderRole = '';
      await awaitCondition(
        () => {
          const leader = spec.clusterFor('b').leader().toNullable();
          if (!leader || leader.address.systemName === 'a') return false;
          newLeaderRole = leader.address.systemName;
          return true;
        },
        { timeoutMs: 10_000, intervalMs: 25, label: 'a survivor was promoted to leader' },
      );
      expect(['b', 'c']).toContain(newLeaderRole);

      // Inspect the new leader's coordinator: at least 2 regions
      // (the surviving ones) and shardHome populated.  Without
      // #39's snapshot path, both maps would be empty until
      // surviving regions re-register.
      //
      // Waiting on the loaded maps rather than on 200 ms is what makes the
      // assertion below mean "#39's snapshot path did not fire" instead of
      // "the mailbox tick had not run yet".  The load is local (the snapshot
      // was gossiped before the crash) so this normally returns on the first
      // poll; the budget only bounds the broken case.
      await awaitCondition(
        () => {
          const coordinator = findCoordinator(spec, newLeaderRole, 'entity');
          return regionCount(coordinator) >= 2 && shardHomeCount(coordinator) > 0;
        },
        {
          timeoutMs: 10_000,
          intervalMs: 25,
          label: 'the new leader loaded regions + shardHome from the snapshot',
        },
      );
      const newCoord = findCoordinator(spec, newLeaderRole, 'entity');
      expect(regionCount(newCoord)).toBeGreaterThanOrEqual(2);
      expect(shardHomeCount(newCoord)).toBeGreaterThan(0);

      // Functional check: queries against the surviving cluster
      // succeed.  We don't restrict to specific entity ids because
      // the dead leader's region had ~3 of the 8 shards — those
      // entities re-allocate to survivors as messages arrive.
      const survivor = survivors.find((r) => r === newLeaderRole) ?? 'b';
      const reply = await regions[survivor].ask<string>({ id: 'e-1', kind: 'ping' }, 3_000);
      expect(reply).toBe('pong');
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);
});
