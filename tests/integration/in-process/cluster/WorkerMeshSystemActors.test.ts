/**
 * Framework actors on the workers of a mesh (#1564, #1563): the role-based
 * placement the cluster already has, exercised on the worker-mesh rig — one
 * main-shaped node and two worker-shaped nodes, all real `Cluster`s on
 * `MessageChannelTransport`s through one `WorkerBroker`, on this thread.
 *
 * Two facts the parallelism docs rest on: a singleton with a role that only
 * the workers carry runs on a worker, however the leader is placed; and the
 * shard coordinator follows the leader — the lowest address — so when the
 * leader leaves, the next address takes it over and sharding keeps answering.
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
import { StartSingletonOptions } from '../../../../src/cluster/singleton/StartSingletonOptions.js';
import { MessageChannelTransport, type PortLike } from '../../../../src/cluster/transports/MessageChannelTransport.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { WorkerBroker } from '../../../../src/worker/WorkerBroker.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type Where = { readonly kind: 'where'; readonly replyTo: ActorRef<string> };
type EntityCommand = { readonly id: string; readonly kind: 'where'; readonly replyTo: ActorRef<string> };

class Reporter extends Actor<Where> {
  override onReceive(command: Where): void {
    command.replyTo.tell(this.cluster.selfAddress.toString());
  }
}

class Entity extends Actor<EntityCommand> {
  override onReceive(command: EntityCommand): void {
    command.replyTo.tell(this.cluster.selfAddress.toString());
  }
}

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
  readonly region: ActorRef<EntityCommand>;
};

const SYSTEM_NAME = 'wm-system';

async function startNode(host: string, port: number, roles: string[], broker: WorkerBroker, seeds: string[] = []): Promise<Node> {
  const address = new NodeAddress(SYSTEM_NAME, host, port);
  const channel = new MessageChannel();
  broker.register(address, channel.port1 as unknown as PortLike);
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(SYSTEM_NAME, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withRoles(roles)
    .withSeeds(seeds)
    .withTransport(new MessageChannelTransport(address, channel.port2 as unknown as PortLike))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 300, downAfterMs: 600 })
    .withGossipIntervalMs(40);
  const cluster = await Cluster.join(system, clusterOptions);
  const shardingOptions = StartShardingOptions.create<EntityCommand>()
    .withTypeName('entity')
    .withEntityActor(Entity)
    .withExtractEntityId((command) => command.id)
    .withNumShards(8);
  const region = cluster.sharding.start<EntityCommand>(shardingOptions);
  return { system, cluster, address, region };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.system.terminate();
}

describe('framework actors on the workers of a mesh (#1564)', () => {
  test('a singleton with the workers’ role runs on a worker while the main thread leads; the coordinator follows the leader when it leaves', async () => {
    const broker = new WorkerBroker();
    // `main` sorts before `worker`, so the main-shaped node is the leader —
    // the mesh's default hostnames, deliberately.
    const main = await startNode('main', 1, [], broker);
    const workerA = await startNode('worker', 2, ['compute'], broker, [main.address.toString()]);
    const workerB = await startNode('worker', 3, ['compute'], broker, [main.address.toString()]);
    const nodes = [main, workerA, workerB];
    const stopped = new Set<Node>();
    try {
      await awaitCondition(() => nodes.every((node) => node.cluster.upMembers().length === 3), { timeoutMs: 8_000, label: 'three members up' });
      expect(main.cluster.isLeader()).toBe(true);
      expect(main.cluster.leader().map((m) => m.address.toString()).getOrElse('none')).toBe('wm-system@main:1');

      // The singleton is started on every node, as the API asks; its role
      // keeps it off the leader, because the leader carries no `compute`.
      const proxies = nodes.map((node) => node.cluster.singleton.start(
        StartSingletonOptions.create<Where>().withTypeName('reporter').withActor(Reporter).withRole('compute'),
      ));
      const homes = await Promise.all(proxies.map((proxy) => proxy.ask<string>({ kind: 'where' }, 8_000)));
      expect(new Set(homes).size).toBe(1);
      expect(homes[0]!.startsWith('wm-system@worker:')).toBe(true);

      // The coordinator sits with the leader; sharding answers through it.
      await awaitCondition(() => nodes.every((node) => node.cluster.sharding.isRegistered('entity')), { timeoutMs: 8_000, label: 'every region registered' });
      const before = await workerA.region.ask<string>({ id: 'e-1', kind: 'where' }, 5_000);
      expect(nodes.map((node) => node.address.toString())).toContain(before);

      // The leader leaves: the next address leads, the coordinator moves with
      // it, and the regions that remain re-register and keep answering.
      await stopNode(main);
      stopped.add(main);
      await awaitCondition(() => workerA.cluster.isLeader() && workerB.cluster.upMembers().length === 2, { timeoutMs: 8_000, label: 'worker A leads' });
      await awaitCondition(() => [workerA, workerB].every((node) => node.cluster.sharding.isRegistered('entity')), { timeoutMs: 8_000, label: 'regions re-registered' });
      const after = await workerB.region.ask<string>({ id: 'e-2', kind: 'where' }, 5_000);
      expect(['wm-system@worker:2', 'wm-system@worker:3']).toContain(after);
      // And the singleton, whose role never included the leader, is still on a worker.
      const stillThere = await proxies[1]!.ask<string>({ kind: 'where' }, 8_000);
      expect(stillThere.startsWith('wm-system@worker:')).toBe(true);
    } finally {
      for (const node of nodes) {
        if (!stopped.has(node)) await stopNode(node);
      }
      broker.close();
    }
  }, 40_000);
});
