/**
 * Node-count scaling — run the same sharded workload against clusters of
 * 1 / 2 / 3 / 5 nodes (InMemoryTransport) and compare ask throughput.
 *
 * Each cluster size is executed in its own Bun subprocess.  The sharding
 * extension keeps per-ActorSystem state that does not always reset cleanly
 * when a test tears a cluster down mid-process, so isolating each run
 * avoids leaked state leaking into the next configuration's measurements.
 *
 *   bun run benchmarks/cluster/node-count-scaling.ts
 */
import { spawnSync } from 'node:child_process';
import {
  Actor,
  ActorSystem,
  Cluster,
  ClusterSharding,
  InMemoryTransport,
  LogLevel,
  NoopLogger,
  NodeAddress,
  Props,
  ask,
  type ActorRef,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Cmd = { id: string; op: 'ping' };

class Entity extends Actor<Cmd> {
  override onReceive(m: Cmd): void {
    if (m.op === 'ping') this.sender.forEach((s) => s.tell('pong'));
  }
}

interface Node {
  readonly sys: ActorSystem;
  readonly cluster: Cluster;
  readonly region: ActorRef<Cmd>;
}

async function startNode(sysName: string, p: number, seeds: string[] = []): Promise<Node> {
  const sys = ActorSystem.create(sysName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(sys, {
    host: 'h', port: p, seeds,
    transport: new InMemoryTransport(new NodeAddress(sysName, 'h', p)),
    gossipIntervalMs: 30,
  });
  const region = ClusterSharding.get(sys, cluster).start<Cmd>({
    typeName: 'entity',
    entityProps: Props.create(() => new Entity()),
    extractEntityId: (m) => m.id,
    numShards: 16,
  });
  return { sys, cluster, region };
}

async function buildCluster(size: number, basePort: number): Promise<Node[]> {
  const sysName = `scale-${size}-${basePort}`;
  const nodes: Node[] = [];
  const seed = await startNode(sysName, basePort);
  nodes.push(seed);
  const seedAddr = `${sysName}@h:${basePort}`;
  for (let i = 1; i < size; i++) {
    nodes.push(await startNode(sysName, basePort + i, [seedAddr]));
  }
  for (let j = 0; j < 200 && !nodes.every((n) => n.cluster.upMembers().length === size); j++) {
    await Bun.sleep(30);
  }
  await Bun.sleep(200);
  return nodes;
}

async function runSize(size: number): Promise<void> {
  const nodes = await buildCluster(size, 44_000);
  const entry = nodes[0]!;

  // Warm every shard so the first measured ask does not race the shard
  // coordinator's initial allocation.
  for (let id = 0; id < 16; id++) {
    await ask<Cmd, string>(entry.region, { id: `warm-${id}`, op: 'ping' }, 3_000);
  }

  await runGroup(`cluster · ${size}-node sharded ask`, [
    {
      name: `ask random entity (cluster=${size})`,
      unit: 'ask',
      iterations: 1_500,
      run: async () => {
        const id = `e-${Math.floor(Math.random() * 256)}`;
        await ask<Cmd, string>(entry.region, { id, op: 'ping' }, 3_000);
      },
    },
  ]);

  for (const n of nodes) { await n.cluster.leave(); await n.sys.terminate(); }
}

async function main(): Promise<void> {
  const sizeArg = process.argv.find((a) => a.startsWith('--size='));
  if (sizeArg) {
    const size = parseInt(sizeArg.slice('--size='.length), 10);
    await runSize(size);
    return;
  }

  console.log(
    '\n  Node-count scaling — 1 / 2 / 3 / 5-node sharded ask throughput\n'
    + '  (each size runs in its own subprocess for clean state; entity IDs uniform over 256 slots)\n',
  );

  const self = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:');
  for (const size of [1, 2, 3, 5] as const) {
    const res = spawnSync('bun', ['run', self, `--size=${size}`], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error(`  [exit=${res.status}] size=${size}`);
      process.exit(res.status ?? 1);
    }
  }
}

void main();
