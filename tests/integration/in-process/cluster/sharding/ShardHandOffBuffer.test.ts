import { match } from 'ts-pattern';
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { hashShardId } from '../../../../../src/cluster/sharding/ShardAllocator.js';
import { StartShardingOptions } from '../../../../../src/cluster/sharding/StartShardingOptions.js';
import type { ShardingMessage } from '../../../../../src/cluster/sharding/ShardingProtocol.js';
import { regionSegments } from '../../../../util/systemPaths.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';

/**
 * `completeHandOff` used to clear `shardHomes` without ever replaying the
 * buffer (#893).  Messages queued while the shard was in `'handing-off'` then
 * sat there until some unrelated later message for the same shard happened to
 * miss the cache and re-ask the coordinator — indefinitely, on a shard that
 * went quiet after the rebalance.
 *
 * The handoff is driven by telling the region a `HandOff` directly rather than
 * by provoking a rebalance: it is the same message the coordinator sends, and
 * it makes the buffering window deterministic instead of a race against the
 * rebalance timer.
 */

type WorkCommand = { id: string; kind: 'work' };

type Command = WorkCommand;

const TYPE_NAME = 'entity';
const NUM_SHARDS = 4;
const ENTITY_ID = 'user-1';

let delivered = 0;

class Entity extends Actor<Command> {
  override onReceive(message: Command): void {
    match(message)
      .with({ kind: 'work' }, () => this.onWork())
      .exhaustive();
  }

  private onWork(): void { delivered++; }
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Command>;
};

let running: Node | null = null;

async function startNode(systemName: string, port: number): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([])
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(system, clusterOptions);

  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName(TYPE_NAME)
    .withEntityActor(() => new Entity())
    .withExtractEntityId((message) => message.id)
    .withNumShards(NUM_SHARDS)
    // Irrelevant here, and a sweep firing mid-handoff would only add noise.
    .withPassivationIdleMs(0);

  const region = cluster.sharding.start<Command>(shardingOptions);
  const node = { system, cluster, region };
  running = node;
  return node;
}

/** The region actor itself, so a test can hand it a coordinator-side message. */
function regionRef(node: Node): ActorRef<ShardingMessage> {
  const resolved = node.system._resolvePath(regionSegments(node.system.name, TYPE_NAME));
  if (resolved.isNone()) throw new Error('region actor not found');
  return resolved.value as ActorRef<ShardingMessage>;
}

afterEach(async () => {
  if (running) {
    await running.cluster.leave();
    await running.system.terminate();
    running = null;
  }
  delivered = 0;
});

describe('ClusterSharding — handoff buffer (#893)', () => {
  test('messages buffered during a handoff are delivered once it completes', async () => {
    const node = await startNode('handoff-buffer', 47_200);
    const shardId = hashShardId(ENTITY_ID, NUM_SHARDS);

    node.region.tell({ id: ENTITY_ID, kind: 'work' });
    await waitFor(() => delivered === 1);

    // Begin the handoff, then queue behind it. The region is single-threaded,
    // so by the time it reads this second message the shard is already marked
    // `'handing-off'` and the message can only be buffered.
    regionRef(node).tell({ $t: 'sharding.HandOff', shardId });
    node.region.tell({ id: ENTITY_ID, kind: 'work' });

    // Single node, so the coordinator hands the shard straight back — the only
    // thing that can keep this message from arriving is nobody replaying it.
    await waitFor(() => delivered === 2);
    expect(delivered).toBe(2);
  });

  test('a handoff with nothing buffered asks for nothing', async () => {
    // The re-ask is conditional on purpose: an idle shard that rebalances away
    // must not be pulled back by the region it just left.
    const node = await startNode('handoff-quiet', 47_201);
    const shardId = hashShardId(ENTITY_ID, NUM_SHARDS);

    node.region.tell({ id: ENTITY_ID, kind: 'work' });
    await waitFor(() => delivered === 1);

    regionRef(node).tell({ $t: 'sharding.HandOff', shardId });
    await sleep(200);

    // Nothing was queued, so nothing may be delivered — and the shard stays
    // wherever the coordinator put it.
    expect(delivered).toBe(1);
  });
});
