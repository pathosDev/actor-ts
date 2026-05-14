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
  Cluster,
  InMemoryTransport,
  NodeAddress,
  Props,
  ShardedDaemonProcess,
} from '../../src/index.js';

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
  const { system, cluster, shutdown } = await Cluster.bootstrap({
    name: 'daemon-hello',
    host: 'local', port: 1,
    transport: new InMemoryTransport(new NodeAddress('daemon-hello', 'local', 1)),
    receptionist: false,
    shutdownOnSignals: false,
  });

  const handle = ShardedDaemonProcess.init<string>(system, cluster, {
    name: 'workers',
    numDaemons: 6,
    behaviorFor: (i) => Props.create(() => new Worker(i)),
  });
  await Bun.sleep(100);

  handle.tell(0, 'job-A');
  handle.tell(3, 'job-B');
  handle.tell(5, 'job-C');

  await Bun.sleep(80);
  await shutdown();
}

void main();
