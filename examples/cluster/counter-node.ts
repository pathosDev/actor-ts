/**
 * Cluster + Sharding demo.  Every counter entity lives on exactly one node
 * at any moment; nodes see each other via gossip and rebalance when one
 * dies.
 *
 * Terminal 1:  bun run examples/cluster/counter-node.ts --port 9001
 * Terminal 2:  bun run examples/cluster/counter-node.ts --port 9002 --seeds 127.0.0.1:9001
 * Terminal 3:  bun run examples/cluster/counter-node.ts --port 9003 --seeds 127.0.0.1:9001
 *
 * Kill terminal 2 and watch terminals 1 and 3 pick up the stranded shards.
 */
import {
  Actor,
  Cluster,
  ClusterBootstrapOptions,
  LogLevel,
  MemberDown,
  MemberRemoved,
  MemberUnreachable,
  MemberUp,
  ShardMapChanged,
  StartShardingOptions,
} from '../../src/index.js';

type Command =
  | { id: string; op: 'increment' }
  | { id: string; op: 'get' };

class CounterEntity extends Actor<Command> {
  private count = 0;

  override preStart(): void {
    this.log.info(`entity ${this.self.path.name} started on this node`);
  }

  override postStop(): void {
    this.log.info(`entity ${this.self.path.name} stopped (count was ${this.count})`);
  }

  override onReceive(command: Command): void {
    switch (command.op) {
      case 'increment':
        this.count++;
        this.log.info(`${this.self.path.name} = ${this.count}`);
        break;
      case 'get':
        this.log.info(`${this.self.path.name} = ${this.count}`);
        break;
    }
  }
}

function parseArgs(argv: string[]): { port: number; seeds: string[]; host: string } {
  const out = { port: 9001, seeds: [] as string[], host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') out.port = parseInt(argv[++i]!, 10);
    else if (arg === '--host') out.host = argv[++i]!;
    else if (arg === '--seeds') out.seeds = argv[++i]!.split(',').map(s => s.trim()).filter(Boolean);
  }
  return out;
}

async function main(): Promise<void> {
  const { port, seeds, host } = parseArgs(process.argv.slice(2));
  // `Cluster.bootstrap` rolls ActorSystem.create + Cluster.join +
  // SIGTERM/SIGINT-driven shutdown into one call.  We disable the
  // built-in signal wiring here because the example installs its
  // own shutdown handler (with `clearInterval` cleanup).
  const { system, cluster, shutdown: clusterShutdown } = await Cluster.bootstrap(
    ClusterBootstrapOptions.create('counter-cluster')
      .withLogLevel(LogLevel.Info)
      .withHost(host)
      .withPort(port)
      .withSeeds(seeds)
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withFailureDetector({ heartbeatIntervalMs: 300, unreachableAfterMs: 1_500, downAfterMs: 3_500 })
      .withGossipIntervalMs(500));

  cluster.subscribe(evt => {
    if (evt instanceof MemberUp) system.log.info(`[+] ${evt.member.address} is UP`);
    if (evt instanceof MemberUnreachable) system.log.warn(`[?] ${evt.member.address} unreachable`);
    if (evt instanceof MemberDown) system.log.warn(`[x] ${evt.member.address} marked DOWN`);
    if (evt instanceof MemberRemoved) system.log.warn(`[-] ${evt.member.address} removed`);
    if (evt instanceof ShardMapChanged) {
      const owners = new Map<string, number>();
      for (const addr of evt.shards.values()) owners.set(addr, (owners.get(addr) ?? 0) + 1);
      const summary = Array.from(owners).map(([k, v]) => `${k}=${v}`).join(', ');
      system.log.info(`[~] shard map v${evt.version}: ${summary}`);
    }
  });

  const region = cluster.sharding.start('counter', CounterEntity,
    StartShardingOptions.create<Command>()
      .withExtractEntityId((message) => message.id)
      .withNumShards(16));

  // Self-driven traffic so the demo shows movement without a second client.
  // Each node sends to its OWN local region ref — the region routes
  // messages to whichever node actually owns the shard.
  let tick = 0;
  const entities = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
  const interval = setInterval(() => {
    const id = entities[tick % entities.length]!;
    region.tell({ id, op: 'increment' });
    tick++;
  }, 400);

  const shutdown = async (): Promise<void> => {
    clearInterval(interval);
    await clusterShutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  system.log.info(`node listening on ${host}:${port}, seeds=[${seeds.join(', ')}]`);
}

void main();
