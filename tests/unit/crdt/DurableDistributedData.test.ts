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
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import type { LogContextData } from '../../../src/LogContext.js';
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

/**
 * Keeps every warn line the system logger was handed, including through
 * `withSource` — which is how the actor gets its own logger, so a recorder
 * that returned a fresh sink from there would collect nothing.
 */
class WarningRecorder implements Logger {
  readonly warnings: string[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: WarningRecorder | null = null,
  ) {}

  debug(_message: string): void {}
  info(_message: string): void {}
  warn(message: string): void { (this.root ?? this).warnings.push(message); }
  error(_message: string): void {}

  withSource(_source: string): Logger { return new WarningRecorder(this.level, this.root ?? this); }
  withFields(_fields: LogContextData): Logger {
    return new WarningRecorder(this.level, this.root ?? this);
  }
}

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

/**
 * #856 — `durable-keys` narrows what the durable record holds.
 *
 * The behaviour under test is really the *reading of an empty list*, and it is
 * asserted first and on its own because getting it wrong is not a bug that
 * degrades anything: `[]` is what `reference.conf` ships and what every
 * existing deployment resolves to, so "empty means persist nothing" would turn
 * a routine version bump into total durable data loss with nothing logged.
 * The whitelist cases follow.
 *
 * Each case restarts the replica against the same store rather than reading
 * the record directly, because what the option is *for* is what survives a
 * cold start — and a filter applied at load time instead of save time would
 * pass a direct read of the record while still writing every key to disk.
 */

/**
 * The replica's persisted view, decoded through the same wrapper the
 * replicator writes with.
 *
 * Polled instead of slept on, and polled on the *record* rather than the live
 * view (#418, #1145).  The save is fire-and-forget with no completion the
 * handle exposes, so a fixed delay here would encode one idle machine's write
 * latency; and the whole subject of `durableKeys` is which keys reach the
 * record, so a wait on the view would be satisfied by a state the record never
 * received.
 *
 * A throwaway wrapper per call: `load` caches a revision for its own later
 * `save`, and this one never saves.
 */
function persistedView(store: InMemoryDurableStateStore, replicaId: string) {
  return new DurableDistributedDataStore(store, replicaId).load();
}

