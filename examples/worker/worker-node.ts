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
  const ctx = await WorkerNode.join<{ workerId: number; seedAddr?: string }>();
  const systemOptions = ActorSystemOptions.create()
    .withConfig({ 'actor-ts': { logger: { level: 'info' } } });
  const system = ActorSystem.create(ctx.systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(ctx.self.host)
    .withPort(ctx.self.port)
    .withSeeds(ctx.initData.seedAddr ? [ctx.initData.seedAddr] : [])
    .withTransport(ctx.transport)
    .withFailureDetector({ heartbeatIntervalMs: 100, unreachableAfterMs: 400, downAfterMs: 800 })
    .withGossipIntervalMs(120);
  const cluster = await Cluster.join(system, clusterOptions);
  system.spawn(Props.create(() => new HelloWorker(ctx.initData.workerId)), 'hello');
  ctx.ready();
  setTimeout(async () => {
    await cluster.leave();
    await system.terminate();
  }, 2_000);
}

void main();
