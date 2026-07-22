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
  ClusterSingletonId,
  InMemoryTransport,
  NodeAddress,
  Props,
  StartSingletonOptions,
} from '../../src/index.js';

class Echo extends Actor<string> {
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
  return { sys: system, cluster, name: host };
}

async function main(): Promise<void> {
  const nodeA = await startNode('a', 8001);
  const nodeB = await startNode('b', 8002, ['cluster@a:8001']);
  const nodeC = await startNode('c', 8003, ['cluster@a:8001']);

  // Small wait so all three see each other.
  await Bun.sleep(250);

  // Each node starts its own ClusterSingletonManager with the same typeName
  // and the same Props — but only the leader's manager actually constructs it.
  for (const { sys, cluster, name } of [nodeA, nodeB, nodeC]) {
    sys.extension(ClusterSingletonId).start(cluster, StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withProps(Props.create(() => new Echo(name))));
  }

  await Bun.sleep(100);

  // Every node forwards "tell from X" through its local proxy — the leader
  // sees them all.
  nodeA.sys.extension(ClusterSingletonId).get<string>('echo').forEach(h => h.proxy.tell('tell from a'));
  nodeB.sys.extension(ClusterSingletonId).get<string>('echo').forEach(h => h.proxy.tell('tell from b'));
  nodeC.sys.extension(ClusterSingletonId).get<string>('echo').forEach(h => h.proxy.tell('tell from c'));

  await Bun.sleep(150);
  for (const { sys, cluster } of [nodeA, nodeB, nodeC]) {
    await cluster.leave();
    await sys.terminate();
  }
}

void main();
