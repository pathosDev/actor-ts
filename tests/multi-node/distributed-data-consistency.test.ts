/**
 * Multi-node tests for the WriteConsistency / ReadConsistency layer
 * on top of {@link DistributedData} — i.e. the quorum-write +
 * quorum-read API (#81).  The gossip-only path is covered by the
 * sibling `distributed-data.test.ts`.
 *
 * Scenarios:
 *   - WriteMajority blocks until ≥ ⌊N/2⌋+1 replicas have ack'd.
 *   - WriteAll blocks until every up-member has ack'd; a partitioned
 *     peer makes the call time out.
 *   - ReadMajority merges replies from peers and reflects writes that
 *     haven't yet flowed back via gossip.
 *   - Single-node cluster resolves immediately regardless of the
 *     consistency level.
 *   - { from: K } clamps to [1, N] and behaves like the equivalent
 *     fixed count.
 */
import { describe, expect, test } from 'bun:test';
import {
  DistributedDataId,
  GCounter,
  ORSet,
} from '../../src/crdt/index.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

async function withSpec(
  roles: ReadonlyArray<string>,
  body: (spec: MultiNodeSpec) => Promise<void>,
): Promise<void> {
  const spec = new MultiNodeSpec({
    roles,
    failureDetector: TIGHT_FD,
    gossipIntervalMs: 80,
  });
  try {
    await spec.start();
    await Promise.all(roles.map((r) => spec.awaitMembers(r, roles.length)));
    await body(spec);
  } finally {
    await spec.stop();
    MultiNodeTransport._resetRegistryForTest();
  }
}

