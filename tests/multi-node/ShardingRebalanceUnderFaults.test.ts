import { describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';
import { awaitCondition, sleep } from '../util/AwaitCondition.js';

/**
 * #1023 — a network that degrades *during* a shard rebalance.
 *
 * This is the scenario the issue names as unwritable before the fault layer
 * existed, and the reason is precise: a rebalance is a conversation between a
 * coordinator and its regions, and testing it under stress needs a transport
 * that can delay or lose *one* frame while letting the others through.
 * `partition` could only stop the conversation altogether, which does not
 * exercise the rebalance — it postpones it.
 *
 * The scenario: three nodes serving sixteen entities, one node crashes so the
 * coordinator must re-home its shards, and at that same moment the link
 * between the two survivors starts losing and reordering frames. The claim
 * under test is the one sharding makes everywhere and could not previously be
 * asked: shard-home updates are idempotent and order-independent, so a region
 * that hears them twice, out of order, or not at first still ends up routing
 * every entity to the node that owns it.
 *
 * **What the numbers say, because a chaos test that passes proves nothing
 * until you know what would fail it.**  Measured by varying the profile and
 * re-running: the rebalance completes at 25 % loss and still completes at
 * **90 %**, and fails only when the link between the survivors is severed
 * outright — which is a partition, not a degradation, and the coordinator
 * genuinely cannot finish a hand-off across one.  So the assertion has a real
 * boundary and sits well inside it.
 *
 * Real time rather than a `ManualScheduler`, matching its sibling
 * `ShardingRebalance.test.ts`: the coordinator's hand-off is driven by real
 * timers there, and the faults that matter here — loss, duplication,
 * reordering — need no clock at all. Only latency does, and none is injected.
 */

type PingCommand = { id: string; kind: 'ping'; payload?: string };
type Command = PingCommand;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'ping' }, () => this.onPing())
      .exhaustive();
  }

  private onPing(): void {
    this.sender.forEach((sender) => sender.tell('pong'));
  }
}

const TIGHT_FAILURE_DETECTOR = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

const ENTITY_COUNT = 16;

/**
 * Whether `region` still caches a shard home on `node`.
 *
 * Lifted from `ShardingRebalance.test.ts`, and not optional: a region routes
 * from a cached shard-to-node map and drops a dead node's entries only once it
 * has processed that node's `MemberRemoved`.  `awaitMembers` watches the
 * *cluster view*, which converges strictly earlier, so asking straight after
 * it sends every message for those shards at a host that is gone.
 *
 * Learned here the expensive way: without this wait the spec failed at the ask
 * — and failed identically **with no faults injected at all**, which is the
 * only reason it was not written up as "sharding does not survive a lossy
 * rebalance".  A chaos test that has not been run with its chaos turned off is
 * not evidence of anything.
 */
function cachesShardHomeOn(region: ActorRef<Command>, node: string): boolean {
  const internal = region as unknown as {
    getCell?: () => { actor?: { shardHomeNodes: Map<number, { toString(): string }> } };
  };
  const homes = internal.getCell?.().actor?.shardHomeNodes;
  if (!homes) return true;                    // not materialised yet — not ready
  return [...homes.values()].some((address) => address.toString() === node);
}

describe('sharding survives a link that degrades mid-rebalance', () => {
  test('every entity still answers when the survivors\' link turns lossy as a node dies', async () => {
    const spec = new MultiNodeSpec(MultiNodeSpecOptions.create()
      .withRoles(['a', 'b', 'c'])
      .withFailureDetector(TIGHT_FAILURE_DETECTOR)
      .withGossipIntervalMs(80)
      .withFaultSeed(10_231));
    try {
      await spec.start();
      await Promise.all(['a', 'b', 'c'].map((role) => spec.awaitMembers(role, 3)));

      const shardingOptions = StartShardingOptions.create<Command>()
        .withTypeName('entity')
        .withEntityActor(Entity)
        .withExtractEntityId((message) => message.id)
        .withNumShards(ENTITY_COUNT);
      const regions: Record<string, ActorRef<Command>> = {
        a: spec.clusterFor('a').sharding.start<Command>(shardingOptions),
        b: spec.clusterFor('b').sharding.start<Command>(shardingOptions),
        c: spec.clusterFor('c').sharding.start<Command>(shardingOptions),
      };

      // Let the coordinator finish its initial allocation.  A fixed wait, for
      // the same reason its sibling gives: nothing is asserted on it, and the
      // asks below carry their own budget.
      await sleep(300);
      const before = await Promise.all(
        Array.from({ length: ENTITY_COUNT }, (_unused, index) =>
          regions.a!.ask<string>({ id: `e-${index}`, kind: 'ping' }, 5_000)),
      );
      expect(before).toEqual(Array.from({ length: ENTITY_COUNT }, () => 'pong'));

      // The two events together, which is the point: the rebalance is starting
      // *and* the link the coordinator needs is getting worse.  Ordered crash
      // last so the degradation is already in force for the first frame of the
      // hand-off rather than a few frames into it.
      const crashedAddress = spec.addressFor('c').toString();
      spec.degrade('a', 'b', { dropProbability: 0.25, duplicateProbability: 0.25, reorderWindow: 3 });
      await spec.crash('c');

      await Promise.all([
        spec.awaitMembers('a', 2, 15_000),
        spec.awaitMembers('b', 2, 15_000),
      ]);
      await awaitCondition(
        () => !cachesShardHomeOn(regions.a!, crashedAddress)
          && !cachesShardHomeOn(regions.b!, crashedAddress),
        {
          timeoutMs: 30_000,
          intervalMs: 10,
          label: "both surviving regions dropped the crashed node's shard homes",
        },
      );

      // Restored before the asks, deliberately.  What is under test is whether
      // the rebalance *survived* a degraded network, not whether an ask can be
      // answered over one — the second question is real and belongs to the
      // delivery layer, and mixing them would make a failure ambiguous.
      spec.restore('a', 'b');

      const after = await Promise.all(
        Array.from({ length: ENTITY_COUNT }, (_unused, index) =>
          regions.b!.ask<string>({ id: `e-${index}`, kind: 'ping' }, 15_000)),
      );
      expect(after).toEqual(Array.from({ length: ENTITY_COUNT }, () => 'pong'));
    } finally {
      await spec.stop();
    }
  }, 90_000);
});
