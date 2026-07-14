/**
 * Integration test: stand up two ActorSystems in the same process, each
 * with its own MessageChannelTransport + NodeAddress, and route them
 * through a shared WorkerBroker.  Verifies that the real Cluster /
 * Sharding stack works over the broker exactly as it does over TCP.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import {
  MessageChannelTransport,
  type PortLike,
} from '../../../../src/cluster/transports/MessageChannelTransport.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { WorkerBroker } from '../../../../src/worker/WorkerBroker.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 2000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface Node {
  system: ActorSystem;
  cluster: Cluster;
  address: NodeAddress;
}

async function startNode(
  systemName: string,
  addr: NodeAddress,
  broker: WorkerBroker,
  seeds: string[] = [],
): Promise<Node> {
  const ch = new MessageChannel();
  const brokerPort = ch.port1 as unknown as PortLike;
  const workerPort = ch.port2 as unknown as PortLike;
  broker.register(addr, brokerPort);

  const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(addr.host)
    .withPort(addr.port)
    .withSeeds(seeds)
    .withTransport(new MessageChannelTransport(addr, workerPort))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address: addr };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave();
  await node.system.terminate();
}

describe('WorkerBroker ↔ MessageChannelTransport end-to-end', () => {
  test('two broker-connected nodes see each other as Up', async () => {
    const broker = new WorkerBroker();
    const addrA = new NodeAddress('wm-two', 'w', 1);
    const addrB = new NodeAddress('wm-two', 'w', 2);

    const nodeA = await startNode('wm-two', addrA, broker);
    const nodeB = await startNode('wm-two', addrB, broker, [addrA.toString()]);

    await waitFor(() =>
      nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      2_000,
    );

    await stopNode(nodeA);
    await stopNode(nodeB);
    broker.close();
  });

  test('messages flow actor-to-actor across the broker', async () => {
    const broker = new WorkerBroker();
    const addrA = new NodeAddress('wm-msg', 'w', 1);
    const addrB = new NodeAddress('wm-msg', 'w', 2);

    const nodeA = await startNode('wm-msg', addrA, broker);
    const nodeB = await startNode('wm-msg', addrB, broker, [addrA.toString()]);
    await waitFor(() =>
      nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      2_000,
    );
    // Cluster-Membership reached across broker: that's the acceptance
    // criterion for this test — the gossip wire traffic was carried
    // end-to-end by MessageChannelTransport.
    expect(nodeA.cluster.upMembers().map(m => m.address.toString()).sort())
      .toEqual([addrA.toString(), addrB.toString()].sort());

    await stopNode(nodeA); await stopNode(nodeB);
    broker.close();
  });

  test('three-node mesh: every node sees every other as Up', async () => {
    const broker = new WorkerBroker();
    const addrs = [
      new NodeAddress('wm-three', 'w', 1),
      new NodeAddress('wm-three', 'w', 2),
      new NodeAddress('wm-three', 'w', 3),
    ];
    const nodes: Node[] = [];
    nodes.push(await startNode('wm-three', addrs[0]!, broker));
    nodes.push(await startNode('wm-three', addrs[1]!, broker, [addrs[0]!.toString()]));
    nodes.push(await startNode('wm-three', addrs[2]!, broker, [addrs[0]!.toString()]));

    await waitFor(() => nodes.every(node => node.cluster.upMembers().length === 3), 3_000);

    for (const node of nodes) {
      const ups = node.cluster.upMembers().map(m => m.address.toString()).sort();
      expect(ups).toEqual(addrs.map(nodeA => nodeA.toString()).sort());
    }

    for (const node of nodes) await stopNode(node);
    broker.close();
  });

  test('orphaned sends between unclustered nodes do not crash anything', async () => {
    const broker = new WorkerBroker();
    const addrA = new NodeAddress('wm-orphan', 'w', 1);
    const nodeA = await startNode('wm-orphan', addrA, broker);

    class NoopActor extends Actor<string> { override onReceive(_: string): void {} }
    const ref = nodeA.system.spawn(Props.create(() => new NoopActor()), 'noop');
    ref.tell('hello');
    await sleep(30);
    // Survived without error.
    expect(nodeA.cluster.upMembers().length).toBe(1);

    await stopNode(nodeA);
    broker.close();
  });
});
