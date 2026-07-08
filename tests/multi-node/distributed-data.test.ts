/**
 * Multi-node convergence test for DistributedData.
 *
 * Three nodes, each updates a shared CRDT key independently, gossip
 * fans the state out, and after a quiescent window every replica
 * sees the same merged value.  Covers:
 *
 *   - GCounter sum across replicas converges to the total.
 *   - PNCounter handles increments + decrements across nodes.
 *   - ORSet add/remove from different replicas converges with
 *     "add wins" semantics.
 *
 * These tests stress the *replication path* — gossip wire, merge
 * dispatch, listener fan-out — not the CRDT laws themselves
 * (those are covered exhaustively in `CrdtProperties.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import {
  DistributedDataId,
  DistributedDataOptions,
  GCounter,
  LWWMap,
  ORMap,
  ORSet,
  PNCounter,
} from '../../src/crdt/index.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

async function withSpec(
  body: (spec: MultiNodeSpec) => Promise<void>,
): Promise<void> {
  const spec = new MultiNodeSpec({
    roles: ['a', 'b', 'c'],
    failureDetector: TIGHT_FD,
    gossipIntervalMs: 80,
  });
  try {
    await spec.start();
    await Promise.all([
      spec.awaitMembers('a', 3),
      spec.awaitMembers('b', 3),
      spec.awaitMembers('c', 3),
    ]);
    await body(spec);
  } finally {
    await spec.stop();
    MultiNodeTransport._resetRegistryForTest();
  }
}

async function awaitConvergence(
  check: () => boolean, timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(50);
  }
  if (!check()) throw new Error(`convergence timeout after ${timeoutMs}ms`);
}

describe('DistributedData — convergence', () => {
  test('GCounter from three nodes converges to the sum', async () => {
    await withSpec(async (spec) => {
      const ddOptions = DistributedDataOptions.create()
        .withGossipInterval(80);
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), ddOptions);
      const ddB = spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), ddOptions);
      const ddC = spec.systemFor('c').extension(DistributedDataId)
        .start(spec.clusterFor('c'), ddOptions);

      ddA.update<GCounter>('hits', GCounter.empty, (c) => c.increment(ddA.selfReplicaId(), 3));
      ddB.update<GCounter>('hits', GCounter.empty, (c) => c.increment(ddB.selfReplicaId(), 5));
      ddC.update<GCounter>('hits', GCounter.empty, (c) => c.increment(ddC.selfReplicaId(), 7));

      await awaitConvergence(() => {
        const a = ddA.get<GCounter>('hits')?.value() ?? 0;
        const b = ddB.get<GCounter>('hits')?.value() ?? 0;
        const c = ddC.get<GCounter>('hits')?.value() ?? 0;
        return a === 15 && b === 15 && c === 15;
      });
    });
  }, 15_000);

  test('PNCounter mixes increments + decrements across replicas', async () => {
    await withSpec(async (spec) => {
      const ddOptions = DistributedDataOptions.create()
        .withGossipInterval(80);
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), ddOptions);
      const ddB = spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), ddOptions);
      const ddC = spec.systemFor('c').extension(DistributedDataId)
        .start(spec.clusterFor('c'), ddOptions);

      ddA.update<PNCounter>('inventory', PNCounter.empty,
        (p) => p.increment(ddA.selfReplicaId(), 100));
      ddB.update<PNCounter>('inventory', PNCounter.empty,
        (p) => p.decrement(ddB.selfReplicaId(), 30));
      ddC.update<PNCounter>('inventory', PNCounter.empty,
        (p) => p.decrement(ddC.selfReplicaId(), 20));

      await awaitConvergence(() => {
        const a = ddA.get<PNCounter>('inventory')?.value() ?? null;
        const b = ddB.get<PNCounter>('inventory')?.value() ?? null;
        const c = ddC.get<PNCounter>('inventory')?.value() ?? null;
        return a === 50 && b === 50 && c === 50;
      });
    });
  }, 15_000);

  test('ORSet — add wins on concurrent add + remove from different replicas', async () => {
    await withSpec(async (spec) => {
      const ddOptions = DistributedDataOptions.create()
        .withGossipInterval(80);
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), ddOptions);
      const ddB = spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), ddOptions);
      const ddC = spec.systemFor('c').extension(DistributedDataId)
        .start(spec.clusterFor('c'), ddOptions);

      // Stage 1: A adds 'apple'.  Wait for B + C to observe.
      ddA.update<ORSet<string>>('cart', () => ORSet.empty<string>(),
        (s) => s.add(ddA.selfReplicaId(), 'apple'));

      await awaitConvergence(() => {
        return (ddB.get<ORSet<string>>('cart')?.has('apple') ?? false)
          && (ddC.get<ORSet<string>>('cart')?.has('apple') ?? false);
      });

      // Stage 2: B and C act concurrently.  B removes 'apple', C
      // re-adds (with a new tag B never saw).  After convergence,
      // 'apple' must still be present (add wins).
      ddB.update<ORSet<string>>('cart', () => ORSet.empty<string>(),
        (s) => s.remove('apple'));
      ddC.update<ORSet<string>>('cart', () => ORSet.empty<string>(),
        (s) => s.add(ddC.selfReplicaId(), 'apple'));

      await awaitConvergence(() => {
        const all = ['a', 'b', 'c'].map((r) => {
          const dd = r === 'a' ? ddA : r === 'b' ? ddB : ddC;
          return dd.get<ORSet<string>>('cart')?.has('apple') ?? false;
        });
        return all.every((v) => v === true);
      });
    });
  }, 15_000);

  test('LWWMap — newer-timestamp put wins, replicas converge to same map', async () => {
    await withSpec(async (spec) => {
      const ddOptions = DistributedDataOptions.create()
        .withGossipInterval(80);
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), ddOptions);
      const ddB = spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), ddOptions);
      const ddC = spec.systemFor('c').extension(DistributedDataId)
        .start(spec.clusterFor('c'), ddOptions);

      // Three replicas, three different keys + one shared key with
      // different timestamps.  After convergence each node has the
      // full set, with the shared key resolved to the newest write.
      ddA.update<LWWMap<string, string>>('options', () => LWWMap.empty<string, string>(),
        (m) => m.put(ddA.selfReplicaId(), 'theme', 'dark', 100));
      ddB.update<LWWMap<string, string>>('options', () => LWWMap.empty<string, string>(),
        (m) => m.put(ddB.selfReplicaId(), 'lang',  'de',   100));
      ddC.update<LWWMap<string, string>>('options', () => LWWMap.empty<string, string>(),
        (m) => m.put(ddC.selfReplicaId(), 'theme', 'light', 200));   // newer

      await awaitConvergence(() => {
        for (const dd of [ddA, ddB, ddC]) {
          const m = dd.get<LWWMap<string, string>>('options');
          if (!m) return false;
          if (m.get('theme') !== 'light') return false;   // newer ts wins
          if (m.get('lang')  !== 'de')    return false;
          if (m.size !== 2) return false;
        }
        return true;
      });
    });
  }, 15_000);

  test('ORMap with nested ORSet — per-key inner-CRDT merge across replicas', async () => {
    await withSpec(async (spec) => {
      const ddOptions = DistributedDataOptions.create()
        .withGossipInterval(80);
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), ddOptions);
      const ddB = spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), ddOptions);
      const ddC = spec.systemFor('c').extension(DistributedDataId)
        .start(spec.clusterFor('c'), ddOptions);

      // Each replica adds an item to a shared cart-key in an ORMap of
      // ORSets.  After gossip, every replica sees the full set.
      ddA.update<ORMap<string, ORSet<string>>>('carts', () => ORMap.empty<string, ORSet<string>>(),
        (m) => m.update(ddA.selfReplicaId(), 'alice', () => ORSet.empty<string>(),
          (s) => s.add(ddA.selfReplicaId(), 'apple')));
      ddB.update<ORMap<string, ORSet<string>>>('carts', () => ORMap.empty<string, ORSet<string>>(),
        (m) => m.update(ddB.selfReplicaId(), 'alice', () => ORSet.empty<string>(),
          (s) => s.add(ddB.selfReplicaId(), 'banana')));
      ddC.update<ORMap<string, ORSet<string>>>('carts', () => ORMap.empty<string, ORSet<string>>(),
        (m) => m.update(ddC.selfReplicaId(), 'bob', () => ORSet.empty<string>(),
          (s) => s.add(ddC.selfReplicaId(), 'cherry')));

      await awaitConvergence(() => {
        for (const dd of [ddA, ddB, ddC]) {
          const m = dd.get<ORMap<string, ORSet<string>>>('carts');
          if (!m) return false;
          const alice = m.get('alice');
          const bob = m.get('bob');
          if (!alice || !bob) return false;
          const aliceItems = new Set(alice.value());
          const bobItems = new Set(bob.value());
          if (aliceItems.size !== 2) return false;
          if (!aliceItems.has('apple') || !aliceItems.has('banana')) return false;
          if (bobItems.size !== 1 || !bobItems.has('cherry')) return false;
        }
        return true;
      });
    });
  }, 15_000);

  test('subscribe fires on local + remote updates', async () => {
    await withSpec(async (spec) => {
      const ddOptions = DistributedDataOptions.create()
        .withGossipInterval(80);
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), ddOptions);
      const ddB = spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), ddOptions);

      const valuesOnA: number[] = [];
      const unsubscribe = ddA.subscribe<GCounter>('counter', (c) => {
        valuesOnA.push(c.value());
      });

      // Local update on A — listener fires immediately with the new value.
      ddA.update<GCounter>('counter', GCounter.empty,
        (c) => c.increment(ddA.selfReplicaId(), 1));
      // Remote update on B — gossips to A, listener fires again.
      ddB.update<GCounter>('counter', GCounter.empty,
        (c) => c.increment(ddB.selfReplicaId(), 4));

      await awaitConvergence(() => {
        return valuesOnA.includes(1) && valuesOnA.includes(5);
      });

      unsubscribe();
    });
  }, 15_000);
});
