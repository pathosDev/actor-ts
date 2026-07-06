/**
 * Realistic Sharded Daemon Process: a 3-node cluster hosts a fixed pool of
 * 9 "partition workers".  Each worker owns a stable partition number and
 * continuously polls for jobs on that partition.  LeastShardAllocationStrategy
 * spreads them evenly across nodes.
 *
 *   bun run examples/cluster/sharded-daemon-fixed-workers.ts
 *
 * Expected output: 9 "worker@X started on host Y" lines (roughly 3 per node)
 * followed by a stream of partition-keyed poll-ticks.
 */
import {
  Actor,
  ActorSystem,
  Cluster,
  ClusterBootstrapOptions,
  InMemoryTransport,
  NodeAddress,
  Props,
  ShardedDaemonProcess,
  ShardedDaemonProcessOptions,
} from '../../src/index.js';

class PartitionWorker extends Actor<string> {
  constructor(private readonly partition: number, private readonly host: string) { super(); }
  override preStart(): void {
    console.log(`worker@${this.partition} started on host ${this.host}`);
    this.context.timers.startTimerWithFixedDelay('poll', 'poll', 150, 50);
  }
  override onReceive(m: string): void {
    if (m === 'poll') console.log(`  host=${this.host} partition=${this.partition}: polling queue`);
    else console.log(`  host=${this.host} partition=${this.partition}: job=${m}`);
  }
}

async function startNode(host: string, port: number, seeds: string[] = []): Promise<{
  sys: ActorSystem; cluster: Cluster; name: string;
}> {
  const { system, cluster } = await Cluster.bootstrap(
    ClusterBootstrapOptions.create('fixed-workers')
      .withHost(host)
      .withPort(port)
      .withSeeds(seeds)
      .withTransport(new InMemoryTransport(new NodeAddress('fixed-workers', host, port)))
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
      .withGossipIntervalMs(80)
      .withReceptionist(false)
      .withShutdownOnSignals(false));
  return { sys: system, cluster, name: host };
}

async function main(): Promise<void> {
  const a = await startNode('a', 10_001);
  const b = await startNode('b', 10_002, ['fixed-workers@a:10001']);
  const c = await startNode('c', 10_003, ['fixed-workers@a:10001']);
  await Bun.sleep(300);

  // Each node calls init — the coordinator (on the leader) places each
  // daemon on exactly one node.
  for (const { sys, cluster, name } of [a, b, c]) {
    ShardedDaemonProcess.init<string>(sys, cluster,
      ShardedDaemonProcessOptions.create<string>()
        .withName('partitions')
        .withNumDaemons(9)
        .withBehaviorFor((i) => Props.create(() => new PartitionWorker(i, name))));
  }

  // Let the daemons poll for a while so the distribution is observable.
  await Bun.sleep(1_500);

  for (const n of [a, b, c]) { await n.cluster.leave(); await n.sys.terminate(); }
}

void main();
