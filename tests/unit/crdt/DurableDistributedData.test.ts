/**
 * Tests for `DurableDistributedData` (#40) — DistributedData with an
 * optional persistent backend so a full cluster restart doesn't lose
 * every CRDT.
 *
 * Four scenarios:
 *
 *   1. Wrapper round-trip — write/read a few CRDT shapes via the
 *      `DurableDistributedDataStore`, no DD actor in the loop.
 *   2. Single-replica restart — start a replica, update a key, stop;
 *      restart with the SAME store; recovered view matches.
 *   3. Two replicas converge after both restart — reproduces the
 *      cluster-cold-start "all CRDTs lost" bug from the issue.
 *   4. delete() propagates to the durable store — restart sees the
 *      key gone.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import {
  DistributedDataId,
  DurableDistributedDataStore,
  GCounter,
  GSet,
  LWWRegister,
  ORSet,
} from '../../../src/crdt/index.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { InMemoryDurableStateStore } from '../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(20);
  }
  if (!pred()) throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

interface NodeSetup {
  sys: ActorSystem;
  cluster: Cluster;
}

async function startNode(
  systemName: string, port: number, opts: {
    seeds?: string[];
  } = {},
): Promise<NodeSetup> {
  const sys = ActorSystem.create(systemName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(sys, {
    host: 'h', port,
    seeds: opts.seeds,
    transport: new InMemoryTransport(new NodeAddress(systemName, 'h', port)),
    failureDetector: { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 },
    gossipIntervalMs: 80,
  });
  return { sys, cluster };
}

async function stopNode(n: NodeSetup): Promise<void> {
  await n.cluster.leave();
  await n.sys.terminate();
}

describe('DurableDistributedDataStore — wrapper', () => {
  test('1. round-trip: save → load preserves every CRDT shape', async () => {
    const store = new InMemoryDurableStateStore();
    const wrapper = new DurableDistributedDataStore(store, 'replica-a');

    // Build a map covering all 5 CRDT types.
    const map = new Map<string, GCounter | GSet<string> | ORSet<string> | LWWRegister<number>>();
    map.set('hits', GCounter.empty().increment('replica-a', 5));
    map.set('tags', GSet.empty<string>().add('alpha').add('beta'));
    map.set('cart', ORSet.empty<string>().add('replica-a', 'apple'));
    map.set('config', LWWRegister.empty<number>().assign('replica-a', 42, 1_000));

    await wrapper.save(map as never);

    // Fresh wrapper (simulates restart) reads the same data back.
    const fresh = new DurableDistributedDataStore(store, 'replica-a');
    const loaded = await fresh.load();
    expect(loaded.size).toBe(4);
    expect((loaded.get('hits') as GCounter).value()).toBe(5);
    expect(new Set((loaded.get('tags') as GSet<string>).value()))
      .toEqual(new Set(['alpha', 'beta']));
    expect((loaded.get('cart') as ORSet<string>).has('apple')).toBe(true);
    expect((loaded.get('config') as LWWRegister<number>).value()).toBe(42);
  });
});

describe('DurableDistributedData — actor integration', () => {
  test('2. single-replica restart: recovered view matches pre-restart state', async () => {
    // Same DurableStateStore instance survives both runs of the actor.
    const durable = new InMemoryDurableStateStore();

    const a1 = await startNode('ddata-1', 75_001);
    const dd1 = a1.sys.extension(DistributedDataId).start(a1.cluster, {
      gossipIntervalMs: 80,
      durableStore: durable,
    });
    dd1.update<GCounter>('counter', GCounter.empty,
      (c) => c.increment(dd1.selfReplicaId(), 7));
    dd1.update<ORSet<string>>('cart', () => ORSet.empty<string>(),
      (s) => s.add(dd1.selfReplicaId(), 'apple'));
    // Wait for the durable save (fire-and-forget) to settle.
    await sleep(80);
    await stopNode(a1);

    // Restart — fresh ActorSystem + Cluster + DD instance, same durable store.
    const a2 = await startNode('ddata-1', 75_001);
    const dd2 = a2.sys.extension(DistributedDataId).start(a2.cluster, {
      gossipIntervalMs: 80,
      durableStore: durable,
    });
    // Wait for preStart's load() to populate the view.
    await waitFor(() => dd2.get<GCounter>('counter') !== undefined);

    expect(dd2.get<GCounter>('counter')!.value()).toBe(7);
    expect(dd2.get<ORSet<string>>('cart')!.has('apple')).toBe(true);

    await stopNode(a2);
  }, 10_000);

  test('3. two replicas converge after both restart', async () => {
    const storeA = new InMemoryDurableStateStore();
    const storeB = new InMemoryDurableStateStore();

    // Phase 1: both replicas come up, each writes its own contribution.
    const a1 = await startNode('ddata-2', 75_011);
    const b1 = await startNode('ddata-2', 75_012, { seeds: ['ddata-2@h:75011'] });
    await waitFor(() => a1.cluster.upMembers().length === 2 && b1.cluster.upMembers().length === 2);

    const ddA1 = a1.sys.extension(DistributedDataId).start(a1.cluster, {
      gossipIntervalMs: 80, durableStore: storeA,
    });
    const ddB1 = b1.sys.extension(DistributedDataId).start(b1.cluster, {
      gossipIntervalMs: 80, durableStore: storeB,
    });
    ddA1.update<GCounter>('shared', GCounter.empty,
      (c) => c.increment(ddA1.selfReplicaId(), 5));
    ddB1.update<GCounter>('shared', GCounter.empty,
      (c) => c.increment(ddB1.selfReplicaId(), 3));

    // Wait for gossip convergence on both sides — value should be 8 everywhere.
    await waitFor(() =>
      ddA1.get<GCounter>('shared')?.value() === 8 &&
      ddB1.get<GCounter>('shared')?.value() === 8,
      4_000,
    );

    // Allow durable saves to settle.
    await sleep(80);

    // Phase 2: full cluster shutdown.  Both stores keep their data
    // because we use them outside the actor lifecycle.
    await stopNode(a1);
    await stopNode(b1);

    // Phase 3: cold restart — both nodes come back up.
    const a2 = await startNode('ddata-2', 75_011);
    const b2 = await startNode('ddata-2', 75_012, { seeds: ['ddata-2@h:75011'] });
    await waitFor(() => a2.cluster.upMembers().length === 2 && b2.cluster.upMembers().length === 2);

    const ddA2 = a2.sys.extension(DistributedDataId).start(a2.cluster, {
      gossipIntervalMs: 80, durableStore: storeA,
    });
    const ddB2 = b2.sys.extension(DistributedDataId).start(b2.cluster, {
      gossipIntervalMs: 80, durableStore: storeB,
    });

    // Each replica recovered its own contribution from disk; gossip
    // re-merges them across the cluster.  Result: 8 everywhere again.
    await waitFor(() =>
      ddA2.get<GCounter>('shared')?.value() === 8 &&
      ddB2.get<GCounter>('shared')?.value() === 8,
      4_000,
    );

    await stopNode(a2);
    await stopNode(b2);
  }, 30_000);

  test('4. delete propagates to the durable store', async () => {
    const durable = new InMemoryDurableStateStore();
    const a1 = await startNode('ddata-3', 75_021);
    const dd1 = a1.sys.extension(DistributedDataId).start(a1.cluster, {
      gossipIntervalMs: 80, durableStore: durable,
    });
    dd1.update<GCounter>('to-keep', GCounter.empty,
      (c) => c.increment(dd1.selfReplicaId(), 1));
    dd1.update<GCounter>('to-delete', GCounter.empty,
      (c) => c.increment(dd1.selfReplicaId(), 99));
    await sleep(60);
    dd1.delete('to-delete');
    await sleep(60);
    await stopNode(a1);

    // Restart — only `to-keep` should be present.
    const a2 = await startNode('ddata-3', 75_021);
    const dd2 = a2.sys.extension(DistributedDataId).start(a2.cluster, {
      gossipIntervalMs: 80, durableStore: durable,
    });
    await waitFor(() => dd2.get<GCounter>('to-keep') !== undefined);

    expect(dd2.get<GCounter>('to-keep')!.value()).toBe(1);
    expect(dd2.get<GCounter>('to-delete')).toBeUndefined();

    await stopNode(a2);
  }, 10_000);
});
