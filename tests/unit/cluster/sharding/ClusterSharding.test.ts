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

/* -------------------------- LRU passivation (#82) ----------------------- */

/**
 * Each `TaggedEntity` instance carries a unique tag (random string) and
 * echoes it on every `ping`.  Tests assert which entities were
 * recreated by comparing tags across pings to the same entityId — a
 * different tag means LRU evicted the earlier instance and a fresh
 * one materialised on the next message.
 */
class TaggedEntity extends Actor<{ id: string; op: 'ping' }> {
  private readonly tag = Math.random().toString(36).slice(2, 10);
  override onReceive(_m: { id: string; op: 'ping' }): void {
    this.sender.forEach((s) => s.tell(this.tag));
  }
}

interface LruNode extends Node {
  region: ActorRef<{ id: string; op: 'ping' }>;
}

async function startLruNode(
  sysName: string, p: number, maxEntities: number,
): Promise<LruNode> {
  const sys = ActorSystem.create(sysName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(sys, {
    host: 'h', port: p, seeds: [],
    transport: new InMemoryTransport(new NodeAddress(sysName, 'h', p)),
    gossipIntervalMs: 30,
  });
  const region = ClusterSharding.get(sys, cluster).start<{ id: string; op: 'ping' }>({
    typeName: 'lru-entity',
    entityProps: Props.create(() => new TaggedEntity()),
    extractEntityId: (m) => m.id,
    numShards: 16,
    maxEntities,
  });
  return { sys, cluster, region: region as ActorRef<{ id: string; op: 'ping' }> } as LruNode;
}

describe('ClusterSharding — LRU passivation (#82)', () => {
  test('exceeding maxEntities evicts the oldest entity, freeing room for the new one', async () => {
    // Single-node cluster keeps shard placement deterministic — every
    // entity lands on this region.  cap=3, send to 5 distinct ids in
    // order; the first two activated must be evicted by the time the
    // last two land.
    const node = await startLruNode('lru-evict', 46_001, 3);
    try {
      await sleep(60); // settle convergence
      const ids = ['a', 'b', 'c', 'd', 'e'];
      const firstTags = new Map<string, string>();
      for (const id of ids) {
        const tag = await ask<{ id: string; op: 'ping' }, string>(
          node.region, { id, op: 'ping' }, 3_000,
        );
        firstTags.set(id, tag);
        // Tiny gap so each entity's `lastActivity` is distinguishable.
        await sleep(5);
      }
      expect(firstTags.size).toBe(5);

      // Let any outstanding Terminated messages drain.
      await sleep(50);

      // 'a' and 'b' were the oldest — eviction should have replaced
      // them with fresh instances on subsequent activity.  We re-ping
      // them and assert the tag is *different* (fresh instance).
      const aAgain = await ask<{ id: string; op: 'ping' }, string>(
        node.region, { id: 'a', op: 'ping' }, 3_000,
      );
      expect(aAgain).not.toBe(firstTags.get('a'));

      // 'd' and 'e' are recent and must NOT have been evicted —
      // their tag stays stable.  (We DON'T check 'c' because the
      // exact eviction count depends on serialised mailbox timing.)
      const eAgain = await ask<{ id: string; op: 'ping' }, string>(
        node.region, { id: 'e', op: 'ping' }, 3_000,
      );
      expect(eAgain).toBe(firstTags.get('e'));
    } finally {
      await stopAll([node]);
    }
  });

  test('default (no maxEntities) keeps every entity resident', async () => {
    // Sanity check: the LRU path is opt-in.  With maxEntities=0, an
    // identical 5-id workload must produce 5 stable tags — no
    // eviction, no recreation.
    const node = await startLruNode('lru-uncapped', 46_101, 0);
    try {
      await sleep(60);
      const ids = ['p', 'q', 'r', 's', 't'];
      const firstTags = new Map<string, string>();
      for (const id of ids) {
        const tag = await ask<{ id: string; op: 'ping' }, string>(
          node.region, { id, op: 'ping' }, 3_000,
        );
        firstTags.set(id, tag);
      }
      await sleep(50);
      for (const id of ids) {
        const same = await ask<{ id: string; op: 'ping' }, string>(
          node.region, { id, op: 'ping' }, 3_000,
        );
        expect(same).toBe(firstTags.get(id));
      }
    } finally {
      await stopAll([node]);
    }
  });

  test('passivated entity is recreated transparently on next message', async () => {
    // Shape from issue body: send to a passivated entity → it's
    // re-spawned via `entityProps`.  The user-visible behaviour
    // (round-trip ask succeeds) must hold even after eviction.
    const node = await startLruNode('lru-recreate', 46_201, 2);
    try {
      await sleep(60);
      const t1 = await ask<{ id: string; op: 'ping' }, string>(
        node.region, { id: 'evictee', op: 'ping' }, 3_000,
      );
      // Drive enough fresh ids to push 'evictee' out of the cap.
      for (const id of ['f1', 'f2', 'f3']) {
        await sleep(5);
        await ask<{ id: string; op: 'ping' }, string>(
          node.region, { id, op: 'ping' }, 3_000,
        );
      }
      await sleep(50);
      const t2 = await ask<{ id: string; op: 'ping' }, string>(
        node.region, { id: 'evictee', op: 'ping' }, 3_000,
      );
      // Different tag confirms re-creation; second ask succeeding at
      // all confirms re-spawn went through cleanly.
      expect(t2).not.toBe(t1);
    } finally {
      await stopAll([node]);
    }
  });
});
