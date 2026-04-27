/**
 * Three-node cluster formation — from "first node up" to "all three see
 * each other as Up".  Measures gossip convergence latency in a LAN-like
 * setting (InMemoryTransport).
 *
 *   bun run benchmarks/cluster/three-node-formation.ts
 */
import {
  ActorSystem,
  Cluster,
  InMemoryTransport,
  LogLevel,
  NoopLogger,
  NodeAddress,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

let portSeed = 41_000;

async function formTriangle(): Promise<void> {
  const base = portSeed; portSeed += 3;
  const systemName = `form-${base}`;
  const mkNode = async (p: number, seeds: string[] = []): Promise<{ sys: ActorSystem; cluster: Cluster }> => {
    const sys = ActorSystem.create(systemName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const cluster = await Cluster.join(sys, {
      host: 'h', port: p, seeds,
      transport: new InMemoryTransport(new NodeAddress(systemName, 'h', p)),
      failureDetector: { heartbeatIntervalMs: 20, unreachableAfterMs: 200, downAfterMs: 400 },
      gossipIntervalMs: 30,
    });
    return { sys, cluster };
  };

  const a = await mkNode(base);
  const b = await mkNode(base + 1, [`${systemName}@h:${base}`]);
  const c = await mkNode(base + 2, [`${systemName}@h:${base}`]);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (a.cluster.upMembers().length === 3
      && b.cluster.upMembers().length === 3
      && c.cluster.upMembers().length === 3) break;
    await Bun.sleep(10);
  }

  for (const n of [a, b, c]) {
    await n.cluster.leave();
    await n.sys.terminate();
  }
}

async function main(): Promise<void> {
  await runGroup('cluster · 3-node formation (InMemoryTransport)', [
    { name: '3 nodes → all-see-all', unit: 'cluster', iterations: 15, run: formTriangle },
  ]);
}

void main();
