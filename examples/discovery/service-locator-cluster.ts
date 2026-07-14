/**
 * Realistic Receptionist: a 3-node cluster where each node registers a
 * locally-hosted "Worker" under a shared ServiceKey.  A client on node A
 * Subscribes to the key and streams listings as the set changes.  When
 * node C leaves, its worker is auto-removed from the listing.
 *
 *   bun run examples/discovery/service-locator-cluster.ts
 */
import {
  Actor,
  ActorSystem,
  Cluster,
  ClusterOptions,
  InMemoryTransport,
  Listing,
  NodeAddress,
  Props,
  ReceptionistId,
  ReceptionistOptions,
  ReceptionistSubscribe as Subscribe,
  Register,
  ServiceKey,
} from '../../src/index.js';

class Worker extends Actor<string> {
  constructor(private readonly host: string) { super(); }
  override onReceive(m: string): void { console.log(`[worker@${this.host}] got ${m}`); }
}

class StreamClient extends Actor<Listing<string>> {
  override onReceive(listing: Listing<string>): void {
    console.log(`[client] Listing ${listing.key.id}: ${listing.refs.length} worker(s)`);
    for (const ref of listing.refs) console.log(`   - ${ref.toString()}`);
  }
}

async function startNode(host: string, port: number, seeds: string[] = []): Promise<{ sys: ActorSystem; cluster: Cluster; name: string }> {
  const sys = ActorSystem.create('service-locator');
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress('service-locator', host, port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(sys, clusterOptions);
  return { sys, cluster, name: host };
}

async function main(): Promise<void> {
  const nodeA = await startNode('a', 11_001);
  const nodeB = await startNode('b', 11_002, ['service-locator@a:11001']);
  const nodeC = await startNode('c', 11_003, ['service-locator@a:11001']);

  await Bun.sleep(300);

  const key = ServiceKey.of<string>('workers');

  for (const { sys, cluster, name } of [nodeA, nodeB, nodeC]) {
    const receptionistOptions = ReceptionistOptions.create().withGossipIntervalMs(80);
    const receptionist = sys.extension(ReceptionistId).start(cluster, receptionistOptions);
    const worker = sys.spawn(Props.create(() => new Worker(name)), `worker-${name}`);
    receptionist.tell(new Register(key, worker));
  }

  // Subscribe on node A; expect to see 1, then 2, then 3 workers over time.
  const aReceptionist = nodeA.sys.extension(ReceptionistId).get()!;
  const client = nodeA.sys.spawn(Props.create(() => new StreamClient()), 'client');
  aReceptionist.tell(new Subscribe(key, client));

  await Bun.sleep(500);
  console.log('--- node C leaves ---');
  await nodeC.cluster.leave();
  await nodeC.sys.terminate();

  // Wait for gossip to drop C's worker from the view.
  await Bun.sleep(500);

  for (const node of [nodeA, nodeB]) { await node.cluster.leave(); await node.sys.terminate(); }
}

void main();