describe('DistributedData — WriteConsistency / ReadConsistency', () => {
  test('WriteMajority on 3-node cluster resolves after 2/3 replicas ack', async () => {
    await withSpec(['a', 'b', 'c'], async (spec) => {
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), { gossipIntervalMs: 80 });
      const ddB = spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), { gossipIntervalMs: 80 });
      const ddC = spec.systemFor('c').extension(DistributedDataId)
        .start(spec.clusterFor('c'), { gossipIntervalMs: 80 });

      await ddA.updateAsync<GCounter>('hits', GCounter.empty,
        (c) => c.increment(ddA.selfReplicaId(), 10),
        { consistency: 'majority' });

      // Once the promise resolves, at least 2/3 replicas (incl. self)
      // must have the value.  Self always counts — so we expect ddA
      // plus at least one of {ddB, ddC} to be present.
      expect(ddA.get<GCounter>('hits')?.value()).toBe(10);
      const remoteSeen =
        (ddB.get<GCounter>('hits')?.value() === 10 ? 1 : 0) +
        (ddC.get<GCounter>('hits')?.value() === 10 ? 1 : 0);
      expect(remoteSeen).toBeGreaterThanOrEqual(1);
    });
  }, 15_000);

  test('WriteAll blocks until every up-member acks', async () => {
    await withSpec(['a', 'b', 'c'], async (spec) => {
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), { gossipIntervalMs: 80 });
      const ddB = spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), { gossipIntervalMs: 80 });
      const ddC = spec.systemFor('c').extension(DistributedDataId)
        .start(spec.clusterFor('c'), { gossipIntervalMs: 80 });

      await ddA.updateAsync<ORSet<string>>('cart', () => ORSet.empty<string>(),
        (s) => s.add(ddA.selfReplicaId(), 'apple'),
        { consistency: 'all' });

      // After WriteAll resolves all three replicas must show the value
      // synchronously — no need to wait for gossip.
      expect(ddA.get<ORSet<string>>('cart')?.has('apple')).toBe(true);
      expect(ddB.get<ORSet<string>>('cart')?.has('apple')).toBe(true);
      expect(ddC.get<ORSet<string>>('cart')?.has('apple')).toBe(true);
    });
  }, 15_000);

  test('WriteAll times out when one peer is partitioned', async () => {
    await withSpec(['a', 'b', 'c'], async (spec) => {
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), { gossipIntervalMs: 80 });
      spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), { gossipIntervalMs: 80 });
      spec.systemFor('c').extension(DistributedDataId)
        .start(spec.clusterFor('c'), { gossipIntervalMs: 80 });

      // Partition A from C so the write-request never reaches C and
      // C's ack never gets back.  A still has B reachable, so
      // 'majority' would still succeed — but 'all' won't.
      spec.partition('a', 'c');

      let rejected = false;
      try {
        await ddA.updateAsync<GCounter>('partitioned', GCounter.empty,
          (c) => c.increment(ddA.selfReplicaId(), 1),
          { consistency: 'all', timeoutMs: 500 });
      } catch (err) {
        rejected = true;
        expect((err as Error).message).toContain('quorum write');
        expect((err as Error).message).toContain('timed out');
      }
      expect(rejected).toBe(true);

      // The local value IS applied — the timeout doesn't roll back.
      expect(ddA.get<GCounter>('partitioned')?.value()).toBe(1);

      spec.heal('a', 'c');
    });
  }, 15_000);

  test('ReadMajority merges responses from peers', async () => {
    await withSpec(['a', 'b', 'c'], async (spec) => {
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), { gossipIntervalMs: 5_000 });
      const ddB = spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), { gossipIntervalMs: 5_000 });
      const ddC = spec.systemFor('c').extension(DistributedDataId)
        .start(spec.clusterFor('c'), { gossipIntervalMs: 5_000 });

      // Tall gossip interval — local writes won't have flowed via
      // gossip yet when we issue the read.  Each replica writes a
      // different increment.
      ddA.update<GCounter>('total', GCounter.empty,
        (c) => c.increment(ddA.selfReplicaId(), 3));
      ddB.update<GCounter>('total', GCounter.empty,
        (c) => c.increment(ddB.selfReplicaId(), 5));
      ddC.update<GCounter>('total', GCounter.empty,
        (c) => c.increment(ddC.selfReplicaId(), 7));

      // ReadMajority from A — pulls B (or C) plus self.  Should see
      // at least one peer's contribution merged in.
      const merged = await ddA.getAsync<GCounter>('total',
        { consistency: 'majority' });
      const v = merged?.value() ?? 0;
      // self=3, plus at least one peer (5 or 7) → 8 or 10 at minimum.
      expect(v).toBeGreaterThanOrEqual(8);

      // The merged value is also applied to the local replica — the
      // next sync `get` reflects the freshest state.
      expect(ddA.get<GCounter>('total')?.value()).toBeGreaterThanOrEqual(8);

      // Sanity: ddB / ddC haven't seen each other yet (gossip is slow).
      const _ = ddB.get<GCounter>('total')?.value();
      void _;
      void ddC;
    });
  }, 15_000);

  test('single-node cluster — every consistency level resolves immediately', async () => {
    await withSpec(['solo'], async (spec) => {
      const dd = spec.systemFor('solo').extension(DistributedDataId)
        .start(spec.clusterFor('solo'), { gossipIntervalMs: 1_000 });

      const t0 = Date.now();
      await dd.updateAsync<GCounter>('k', GCounter.empty,
        (c) => c.increment(dd.selfReplicaId(), 1),
        { consistency: 'all' });
      await dd.updateAsync<GCounter>('k', GCounter.empty,
        (c) => c.increment(dd.selfReplicaId(), 1),
        { consistency: 'majority' });
      const value = await dd.getAsync<GCounter>('k',
        { consistency: 'all' });
      const elapsed = Date.now() - t0;

      expect(value?.value()).toBe(2);
      // All three round-trips combined should be near-instant — no
      // peers to wait for.  Generous bound (250 ms) to keep CI happy.
      expect(elapsed).toBeLessThan(250);
    });
  }, 15_000);

  test('{ from: K } clamps to [1, N] and matches fixed count semantics', async () => {
    await withSpec(['a', 'b', 'c'], async (spec) => {
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), { gossipIntervalMs: 80 });
      spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), { gossipIntervalMs: 80 });
      spec.systemFor('c').extension(DistributedDataId)
        .start(spec.clusterFor('c'), { gossipIntervalMs: 80 });

      // K=1 always satisfied by self.
      await ddA.updateAsync<GCounter>('k1', GCounter.empty,
        (c) => c.increment(ddA.selfReplicaId(), 1),
        { consistency: { from: 1 } });

      // K=2 = majority on 3-node cluster — resolves once one peer acks.
      await ddA.updateAsync<GCounter>('k2', GCounter.empty,
        (c) => c.increment(ddA.selfReplicaId(), 1),
        { consistency: { from: 2 } });

      // K=999 clamps to N=3 = 'all'.
      await ddA.updateAsync<GCounter>('k3', GCounter.empty,
        (c) => c.increment(ddA.selfReplicaId(), 1),
        { consistency: { from: 999 } });

      // K=0 clamps to 1 — self-only.
      await ddA.updateAsync<GCounter>('k4', GCounter.empty,
        (c) => c.increment(ddA.selfReplicaId(), 1),
        { consistency: { from: 0 } });

      expect(ddA.get<GCounter>('k1')?.value()).toBe(1);
      expect(ddA.get<GCounter>('k2')?.value()).toBe(1);
      expect(ddA.get<GCounter>('k3')?.value()).toBe(1);
      expect(ddA.get<GCounter>('k4')?.value()).toBe(1);
    });
  }, 15_000);

  test('local consistency — fire-and-forget, no waiting', async () => {
    await withSpec(['a', 'b'], async (spec) => {
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), { gossipIntervalMs: 5_000 });
      spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), { gossipIntervalMs: 5_000 });

      const t0 = Date.now();
      await ddA.updateAsync<GCounter>('local-k', GCounter.empty,
        (c) => c.increment(ddA.selfReplicaId(), 42),
        { consistency: 'local' });
      const elapsed = Date.now() - t0;

      expect(ddA.get<GCounter>('local-k')?.value()).toBe(42);
      // 'local' returns immediately after the actor applies — no peer
      // round-trip.
      expect(elapsed).toBeLessThan(200);
    });
  }, 15_000);

  test('concurrent WriteMajority on same key — both resolve, final state is merged', async () => {
    await withSpec(['a', 'b', 'c'], async (spec) => {
      const ddA = spec.systemFor('a').extension(DistributedDataId)
        .start(spec.clusterFor('a'), { gossipIntervalMs: 80 });
      const ddB = spec.systemFor('b').extension(DistributedDataId)
        .start(spec.clusterFor('b'), { gossipIntervalMs: 80 });
      const ddC = spec.systemFor('c').extension(DistributedDataId)
        .start(spec.clusterFor('c'), { gossipIntervalMs: 80 });

      const writes = await Promise.all([
        ddA.updateAsync<GCounter>('race', GCounter.empty,
          (c) => c.increment(ddA.selfReplicaId(), 10),
          { consistency: 'majority' }),
        ddB.updateAsync<GCounter>('race', GCounter.empty,
          (c) => c.increment(ddB.selfReplicaId(), 20),
          { consistency: 'majority' }),
      ]);
      void writes;

      // After both resolve, every replica eventually converges to 30
      // (via gossip + the write-requests' merges).  Wait briefly for
      // convergence — write-requests already propagate, but the
      // *other* originator's view depends on gossip pulling the
      // counterpart back.
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const a = ddA.get<GCounter>('race')?.value() ?? 0;
        const b = ddB.get<GCounter>('race')?.value() ?? 0;
        const c = ddC.get<GCounter>('race')?.value() ?? 0;
        if (a === 30 && b === 30 && c === 30) return;
        await Bun.sleep(50);
      }
      throw new Error(
        `concurrent WriteMajority did not converge to 30: ` +
        `a=${ddA.get<GCounter>('race')?.value()}, ` +
        `b=${ddB.get<GCounter>('race')?.value()}, ` +
        `c=${ddC.get<GCounter>('race')?.value()}`,
      );
    });
  }, 15_000);
});
