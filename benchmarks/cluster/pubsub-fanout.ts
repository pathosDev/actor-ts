/**
 * Pub-Sub fan-out latency — publish one event to a topic with N local
 * subscribers; measure the drain time of the last subscriber.
 *
 *   bun run benchmarks/cluster/pubsub-fanout.ts
 */
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  Cluster,
  ClusterOptions,
  DistributedPubSubId,
  InMemoryTransport,
  LogLevel,
  NoopLogger,
  NodeAddress,
  Props,
  Publish,
  Subscribe,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

let port = 42_000;

async function fanout(nSubs: number): Promise<void> {
  const p = port++;
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(`fan-${p}`, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(p)
    .withTransport(new InMemoryTransport(new NodeAddress(`fan-${p}`, 'h', p)));
  const cluster = await Cluster.join(sys, clusterOptions);
  const mediator = sys.extension(DistributedPubSubId).start(cluster);

  let remaining = nSubs;
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });

  class Subscriber extends Actor<string> {
    override onReceive(): void {
      if (--remaining === 0) resolve();
    }
  }
  for (let i = 0; i < nSubs; i++) {
    mediator.tell(new Subscribe('topic', sys.spawnAnonymous(Props.create(() => new Subscriber()))));
  }
  await Bun.sleep(20); // settle subscriptions

  mediator.tell(new Publish('topic', 'hello'));
  await done;

  await cluster.leave();
  await sys.terminate();
}

async function main(): Promise<void> {
  await runGroup('cluster · pub-sub fan-out (local subscribers)', [
    { name: '10 subscribers',   unit: 'delivery', iterations: 40, opsPerIteration: 10,   run: () => fanout(10) },
    { name: '100 subscribers',  unit: 'delivery', iterations: 30, opsPerIteration: 100,  run: () => fanout(100) },
    { name: '1000 subscribers', unit: 'delivery', iterations: 10, opsPerIteration: 1000, run: () => fanout(1_000) },
  ]);
}

void main();
