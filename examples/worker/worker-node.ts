/**
 * Worker-side script.  Bun spawns one instance of this file per core.
 */
import { Actor, ActorSystem, ActorSystemOptions, Cluster, ClusterOptions, Props, WorkerNode } from '../../src/index.js';

class HelloWorker extends Actor<'greet'> {
  constructor(private readonly workerId: number) { super(); }
  override preStart(): void { this.log.info(`worker ${this.workerId} online`); }
  override onReceive(_: 'greet'): void { this.log.info('greet'); }
}

async function main(): Promise<void> {
  const context = await WorkerNode.join<{ workerId: number; seedAddr?: string }>();
  const systemOptions = ActorSystemOptions.create().withConfig({ 'actor-ts': { logger: { level: 'info' } } });
  const system = ActorSystem.create(context.systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(context.self.host)
    .withPort(context.self.port)
    .withSeeds(context.initData.seedAddr ? [context.initData.seedAddr] : [])
    .withTransport(context.transport)
    .withFailureDetector({ heartbeatIntervalMs: 100, unreachableAfterMs: 400, downAfterMs: 800 })
    .withGossipIntervalMs(120);
  const cluster = await Cluster.join(system, clusterOptions);
  system.spawn(Props.create(() => new HelloWorker(context.initData.workerId)), 'hello');
  context.ready();
  setTimeout(async () => {
    await cluster.leave();
    await system.terminate();
  }, 2_000);
}

void main();
