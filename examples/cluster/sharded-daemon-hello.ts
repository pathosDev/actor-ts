/**
 * Hello Sharded Daemon Process: spin up 6 daemons across a single-node
 * "cluster".  Every daemon has a stable index and prints a message when
 * it's told to work.  Ideal for grasping the "N workers, located by index"
 * shape before you wire up multiple nodes.
 *
 *   bun run examples/cluster/sharded-daemon-hello.ts
 */
import {
  Actor,
} from '../../src/index.js';
import {
  Cluster,
  ClusterBootstrapOptions,
  InMemoryTransport,
  NodeAddress,
  ShardedDaemonProcess,
  ShardedDaemonProcessOptions,
} from '../../src/cluster/index.js';

class Worker extends Actor<string> {
  constructor(private readonly index: number) { super(); }
  override preStart(): void { console.log(`worker#${this.index} started`); }
  override onReceive(job: string): void { console.log(`worker#${this.index} processes: ${job}`); }
}

async function main(): Promise<void> {
  // `Cluster.bootstrap` packages ActorSystem.create + Cluster.join +
  // signal-based shutdown into one call.  For this single-node demo
  // we still hand it an `InMemoryTransport` and turn off the SIGTERM
  // wiring so the script can shut itself down at the end.
  const { system, cluster, shutdown } = await Cluster.bootstrap(
    ClusterBootstrapOptions.create('daemon-hello')
      .withHost('local')
      .withPort(1)
      .withTransport(new InMemoryTransport(new NodeAddress('daemon-hello', 'local', 1)))
      .withReceptionist(false)
      .withShutdownOnSignals(false));

  const handle = ShardedDaemonProcess.init<string>(system, cluster,
    ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(6)
      .withActorFor((i) => () => new Worker(i)));
  // Not a drain sleep: waits for the coordinator to place the six daemons.
  await Bun.sleep(100);

  handle.tell(0, 'job-A');
  handle.tell(3, 'job-B');
  handle.tell(5, 'job-C');

  // Not a drain sleep either.  A sharded tell goes shard region → entity, and
  // both of those live under `/system`, which terminate() deliberately does
  // not drain — so there is nothing here for the drain to have waited on.
  await Bun.sleep(80);
  await shutdown();
}

void main();
