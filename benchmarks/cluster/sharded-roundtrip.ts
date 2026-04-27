/**
 * Sharded entity round-trip — ask an entity through the sharding region
 * on a single-node cluster.  Also includes "ask a remote shard" via a
 * 2-node cluster to capture the extra hop cost.
 *
 *   bun run benchmarks/cluster/sharded-roundtrip.ts
 */
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

let port = 43_000;

async function startNode(systemName: string, p: number, seeds: string[] = []): Promise<{ sys: ActorSystem; cluster: Cluster; region: ActorRef<Cmd> }> {
  const sys = ActorSystem.create(systemName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(sys, {
    host: 'h', port: p, seeds,
    transport: new InMemoryTransport(new NodeAddress(systemName, 'h', p)),
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

async function main(): Promise<void> {
  const base = port; port += 2;
  const sysName = `sharded-rt-${base}`;
  const a = await startNode(sysName, base);

  await runGroup('cluster · sharded entity round-trip (1-node)', [
    {
      name: 'ask entity via region',
      unit: 'ask',
      iterations: 2_000,
      run: async () => { await ask<Cmd, string>(a.region, { id: 'same', op: 'ping' }, 1_000); },
    },
  ]);

  await a.cluster.leave(); await a.sys.terminate();

  // 2-node variant: roughly half of asks land remote.
  const base2 = port; port += 2;
  const sysName2 = `sharded-rt2-${base2}`;
  const a2 = await startNode(sysName2, base2);
  const b2 = await startNode(sysName2, base2 + 1, [`${sysName2}@h:${base2}`]);
  // wait for convergence
  for (let i = 0; i < 100 && a2.cluster.upMembers().length < 2; i++) await Bun.sleep(30);

  await runGroup('cluster · sharded entity round-trip (2-node, random id)', [
    {
      name: 'ask random entity',
      unit: 'ask',
      iterations: 1_000,
      run: async () => {
        const id = `e-${Math.floor(Math.random() * 64)}`;
        await ask<Cmd, string>(a2.region, { id, op: 'ping' }, 1_000);
      },
    },
  ]);

  await a2.cluster.leave(); await a2.sys.terminate();
  await b2.cluster.leave(); await b2.sys.terminate();
}

void main();
