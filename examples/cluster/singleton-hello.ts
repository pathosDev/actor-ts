/**
 * Hello-Singleton: three nodes join a cluster; only one (the leader) ever
 * hosts the singleton actor.  Each node's proxy forwards messages to
 * whichever node is currently the leader.
 *
 *   bun run examples/cluster/singleton-hello.ts
 *
 * Expected output: the "HostedOn..." log line appears exactly once (on the
 * leader), and every "tell from nodeX" arrives at the same node.
 */
import {
  Actor,
  ActorSystem,
  Cluster,
  ClusterBootstrapOptions,
  InMemoryTransport,
  NodeAddress,
  SingletonKey,
} from '../../src/index.js';
import { attachDevTools } from '../devtools.js';

class Echo extends Actor<string> {
  /**
   * The singleton's identity, declared on the actor itself.  The explicit type
   * argument is what lets `start` / `ref` hand back an `ActorRef<string>`
   * instead of `ActorRef<unknown>`.
   */
  static readonly singleton = SingletonKey.of<string>('echo');

  constructor(private readonly where: string) { super(); }
  override preStart(): void { console.log(`[${this.where}] HostedOn=${this.where} — singleton started here`); }
  override onReceive(message: string): void { console.log(`[${this.where}] received '${message}'`); }
  override postStop(): void { console.log(`[${this.where}] singleton stopped here`); }
}

// `Cluster.bootstrap` builds the ActorSystem + Cluster + Receptionist
// + SIGTERM/SIGINT wiring in one call.  For this in-process demo we
// still hand it an `InMemoryTransport` (so the three "nodes" can
// talk without real TCP) and disable signal handlers (so the demo
// shuts down on its own).
async function startNode(host: string, port: number, seeds: string[] = []): Promise<{ sys: ActorSystem; cluster: Cluster; name: string }> {
  const { system, cluster } = await Cluster.bootstrap(
    ClusterBootstrapOptions.create('cluster')
      .withHost(host)
      .withPort(port)
      .withSeeds(seeds)
      .withTransport(new InMemoryTransport(new NodeAddress('cluster', host, port)))
      .withGossipIntervalMs(80)
      .withReceptionist(false)
      .withShutdownOnSignals(false));
  await attachDevTools(system);
  return { sys: system, cluster, name: host };
}

async function main(): Promise<void> {
  const nodeA = await startNode('a', 8001);
  const nodeB = await startNode('b', 8002, ['cluster@a:8001']);
  const nodeC = await startNode('c', 8003, ['cluster@a:8001']);

  // Small wait so all three see each other.
  await Bun.sleep(250);

  // Each node starts its own ClusterSingletonManager for the same key — but
  // only the leader's manager actually constructs the Echo actor.  `Echo`
  // needs a constructor argument, so the factory form is used.
  for (const { cluster, name } of [nodeA, nodeB, nodeC]) {
    cluster.singleton.start(Echo, () => new Echo(name));
  }

  await Bun.sleep(100);

  // Every node forwards "tell from X" through its local proxy — the leader
  // sees them all.  `ref` returns the same memoised proxy `start` did.
  nodeA.cluster.singleton.ref(Echo).tell('tell from a');
  nodeB.cluster.singleton.ref(Echo).tell('tell from b');
  nodeC.cluster.singleton.ref(Echo).tell('tell from c');

  await Bun.sleep(150);
  for (const { sys, cluster } of [nodeA, nodeB, nodeC]) {
    await cluster.leave();
    await sys.terminate();
  }
}

void main();