describe('DurableDistributedData — durableKeys (#856)', () => {
  test('an empty list persists every key, which is the pre-option behaviour', async () => {
    const durable = new InMemoryDurableStateStore();
    const a1 = await startNode('ddata-keys-1', 75_031);
    const ddOptions = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableKeys([])
      .withDurableStore(durable);
    const dd1 = a1.sys.extension(DistributedDataId).start(a1.cluster, ddOptions);
    dd1.update<GCounter>('cart-42', GCounter.empty, (c) => c.increment(dd1.selfReplicaId(), 1));
    dd1.update<GCounter>('session-9', GCounter.empty, (c) => c.increment(dd1.selfReplicaId(), 2));
    dd1.update<GCounter>('unrelated', GCounter.empty, (c) => c.increment(dd1.selfReplicaId(), 3));
    await awaitCondition(async () => {
      const record = await persistedView(durable, dd1.selfReplicaId());
      return record.has('cart-42') && record.has('session-9') && record.has('unrelated');
    }, { timeoutMs: 4_000, intervalMs: 20, label: 'all three keys reached the durable record' });
    await stopNode(a1);

    const a2 = await startNode('ddata-keys-1', 75_031);
    const ddOptions2 = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(durable);
    const dd2 = a2.sys.extension(DistributedDataId).start(a2.cluster, ddOptions2);
    await waitFor(
      () => dd2.get<GCounter>('unrelated') !== undefined,
      'the restarted replica loaded its durable view',
    );

    expect(dd2.get<GCounter>('cart-42')!.value()).toBe(1);
    expect(dd2.get<GCounter>('session-9')!.value()).toBe(2);
    expect(dd2.get<GCounter>('unrelated')!.value()).toBe(3);

    await stopNode(a2);
  }, 10_000);

  test('a whitelist persists exactly its exact names and trailing-* prefixes', async () => {
    const durable = new InMemoryDurableStateStore();
    const a1 = await startNode('ddata-keys-2', 75_041);
    const ddOptions = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableKeys(['cart-42', 'session-*'])
      .withDurableStore(durable);
    const dd1 = a1.sys.extension(DistributedDataId).start(a1.cluster, ddOptions);
    dd1.update<GCounter>('session-9', GCounter.empty, (c) => c.increment(dd1.selfReplicaId(), 2));
    // Neither an exact match nor under the prefix — and named so it would be
    // caught by a matcher that treated `*` as "match anywhere".
    dd1.update<GCounter>('my-session-x', GCounter.empty, (c) => c.increment(dd1.selfReplicaId(), 4));
    dd1.update<GCounter>('unrelated', GCounter.empty, (c) => c.increment(dd1.selfReplicaId(), 3));
    // Updated LAST, and waited on below, so the wait cannot be satisfied by an
    // earlier save: a record holding `cart-42` was snapshotted after every
    // update above had been applied, which is when a broken filter would have
    // written the other two.
    dd1.update<GCounter>('cart-42', GCounter.empty, (c) => c.increment(dd1.selfReplicaId(), 1));
    await awaitCondition(async () => (await persistedView(durable, dd1.selfReplicaId())).has('cart-42'), {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: 'the last-written whitelisted key reached the durable record',
    });
    await stopNode(a1);

    // Restarted with NO whitelist, so what comes back is what the record
    // holds rather than what a second filter would let through.
    const a2 = await startNode('ddata-keys-2', 75_041);
    const ddOptions2 = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(durable);
    const dd2 = a2.sys.extension(DistributedDataId).start(a2.cluster, ddOptions2);
    await waitFor(
      () => dd2.get<GCounter>('cart-42') !== undefined,
      'the restarted replica loaded the whitelisted keys',
    );

    expect(dd2.get<GCounter>('cart-42')!.value()).toBe(1);
    expect(dd2.get<GCounter>('session-9')!.value()).toBe(2);
    expect(dd2.get<GCounter>('my-session-x')).toBeUndefined();
    expect(dd2.get<GCounter>('unrelated')).toBeUndefined();

    await stopNode(a2);
  }, 10_000);

  test('a whitelisted replica keeps every key in its LIVE view', async () => {
    // The filter is a durability decision, not a visibility one: an excluded
    // key still gossips, still merges and still answers `get`.  A filter
    // pushed one layer too far down — into the view instead of into the
    // snapshot — would pass the persistence assertions above and break
    // everything else about the replicator.
    const durable = new InMemoryDurableStateStore();
    const node = await startNode('ddata-keys-3', 75_051);
    const ddOptions = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableKeys(['cart-*'])
      .withDurableStore(durable);
    const dd = node.sys.extension(DistributedDataId).start(node.cluster, ddOptions);
    dd.update<GCounter>('cart-42', GCounter.empty, (c) => c.increment(dd.selfReplicaId(), 1));
    dd.update<GCounter>('unrelated', GCounter.empty, (c) => c.increment(dd.selfReplicaId(), 3));
    await waitFor(
      () => dd.get<GCounter>('unrelated') !== undefined,
      'both updates were applied to the live view',
    );

    expect(dd.get<GCounter>('cart-42')!.value()).toBe(1);
    expect(dd.get<GCounter>('unrelated')!.value()).toBe(3);

    await stopNode(node);
  }, 10_000);

  test('narrowing the list drops what it no longer names, on the next save', async () => {
    // The trap the option's JSDoc, `reference.conf` and the durable-storage
    // page all state, pinned here so it stays true: `save` replaces the
    // replica's whole record, so a key that stops matching is not merely
    // frozen — it is gone from disk as soon as anything else is written.
    const durable = new InMemoryDurableStateStore();
    const a1 = await startNode('ddata-keys-4', 75_061);
    const wideOptions = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableStore(durable);
    const dd1 = a1.sys.extension(DistributedDataId).start(a1.cluster, wideOptions);
    dd1.update<GCounter>('cart-42', GCounter.empty, (c) => c.increment(dd1.selfReplicaId(), 1));
    dd1.update<GCounter>('unrelated', GCounter.empty, (c) => c.increment(dd1.selfReplicaId(), 3));
    await awaitCondition(async () => {
      const record = await persistedView(durable, dd1.selfReplicaId());
      return record.has('cart-42') && record.has('unrelated');
    }, { timeoutMs: 4_000, intervalMs: 20, label: 'both keys reached the wide durable record' });
    await stopNode(a1);

    const a2 = await startNode('ddata-keys-4', 75_061);
    const narrowOptions = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableKeys(['cart-*'])
      .withDurableStore(durable);
    const dd2 = a2.sys.extension(DistributedDataId).start(a2.cluster, narrowOptions);
    await waitFor(
      () => dd2.get<GCounter>('unrelated') !== undefined,
      'the restarted replica loaded both keys before the list narrowed the record',
    );
    // Any mutation at all rewrites the record under the narrower list.
    dd2.update<GCounter>('cart-42', GCounter.empty, (c) => c.increment(dd2.selfReplicaId(), 1));
    // Both halves in one predicate on purpose.  `unrelated` is dropped by the
    // very first save the narrowed replica makes — `preStart`'s load re-saves
    // what it loaded — so waiting on its absence alone would return before the
    // increment was persisted and make the value assertion below a race.
    await awaitCondition(async () => {
      const record = await persistedView(durable, dd2.selfReplicaId());
      return !record.has('unrelated') && (record.get('cart-42') as GCounter | undefined)?.value() === 2;
    }, {
      timeoutMs: 4_000,
      intervalMs: 20,
      label: 'the narrowed record holds the incremented key and no longer holds the other',
    });
    await stopNode(a2);

    const a3 = await startNode('ddata-keys-4', 75_061);
    const dd3 = a3.sys.extension(DistributedDataId).start(a3.cluster, wideOptions);
    await waitFor(
      () => dd3.get<GCounter>('cart-42') !== undefined,
      'the third start loaded whatever the narrowed record still held',
    );

    expect(dd3.get<GCounter>('cart-42')!.value()).toBe(2);
    expect(dd3.get<GCounter>('unrelated')).toBeUndefined();

    await stopNode(a3);
  }, 15_000);

  test('a whitelist with no store configured is warned about, not ignored', async () => {
    // The one way this option is silently wrong, and it is wrong in the
    // direction that costs data: `durableStore` is an instance and has no
    // HOCON spelling, so the two halves are configured in different places
    // and an operator who set only the list believes those keys survive a
    // restart.  Nothing else in the system would ever mention it.
    const log = new WarningRecorder();
    const sysOptions = ActorSystemOptions.create().withLogger(log);
    const sys = ActorSystem.create('ddata-keys-5', sysOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(75_071)
      .withTransport(new InMemoryTransport(new NodeAddress('ddata-keys-5', 'h', 75_071)))
      .withGossipIntervalMs(80);
    const cluster = await Cluster.join(sys, clusterOptions);
    const ddOptions = DistributedDataOptions.create()
      .withGossipInterval(80)
      .withDurableKeys(['cart-*']);
    sys.extension(DistributedDataId).start(cluster, ddOptions);

    await waitFor(
      () => log.warnings.some((line) => line.includes('durable-keys')),
      'the replicator warned that the whitelist has no store behind it',
    );
    const warning = log.warnings.find((line) => line.includes('durable-keys'))!;
    expect(warning).toContain('no durableStore is configured');
    expect(warning).toContain('withDurableStore');

    await cluster.leave();
    await sys.terminate();
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
