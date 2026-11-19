/**
 * #1813 — over real TCP, a node's own share of the routed traffic arrives.
 *
 * `ClusterRouter` routes to every matching member through a `RemoteActorRef`,
 * its own node included, and leaves loopback to the transport.  The in-memory
 * transport the other router tests use always looped back; `TcpTransport`, the
 * default, did not, so a role-less round-robin router over two TCP nodes
 * delivered half its messages and silently lost the half meant for its own
 * node.  These cases run the default transport on 127.0.0.1 and count
 * deliveries per node.
 */
import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { Actor } from '../../src/Actor.js';
import { ActorSystem } from '../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../src/ActorSystemOptions.js';
import { Cluster } from '../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../src/cluster/ClusterOptions.js';
import { RemoteActorRef } from '../../src/cluster/RemoteActorRef.js';
import { ClusterRouter, ClusterRouterOptions } from '../../src/cluster/router/index.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { awaitCondition } from '../util/AwaitCondition.js';

const HOST = '127.0.0.1';

type Node = {
  readonly sys: ActorSystem;
  readonly cluster: Cluster;
  readonly received: string[];
};

/** A port the OS just handed out, so no fixed number can collide with a reserved range. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startNode(systemName: string, port: number, seeds: string[]): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(HOST)
    .withPort(port)
    .withSeeds(seeds)
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(sys, clusterOptions);
  const received: string[] = [];
  class Sink extends Actor<string> {
    override onReceive(message: string): void { received.push(message); }
  }
  sys.spawn(Sink, 'sink');
  return { sys, cluster, received };
}

async function stop(node: Node): Promise<void> {
  try { await node.cluster.leave(); } catch { /* already gone */ }
  await node.sys.terminate();
}

describe('ClusterRouter over TcpTransport (#1813)', () => {
  test('a tell to a RemoteActorRef naming the local node is delivered', async () => {
    const systemName = 'loopback-tell';
    const node = await startNode(systemName, await freePort(), []);
    try {
      const own = new RemoteActorRef<string>(node.cluster.selfAddress, '/user/sink', node.cluster);
      own.tell('one');
      own.tell('two');
      own.tell('three');

      await awaitCondition(() => node.received.length === 3, {
        timeoutMs: 5_000, intervalMs: 20, label: 'three tells to the local node arrived',
      });
      expect(node.received).toEqual(['one', 'two', 'three']);
    } finally {
      await stop(node);
    }
  }, 15_000);

  test('a role-less round-robin router over two TCP nodes delivers both shares', async () => {
    const systemName = 'loopback-router';
    const portA = await freePort();
    const nodeA = await startNode(systemName, portA, []);
    const nodeB = await startNode(systemName, await freePort(), [`${systemName}@${HOST}:${portA}`]);
    try {
      await awaitCondition(() => nodeA.cluster.upMembers().length === 2, {
        timeoutMs: 10_000, intervalMs: 25, label: 'both nodes are up in A\'s view',
      });
      const routerOptions = ClusterRouterOptions.create<string>()
        .withCluster(nodeA.cluster)
        .withRouterType('round-robin')
        .withRouteePath('/user/sink');
      const router = nodeA.sys.spawn(ClusterRouter.factory<string>(routerOptions), 'router');

      // The router drops what arrives before its routees are built; warm up
      // until a delivery lands on each node.  A warm-up still in flight is
      // filtered out of the count below, and the ten are consecutive in the
      // router's mailbox, so round-robin alternates them strictly.
      await awaitCondition(() => {
        router.tell('warm-up');
        return nodeA.received.includes('warm-up') && nodeB.received.includes('warm-up');
      }, { timeoutMs: 10_000, intervalMs: 50, label: 'the router reached both nodes' });

      for (let i = 0; i < 10; i++) router.tell(`m${i}`);

      await awaitCondition(
        () => nodeA.received.filter((m) => m !== 'warm-up').length + nodeB.received.filter((m) => m !== 'warm-up').length === 10,
        { timeoutMs: 5_000, intervalMs: 20, label: 'all ten routed messages arrived' },
      );
      expect(nodeA.received.filter((m) => m !== 'warm-up')).toHaveLength(5);
      expect(nodeB.received.filter((m) => m !== 'warm-up')).toHaveLength(5);
    } finally {
      await stop(nodeB);
      await stop(nodeA);
    }
  }, 30_000);
});
