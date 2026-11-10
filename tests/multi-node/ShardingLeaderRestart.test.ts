/**
 * #1272 criterion 4 — the leader restarts at the same address under traffic,
 * and no entity id is ever live on two nodes.
 *
 * The leader is the lowest address, so a node restarted at it becomes leader
 * again as soon as it is up, and its coordinator takes over from a cluster
 * whose regions still host every shard.  Before the registration barrier the
 * new coordinator placed the first shards it was asked about on its own
 * region while a survivor still ran them.
 *
 * Ground truth is the entities themselves: every incarnation adds its node to
 * a process-wide registry in `preStart` and removes it in `postStop`, so an
 * overlap is caught at the instant it happens rather than sampled.  The spec
 * runs every node in this process, which is what makes one registry possible.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../src/Actor.js';
import type { ActorRef } from '../../src/ActorRef.js';
import { StartShardingOptions } from '../../src/cluster/sharding/StartShardingOptions.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeSpecOptions } from '../../src/testkit/MultiNodeSpecOptions.js';
import { sleep } from '../util/AwaitCondition.js';

type Command = { readonly id: string; readonly kind: 'ping' };

const ENTITY_COUNT = 40;
const ids = Array.from({ length: ENTITY_COUNT }, (_, i) => `e${i}`);

/** Where each entity id is live right now, by node. */
const liveOn = new Map<string, Set<string>>();
/** Every moment an id was live on two nodes at once. */
const overlaps: string[] = [];

class Entity extends Actor<Command> {
  private get node(): string { return this.context.system.name; }

  override preStart(): void {
    const nodes = liveOn.get(this.entityId) ?? new Set<string>();
    if (nodes.size > 0 && !nodes.has(this.node)) {
      overlaps.push(`${this.entityId} on ${[...nodes].join('+')} and ${this.node}`);
    }
    nodes.add(this.node);
    liveOn.set(this.entityId, nodes);
  }

  override postStop(): void {
    liveOn.get(this.entityId)?.delete(this.node);
  }

  override onReceive(command: Command): void {
    this.sender.forEach((sender) => sender.tell(`${command.id}@${this.node}`));
  }
}

const regions = new Map<string, ActorRef<Command>>();

let spec: MultiNodeSpec | null = null;

afterEach(async () => {
  await spec?.stop();
  spec = null;
  liveOn.clear();
  overlaps.length = 0;
  regions.clear();
});

describe('the leader restarts at the same address under traffic (#1272)', () => {
  test('no entity id is ever live on two nodes, and every id keeps answering', async () => {
    const options = MultiNodeSpecOptions.create()
      .withRoles(['a', 'b', 'c'])
      .withGossipIntervalMs(50)
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 250, downAfterMs: 800 })
      .withNodeSetup((role, _system, cluster) => {
        const shardingOptions = StartShardingOptions.create<Command>()
          .withTypeName('entity')
          .withEntityActor(Entity)
          .withExtractEntityId((command) => command.id)
          .withNumShards(20)
          .withPassivationIdleMs(0)
          .withRebalanceIntervalMs(60_000);
        regions.set(role, cluster.sharding.start<Command>(shardingOptions));
      });
    spec = new MultiNodeSpec(options);
    const running = spec;
    await running.start();
    for (const role of ['a', 'b', 'c']) await running.awaitMembers(role, 3);

    // Every id comes up somewhere, spread over the three regions.
    const answered = async (from: string): Promise<number> => {
      const replies = await Promise.allSettled(
        ids.map((id) => regions.get(from)!.ask<string>({ id, kind: 'ping' }, 3_000)),
      );
      return replies.filter((reply) => reply.status === 'fulfilled').length;
    };
    expect(await answered('b')).toBe(ENTITY_COUNT);

    // Traffic throughout, every id again and again: from a survivor, and from
    // the restarted node as soon as its region exists.  The second is the one
    // that matters — the restarted region knows no home at all, so it asks its
    // own node's coordinator, which has just become leader, about shards the
    // survivors still run.
    let traffic = true;
    const pinger = (async () => {
      while (traffic) {
        for (const role of ['a', 'b']) {
          const region = regions.get(role);
          if (region !== undefined) for (const id of ids) region.tell({ id, kind: 'ping' });
        }
        // The traffic's own pace, not a wait for a state: it stops on a flag.
        await sleep(5);
      }
    })();
    regions.delete('a');

    await running.restart('a');
    for (const role of ['a', 'b', 'c']) await running.awaitMembers(role, 3);
    for (const role of ['a', 'b', 'c']) await running.awaitLeader(role, 'a');
    // Traffic keeps flowing for a while after the restart — the window the
    // assertion is about is a duration, so the elapsed time IS the point.
    await sleep(2_000);
    traffic = false;
    await pinger;

    expect(overlaps).toEqual([]);
    expect(await answered('b')).toBe(ENTITY_COUNT);
    expect(await answered('a')).toBe(ENTITY_COUNT);
  }, 60_000);
});
