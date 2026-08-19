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
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  DistributedDataId,
  DistributedDataOptions,
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
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

/**
 * Thin wrapper over the shared helper (#418) — this file predates it and had
 * its own deadline loop, which named neither the condition nor how long it
 * really waited.  4 s is the largest budget the old call sites asked for, and
 * it bounds only the broken case: a passing wait returns on the first poll
 * that holds.
 */
const waitFor = (predicate: () => boolean, label: string): Promise<void> =>
  awaitCondition(predicate, { timeoutMs: 4_000, intervalMs: 20, label });

type NodeSetup = {
  sys: ActorSystem;
  cluster: Cluster;
};

async function startNode(
  systemName: string, port: number, options: {
    seeds?: string[];
  } = {},
): Promise<NodeSetup> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(systemName, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  if (options.seeds !== undefined) clusterOptions.withSeeds(options.seeds);
  const cluster = await Cluster.join(sys, clusterOptions);
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
    const ddOptions = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(durable);
    const dd1 = a1.sys.extension(DistributedDataId).start(a1.cluster, ddOptions);
    dd1.update<GCounter>('counter', GCounter.empty,
      (c) => c.increment(dd1.selfReplicaId(), 7));
    dd1.update<ORSet<string>>('cart', () => ORSet.empty<string>(),
      (s) => s.add(dd1.selfReplicaId(), 'apple'));
    // Wait for the durable save (fire-and-forget) to settle.
    await sleep(80);
    await stopNode(a1);

    // Restart — fresh ActorSystem + Cluster + DD instance, same durable store.
    const a2 = await startNode('ddata-1', 75_001);
    const ddOptions2 = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(durable);
    const dd2 = a2.sys.extension(DistributedDataId).start(a2.cluster, ddOptions2);
    // Wait for preStart's load() to populate the view.
    await waitFor(
      () => dd2.get<GCounter>('counter') !== undefined,
      'the restarted replica loaded its durable view',
    );

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
    await waitFor(
      () => a1.cluster.upMembers().length === 2 && b1.cluster.upMembers().length === 2,
      'both replicas see the two-node cluster',
    );

    const ddOptions = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(storeA);
    const ddA1 = a1.sys.extension(DistributedDataId).start(a1.cluster, ddOptions);
    const ddOptions2 = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(storeB);
    const ddB1 = b1.sys.extension(DistributedDataId).start(b1.cluster, ddOptions2);
    ddA1.update<GCounter>('shared', GCounter.empty,
      (c) => c.increment(ddA1.selfReplicaId(), 5));
    ddB1.update<GCounter>('shared', GCounter.empty,
      (c) => c.increment(ddB1.selfReplicaId(), 3));

    // Wait for gossip convergence on both sides — value should be 8 everywhere.
    await waitFor(
      () => ddA1.get<GCounter>('shared')?.value() === 8
        && ddB1.get<GCounter>('shared')?.value() === 8,
      'both replicas converged on 8 before the shutdown',
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
    await waitFor(
      () => a2.cluster.upMembers().length === 2 && b2.cluster.upMembers().length === 2,
      'the cold-restarted cluster re-formed',
    );

    const ddOptions3 = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(storeA);
    const ddA2 = a2.sys.extension(DistributedDataId).start(a2.cluster, ddOptions3);
    const ddOptions4 = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(storeB);
    const ddB2 = b2.sys.extension(DistributedDataId).start(b2.cluster, ddOptions4);

    // Each replica recovered its own contribution from disk; gossip
    // re-merges them across the cluster.  Result: 8 everywhere again.
    await waitFor(
      () => ddA2.get<GCounter>('shared')?.value() === 8
        && ddB2.get<GCounter>('shared')?.value() === 8,
      'both replicas converged on 8 again after the cold restart',
    );

    await stopNode(a2);
    await stopNode(b2);
  }, 30_000);

  test('4. delete propagates to the durable store', async () => {
    const durable = new InMemoryDurableStateStore();
    const a1 = await startNode('ddata-3', 75_021);
    const ddOptions = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(durable);
    const dd1 = a1.sys.extension(DistributedDataId).start(a1.cluster, ddOptions);
    dd1.update<GCounter>('to-keep', GCounter.empty,
      (c) => c.increment(dd1.selfReplicaId(), 1));
    dd1.update<GCounter>('to-delete', GCounter.empty,
      (c) => c.increment(dd1.selfReplicaId(), 99));
    // Both saves are fire-and-forget with no completion the handle exposes, and
    // the delete has to land *after* the write it removes — otherwise the
    // restart below would prove nothing, because the key was never saved.
    await sleep(60);
    dd1.delete('to-delete');
    // Same, for the delete's own save: it has to reach the store before
    // `stopNode` tears the actor down.
    await sleep(60);
    await stopNode(a1);

    // Restart — only `to-keep` should be present.
    const a2 = await startNode('ddata-3', 75_021);
    const ddOptions2 = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(durable);
    const dd2 = a2.sys.extension(DistributedDataId).start(a2.cluster, ddOptions2);
    await waitFor(
      () => dd2.get<GCounter>('to-keep') !== undefined,
      'the restarted replica loaded the surviving key',
    );

    expect(dd2.get<GCounter>('to-keep')!.value()).toBe(1);
    expect(dd2.get<GCounter>('to-delete')).toBeUndefined();

    await stopNode(a2);
  }, 10_000);
});

// #725 — `load()` set `this.revision` before decoding.  A decode that threw
// then left the caller with no state and the store holding a *valid*
// revision, so the next save of the now-empty view satisfied the
// optimistic-concurrency check and overwrote the record.  The load failure
// is only a warning upstream, so one undecodable entry silently wiped the
// entire durable replica.
describe('DurableDistributedDataStore.load failure (#725)', () => {
  test('a failed decode does not adopt the revision', async () => {
    const store = new InMemoryDurableStateStore();
    const durable = new DurableDistributedDataStore(store, 'replica-a');

    await durable.save(new Map([['counter', GCounter.empty().increment('a', 5)]]));

    // A second handle over the same store, as a restart would produce.
    const restarted = new DurableDistributedDataStore(store, 'replica-a');
    // Corrupt one entry the way a peer or a version skew could.
    const raw = await store.load<{ entries: Record<string, unknown> }>('ddata|replica-a');
    await store.upsert('ddata|replica-a', raw.toNullable()!.revision, {
      entries: { counter: { kind: 'GCounter', state: { a: 'not-a-number' } } },
    });

    await expect(restarted.load()).rejects.toThrow();

    // The record must still be there, and a save from the empty view must
    // NOT be able to replace it.
    await expect(restarted.save(new Map())).rejects.toThrow();

    const survived = await store.load<{ entries: Record<string, unknown> }>('ddata|replica-a');
    expect(survived.isSome()).toBe(true);
    expect(Object.keys(survived.toNullable()!.state.entries)).toEqual(['counter']);
  });

  test('a clean load still adopts the revision and can save', async () => {
    // The guard must not cost the happy path its concurrency token.
    const store = new InMemoryDurableStateStore();
    const durable = new DurableDistributedDataStore(store, 'replica-b');
    await durable.save(new Map([['counter', GCounter.empty().increment('a', 1)]]));

    const restarted = new DurableDistributedDataStore(store, 'replica-b');
    const loaded = await restarted.load();
    expect(loaded.size).toBe(1);

    await restarted.save(new Map([['counter', GCounter.empty().increment('a', 9)]]));
    const after = await store.load<{ entries: Record<string, { state: Record<string, number> }> }>('ddata|replica-b');
    expect(after.toNullable()!.state.entries['counter']!.state['a']).toBe(9);
  });
});
