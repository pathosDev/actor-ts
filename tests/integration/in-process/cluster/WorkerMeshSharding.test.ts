/**
 * Cluster sharding over the worker-mesh rig (#1564): three real `Cluster`
 * nodes on `MessageChannelTransport`s through one `WorkerBroker`, all on
 * this thread.  Sharding computes only in `NodeAddress`, so a thread is a
 * node to it and nothing here is mesh-specific — which is exactly the claim
 * the old `WorkerMesh.test.ts` header made and never checked: entities of one
 * type spread over the nodes by shard hash, and after a node leaves, the
 * entities it hosted come back to life on the nodes that remain.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { StartShardingOptions } from '../../../../src/cluster/sharding/StartShardingOptions.js';
import { MessageChannelTransport, type PortLike } from '../../../../src/cluster/transports/MessageChannelTransport.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { WorkerBroker } from '../../../../src/worker/WorkerBroker.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type Command = { readonly id: string; readonly kind: 'where'; readonly replyTo: ActorRef<string> };

/** An entity that answers with the node it was created on. */
class Entity extends Actor<Command> {
  override onReceive(command: Command): void {
    command.replyTo.tell(this.cluster.selfAddress.toString());
  }
}

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
  readonly region: ActorRef<Command>;
};

const SYSTEM_NAME = 'wm-sharding';

async function startNode(port: number, broker: WorkerBroker, seeds: string[] = []): Promise<Node> {
  const address = new NodeAddress(SYSTEM_NAME, 'w', port);
  const channel = new MessageChannel();
  broker.register(address, channel.port1 as unknown as PortLike);
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(SYSTEM_NAME, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(address.port)
    .withSeeds(seeds)
    .withTransport(new MessageChannelTransport(address, channel.port2 as unknown as PortLike))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 300, downAfterMs: 600 })
    .withGossipIntervalMs(40);
  const cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<Command>()
    .withTypeName('entity')
    .withEntityActor(Entity)
    .withExtractEntityId((command) => command.id)
    .withNumShards(16);
  const region = cluster.sharding.start<Command>(shardingOptions);
  return { system, cluster, address, region };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.system.terminate();
}

const IDS = Array.from({ length: 24 }, (_, i) => `entity-${i}`);

async function homesOf(node: Node): Promise<Map<string, string>> {
  const homes = new Map<string, string>();
  for (const id of IDS) homes.set(id, await node.region.ask<string>({ id, kind: 'where' }, 5_000));
  return homes;
}

describe('sharding across the worker-mesh rig (#1564)', () => {
  test('entities spread over the nodes by shard hash, and re-home onto the survivors after a node leaves', async () => {
    const broker = new WorkerBroker();
    const seed = await startNode(1, broker);
    const second = await startNode(2, broker, [seed.address.toString()]);
    const third = await startNode(3, broker, [seed.address.toString()]);
    const nodes = [seed, second, third];
    try {
      await awaitCondition(() => nodes.every((node) => node.cluster.upMembers().length === 3), { timeoutMs: 8_000, label: 'three members up' });
      await awaitCondition(() => nodes.every((node) => node.cluster.sharding.isRegistered('entity')), { timeoutMs: 8_000, label: 'every region registered' });

      const before = await homesOf(seed);
      const hosts = new Set(before.values());
      // Sixteen shards over three nodes: the allocation spreads them, so
      // twenty-four entities land on at least two nodes — and the same
      // answer comes from any node's region, because the shard map is one.
      expect(hosts.size).toBeGreaterThanOrEqual(2);
      for (const host of hosts) expect(nodes.map((node) => node.address.toString())).toContain(host);
      const viaSecond = await homesOf(second);
      expect(viaSecond).toEqual(before);

      const evicted = [...before.entries()].filter(([, host]) => host === third.address.toString()).map(([id]) => id);
      expect(evicted.length).toBeGreaterThan(0);
      await stopNode(third);
      await awaitCondition(() => [seed, second].every((node) => node.cluster.upMembers().length === 2), { timeoutMs: 8_000, label: 'two members left' });

      // Every entity answers again — the ones the departed node hosted are
      // re-created on a survivor — and nothing points at the node that left.
      const after = await homesOf(seed);
      for (const id of evicted) {
        expect(after.get(id)).not.toBe(third.address.toString());
        expect([seed.address.toString(), second.address.toString()]).toContain(after.get(id)!);
      }
      expect(new Set(after.values()).has(third.address.toString())).toBe(false);
    } finally {
      for (const node of nodes) {
        if (!node.system._isTerminating()) await stopNode(node);
      }
      broker.close();
    }
  }, 40_000);
});
