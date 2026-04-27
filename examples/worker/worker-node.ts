/**
 * Worker-side script.  Bun spawns one instance of this file per core.
 */
import { Actor, ActorSystem, Cluster, Props, WorkerNode } from '../../src/index.js';

class HelloWorker extends Actor<'greet'> {
  constructor(private readonly workerId: number) { super(); }
  override preStart(): void { this.log.info(`worker ${this.workerId} online`); }
  override onReceive(_: 'greet'): void { this.log.info('greet'); }
}

async function main(): Promise<void> {
  const ctx = await WorkerNode.join<{ workerId: number; seedAddr?: string }>();
  const system = ActorSystem.create(ctx.systemName, {
    config: { 'actor-ts': { logger: { level: 'info' } } },
  });
  const cluster = await Cluster.join(system, {
    host: ctx.self.host,
    port: ctx.self.port,
    seeds: ctx.initData.seedAddr ? [ctx.initData.seedAddr] : [],
    transport: ctx.transport,
    failureDetector: { heartbeatIntervalMs: 100, unreachableAfterMs: 400, downAfterMs: 800 },
    gossipIntervalMs: 120,
  });
  system.actorOf(Props.create(() => new HelloWorker(ctx.initData.workerId)), 'hello');
  ctx.ready();
  setTimeout(async () => {
    await cluster.leave();
    await system.terminate();
  }, 2_000);
}

void main();
