/**
 * Realistic configuration example: load application.conf from disk, with
 * environment substitutions, and layer a tiny code override on top.
 *
 *   bun run examples/config/from-file.ts
 *   ACTOR_TS_CONFIG=./examples/config/application.conf bun run examples/config/from-file.ts
 *   POD_IP=10.0.0.5 SEED_HOST_1=10.0.0.1 SEED_PORT=2552 \
 *     bun run examples/config/from-file.ts
 */
import { Actor, ActorSystem, ActorSystemOptions, Props } from '../../src/index.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appConf = resolve(here, 'application.conf');

class DiagActor extends Actor<'report'> {
  override onReceive(_: 'report'): void {
    const config = this.system.config;
    console.log('SYSTEM NAME     :', config.getString('actor-ts.system.name'));
    console.log('GOSSIP INTERVAL :', config.getDuration('actor-ts.cluster.gossip-interval'), 'ms');
    console.log('SHARDS          :', config.getInt('actor-ts.sharding.number-of-shards'));
    console.log('REMEMBER ENT.   :', config.getBoolean('actor-ts.sharding.remember-entities'));
    console.log('PASSIVATION     :', config.getDuration('actor-ts.sharding.passivation-idle'), 'ms');
    console.log('FRAME SIZE      :', config.getBytes('actor-ts.remote.max-frame-size'), 'bytes');
    if (config.hasPath('actor-ts.remote.tcp.hostname')) {
      console.log('TCP HOSTNAME    :', config.getString('actor-ts.remote.tcp.hostname'));
    }
    this.self.stop();
  }
}

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withConfigFile(appConf)
    // A code override still wins over the file contents.
    .withConfig({ 'actor-ts': { logger: { level: 'info' } } });
  const system = ActorSystem.create('from-file', systemOptions);
  const diag = system.spawn(Props.create(() => new DiagActor()), 'diag');
  diag.tell('report');
  await new Promise(resolve => setTimeout(resolve, 50));
  await system.terminate();
}

void main();
