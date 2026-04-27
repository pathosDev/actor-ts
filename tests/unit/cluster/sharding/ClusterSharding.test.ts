import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { ClusterSharding } from '../../../../src/cluster/sharding/ClusterSharding.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { ask } from '../../../../src/Ask.js';
import type { ActorRef } from '../../../../src/ActorRef.js';

type Cmd = { id: string; op: 'ping' | 'echo'; payload?: string };

class Entity extends Actor<Cmd> {
  override onReceive(m: Cmd): void {
    if (m.op === 'ping') this.sender.forEach((s) => s.tell('pong'));
    else if (m.op === 'echo') this.sender.forEach((s) => s.tell(m.payload ?? ''));
  }
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 5_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface Node {
  sys: ActorSystem;
  cluster: Cluster;
  region: ActorRef<Cmd>;
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

async function stopAll(nodes: Node[]): Promise<void> {
  for (const n of nodes) { await n.cluster.leave(); await n.sys.terminate(); }
}

describe('ClusterSharding — initialization after convergence', () => {
  test('ask succeeds after waiting past every-node convergence + 200ms sleep', async () => {
    const sysName = 'init-a';
    const base = 45_100;
    const seed = await startNode(sysName, base);
    const n1 = await startNode(sysName, base + 1, [`${sysName}@h:${base}`]);
    const nodes = [seed, n1];

    await waitFor(() => nodes.every((n) => n.cluster.upMembers().length === 2));
    await sleep(200);

    const reply = await ask<Cmd, string>(seed.region, { id: 'warm-0', op: 'ping' }, 3_000);
    expect(reply).toBe('pong');

    await stopAll(nodes);
  });

  test('ask reaches entities on both nodes (remote + local shard homes)', async () => {
    const sysName = 'init-b';
    const base = 45_200;
    const seed = await startNode(sysName, base);
    const n1 = await startNode(sysName, base + 1, [`${sysName}@h:${base}`]);
    const nodes = [seed, n1];

    await waitFor(() => nodes.every((n) => n.cluster.upMembers().length === 2));
    await sleep(200);

    // 16 shards, HashAllocationStrategy splits ~50/50.  All asks must succeed
    // regardless of whether the shard is local or remote relative to the asker.
    const replies = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        ask<Cmd, string>(seed.region, { id: `e-${i}`, op: 'echo', payload: `reply-${i}` }, 3_000),
      ),
    );
    expect(replies).toEqual(Array.from({ length: 16 }, (_, i) => `reply-${i}`));

    await stopAll(nodes);
  });

  test('ask works from either node to entities on either node', async () => {
    const sysName = 'init-c';
    const base = 45_300;
    const seed = await startNode(sysName, base);
    const n1 = await startNode(sysName, base + 1, [`${sysName}@h:${base}`]);
    const nodes = [seed, n1];

    await waitFor(() => nodes.every((n) => n.cluster.upMembers().length === 2));
    await sleep(200);

    for (let i = 0; i < 8; i++) {
      const fromA = await ask<Cmd, string>(seed.region, { id: `x-${i}`, op: 'ping' }, 3_000);
      const fromB = await ask<Cmd, string>(n1.region,   { id: `y-${i}`, op: 'ping' }, 3_000);
      expect(fromA).toBe('pong');
      expect(fromB).toBe('pong');
    }

    await stopAll(nodes);
  });

  test('ask succeeds after sleeping past the rebalance tick', async () => {
    const sysName = 'init-d';
    const base = 45_400;
    const seed = await startNode(sysName, base);
    const n1 = await startNode(sysName, base + 1, [`${sysName}@h:${base}`]);
    const nodes = [seed, n1];

    await waitFor(() => seed.cluster.upMembers().length === 2);
    // Let the coordinator's rebalance timer fire at least once.
    await sleep(2_200);

    const reply = await ask<Cmd, string>(seed.region, { id: 'warm-0', op: 'ping' }, 3_000);
    expect(reply).toBe('pong');

    await stopAll(nodes);
  });
});
