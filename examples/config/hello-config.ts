/**
 * Minimal ("hello") configuration example.
 *
 * Shows how to:
 *  - let the ActorSystem derive defaults from reference.conf,
 *  - override a couple of values from code,
 *  - read a value out of the merged config at runtime.
 *
 *   bun run examples/config/hello-config.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, Props } from '../../src/index.js';

class DiagActor extends Actor<'report'> {
  override onReceive(_: 'report'): void {
    const cfg = this.system.config;
    this.log.info('system name       =', cfg.getString('actor-ts.system.name'));
    this.log.info('gossip-interval   =', cfg.getDuration('actor-ts.cluster.gossip-interval'), 'ms');
    this.log.info('number-of-shards  =', cfg.getInt('actor-ts.sharding.number-of-shards'));
    this.log.info('http backend      =', cfg.getString('actor-ts.http.backend'));
    this.log.info('max-frame-size    =', cfg.getBytes('actor-ts.remote.max-frame-size'), 'bytes');
    this.self.stop();
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('hello-config', ActorSystemOptions.create()
    .withConfig({
      'actor-ts': {
        cluster: { 'gossip-interval': '250ms' },
        sharding: { 'number-of-shards': 16 },
      },
    }));

  const diag = system.spawn(Props.create(() => new DiagActor()), 'diag');
  diag.tell('report');
  await new Promise(resolve => setTimeout(resolve, 50));
  await system.terminate();
}

void main();
