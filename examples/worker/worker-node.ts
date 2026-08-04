/**
 * Worker-side script.  Bun spawns one instance of this file per core.
 */
import { Actor, ActorSystem, ActorSystemOptions, Cluster, ClusterOptions, WorkerNode } from '../../src/index.js';
import { attachDevTools } from '../devtools.js';

class HelloWorker extends Actor<'greet'> {
  constructor(private readonly workerId: number) { super(); }
  override preStart(): void { this.log.info(`worker ${this.workerId} online`); }
  override onReceive(_: 'greet'): void { this.log.info('greet'); }
}

async function main(): Promise<void> {
  const context = await WorkerNode.join<{ workerId: number; seedAddr?: string }>();
  const systemOptions = ActorSystemOptions.create().withConfig({ 'actor-ts': { logger: { level: 'info' } } });
  const system = ActorSystem.create(context.systemName, systemOptions);
  // Each worker is a separate thread with its own copy of this module,
  // so the shared port counter cannot keep them apart — let the OS
  // assign one and read the URL off the log line.
  await attachDevTools(system, { port: 0 });
  const clusterOptions = ClusterOptions.create()
    .withHost(context.self.host)
    .withPort(context.self.port)
    .withSeeds(context.initData.seedAddr ? [context.initData.seedAddr] : [])
    .withTransport(context.transport)
    .withFailureDetector({ heartbeatIntervalMs: 100, unreachableAfterMs: 400, downAfterMs: 800 })
    .withGossipIntervalMs(120);
  const cluster = await Cluster.join(system, clusterOptions);
  system.spawn(() => new HelloWorker(context.initData.workerId), 'hello');
  context.ready();
  setTimeout(async () => {
    await cluster.leave();
    await system.terminate();
  }, 2_000);
}

void main();
