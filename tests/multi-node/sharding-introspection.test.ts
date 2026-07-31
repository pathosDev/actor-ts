/**
 * Multi-node test: the shard list agrees from every node, and survives a
 * crash.
 *
 * `ClusterSharding.shards()` is answered by the *leader's* coordinator, but
 * asked through whichever node you happen to hold — so the interesting claim
 * is that all three nodes get the same answer, and that the answer follows
 * the cluster when a node disappears rather than reporting shards on a host
 * that is already gone.
 *
 * The counts are deliberately asserted as invariants (same shard set
 * everywhere, total entity count preserved, no shard left on a dead node)
 * rather than as a fixed placement — which shard lands where is the
 * allocation strategy's business, and pinning it here would make this a test
 * of `HashAllocationStrategy` instead.
 */
import { match } from 'ts-pattern';
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import { Props } from '../../src/Props.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import type { ActorRef } from '../../src/ActorRef.js';

type PingCommand = { id: string; kind: 'ping' };

type Command = PingCommand;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
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

const NUM_SHARDS = 16;
const TYPE_NAME = 'entity';
const ENTITY_IDS = Array.from({ length: 16 }, (_, index) => `entity-${index}`);

describe('multi-node shard introspection', () => {
  test('every node sees the same shard list, and it follows a crash', async () => {
    const spec = new MultiNodeSpec({
      roles: ['a', 'b', 'c'],
      failureDetector: TIGHT_FD,
      gossipIntervalMs: 80,
    });
    try {
      await spec.start();
      await Promise.all([
        spec.awaitMembers('a', 3), spec.awaitMembers('b', 3), spec.awaitMembers('c', 3),
      ]);

      const shardingOptions = StartShardingOptions.create<Command>()
        .withTypeName(TYPE_NAME)
        .withEntityProps(Props.create(() => new Entity()))
        .withExtractEntityId((m) => m.id)
        .withNumShards(NUM_SHARDS);
      const regions: Record<'a' | 'b' | 'c', ActorRef<Command>> = {
        a: spec.clusterFor('a').sharding.start<Command>(shardingOptions),
        b: spec.clusterFor('b').sharding.start<Command>(shardingOptions),
        c: spec.clusterFor('c').sharding.start<Command>(shardingOptions),
      };
      await Bun.sleep(300);

      // Touch every id so each one has a live entity somewhere.
      const replies = await Promise.all(
        ENTITY_IDS.map((id) => regions.a.ask<string>({ id, kind: 'ping' }, 5_000)),
      );
      expect(replies.every((reply) => reply === 'pong')).toBe(true);

      const [fromA, fromB, fromC] = await Promise.all([
        spec.clusterFor('a').sharding.shards<Command>(TYPE_NAME, 5_000),
        spec.clusterFor('b').sharding.shards<Command>(TYPE_NAME, 5_000),
        spec.clusterFor('c').sharding.shards<Command>(TYPE_NAME, 5_000),
      ]);

      const shardIdsOf = (list: ReadonlyArray<{ shardId: number }>): number[] =>
        list.map((shard) => shard.shardId).sort((x, y) => x - y);
      expect(shardIdsOf(fromB)).toEqual(shardIdsOf(fromA));
      expect(shardIdsOf(fromC)).toEqual(shardIdsOf(fromA));

      // Every entity we touched is accounted for exactly once.
      const total = fromA.reduce((sum, shard) => sum + shard.entityCount, 0);
      expect(total).toBe(ENTITY_IDS.length);

      // The 16 ids spread over more than one host, or this proves nothing
      // about the cluster-wide part of the query.
      const hosts = new Set(fromA.map((shard) => shard.node.toString()));
      expect(hosts.size).toBeGreaterThan(1);

      // Each node calls exactly its own shards local.
      for (const [role, list] of [['a', fromA], ['b', fromB], ['c', fromC]] as const) {
        const selfAddress = spec.addressFor(role).toString();
        for (const shard of list) {
          expect(shard.local).toBe(shard.node.toString() === selfAddress);
        }
      }

      const crashedAddress = spec.addressFor('c').toString();
      await spec.crash('c');
      await Promise.all([spec.awaitMembers('a', 2, 5_000), spec.awaitMembers('b', 2, 5_000)]);

      // Membership converging is not the same as reallocation finishing.
      // Poll the list itself — "no shard is still homed on the dead node" is
      // exactly the condition the next round of asks depends on, so waiting
      // for it beats waiting for a fixed number of milliseconds.
      let survivors = await spec.clusterFor('a').sharding.shards<Command>(TYPE_NAME, 5_000);
      const deadline = Date.now() + 10_000;
      while (
        Date.now() < deadline
        && survivors.some((shard) => shard.node.toString() === crashedAddress)
      ) {
        await Bun.sleep(50);
        survivors = await spec.clusterFor('a').sharding.shards<Command>(TYPE_NAME, 5_000);
      }
      expect(survivors.length).toBeGreaterThan(0);
      for (const shard of survivors) {
        expect(shard.node.toString()).not.toBe(crashedAddress);
      }

      // And the surviving placement actually serves — re-touching every id
      // repopulates the shards that moved.
      const afterCrash = await Promise.all(
        ENTITY_IDS.map((id) => regions.b.ask<string>({ id, kind: 'ping' }, 5_000)),
      );
      expect(afterCrash.every((reply) => reply === 'pong')).toBe(true);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 45_000);
});
