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
import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { ClusterSharding } from '../../src/cluster/sharding/ClusterSharding.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import { awaitCondition, sleep } from '../util/AwaitCondition.js';
import type { ActorRef } from '../../src/ActorRef.js';

type PingCommand = { id: string; kind: 'ping'; payload?: string };
type EchoCommand = { id: string; kind: 'echo'; payload?: string };

type Command = PingCommand | EchoCommand;

class Entity extends Actor<Command> {
  override onReceive(m: Command): void {
    match(m)
      .with({ kind: 'ping' }, () => this.onPing())
      .with({ kind: 'echo' }, (c) => this.onEcho(c))
      .exhaustive();
  }

  private onPing(): void {
    this.sender.forEach((s) => s.tell('pong'));
  }

  private onEcho(command: EchoCommand): void {
    this.sender.forEach((s) => s.tell(command.payload ?? ''));
  }
}

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

/**
 * Whether `region` still caches a shard home on `node`.
 *
 * A region routes from a cached shard→node map and drops the entries for a
 * node only once it has processed that node's `MemberRemoved`; until then a
 * message for such a shard is sent at a host that is gone.  `awaitMembers`
 * watches the *cluster view*, which converges strictly earlier, so this is the
 * gap a post-crash round of asks actually has to clear.
 *
 * Test-only reach into a private map, for want of a public surface — and still
 * the better probe than `ClusterSharding.shards()`, which blocks the region's
 * mailbox for its fan-out fuse and so would starve the asks under test.
 */
function cachesShardHomeOn(region: ActorRef<Command>, node: string): boolean {
  const internal = region as unknown as {
    getCell?: () => { actor?: { shardHomeNodes: Map<number, { toString(): string }> } };
  };
  const homes = internal.getCell?.().actor?.shardHomeNodes;
  if (!homes) return true;                    // not materialised yet — not ready
  return [...homes.values()].some((address) => address.toString() === node);
}

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

      const shardingOptions = StartShardingOptions.create<Command>()
        .withTypeName('entity')
        .withEntityActor(Entity)
        .withExtractEntityId((m) => m.id)
        .withNumShards(16);
      const regions: Record<'a' | 'b' | 'c', ActorRef<Command>> = {
        a: spec.clusterFor('a').sharding.start<Command>(shardingOptions),
        b: spec.clusterFor('b').sharding.start<Command>(shardingOptions),
        c: spec.clusterFor('c').sharding.start<Command>(shardingOptions),
      };

      // Let the coordinator finish initial allocation.  A fixed sleep is
      // adequate here and stays: nothing is asserted on it, and the asks
      // below carry their own 3 s budget, so an allocation that is still in
      // flight is absorbed by the ask rather than read as a wrong answer.
      await sleep(300);

      // Round 1: 16 entities, ask via each region in turn.  Ask succeeds
      // regardless of which node hosts the shard — that's the whole
      // point of location-transparent regions.
      const round1 = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          regions.a.ask<string>({ id: `e-${i}`, kind: 'ping' }, 3_000),
        ),
      );
      expect(round1).toEqual(Array.from({ length: 16 }, () => 'pong'));

      // Crash node 'c' — its shards (whichever HashAllocationStrategy
      // landed there) must be re-homed by the coordinator.
      const crashedAddress = spec.addressFor('c').toString();
      await spec.crash('c');
      await Promise.all([
        spec.awaitMembers('a', 2, 5_000),
        spec.awaitMembers('b', 2, 5_000),
      ]);

      // Membership converging is not the same as the regions having noticed.
      // Both regions the rounds below ask through still route round 1's shards
      // at the node that just died until their `MemberRemoved` lands — that is
      // the race the 500 ms sleep was hiding, and it is directly readable.
      await awaitCondition(
        () => !cachesShardHomeOn(regions.a, crashedAddress)
          && !cachesShardHomeOn(regions.b, crashedAddress),
        {
          timeoutMs: 10_000,
          intervalMs: 10,
          label: 'both surviving regions dropped every shard home on the crashed node',
        },
      );

      // Round 2: ask again from a's region.  Every shard now lives on
      // a or b, but the same `e-i` ids are reused — entities may have
      // been recreated on the new host (sharding has no persistence
      // here), but the response semantics are identical.
      const round2 = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          regions.a.ask<string>({ id: `e-${i}`, kind: 'ping' }, 5_000),
        ),
      );
      expect(round2).toEqual(Array.from({ length: 16 }, () => 'pong'));

      // And from b's region — proves ask routing works from any survivor.
      const round3 = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          regions.b.ask<string>({ id: `f-${i}`, kind: 'echo', payload: `r-${i}` }, 5_000),
        ),
      );
      expect(round3).toEqual(Array.from({ length: 8 }, (_, i) => `r-${i}`));
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 30_000);
});
