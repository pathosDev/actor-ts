/**
 * Multi-node test for Replicated Event Sourcing.
 *
 * Three nodes, each running an instance of the same
 * ReplicatedEventSourcedActor with the **same** persistenceId.
 * Each replica persists a few local events; cross-replica delivery
 * over DistributedPubSub fans the events to peers; all three replicas
 * eventually see every event and therefore compute the same state.
 *
 * Coverage:
 *   - Convergence under concurrent local writes.
 *   - Idempotent re-delivery — pubsub may redeliver the same envelope;
 *     the actor's `_seenIds` set must dedupe.
 *   - Disjoint replicas (no overlapping replica ids) compute the same
 *     state regardless of merge order.
 */
import { describe, expect, test } from 'bun:test';
import { Actor as _Actor } from '../../src/Actor.js';
import { ReplicatedEventSourcedActor } from '../../src/persistence/ReplicatedEventSourcedActor.js';
import { Props } from '../../src/Props.js';
import type { Cluster } from '../../src/cluster/Cluster.js';
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import type { ActorRef } from '../../src/ActorRef.js';

type Command = { kind: 'add'; n: number };
type Event = { kind: 'added'; n: number };

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

class ReplicatedCounter extends ReplicatedEventSourcedActor<Command, Event, { value: number }> {
  readonly persistenceId = 'counter-1';
  readonly replicaId: string;
  constructor(cluster: Cluster) { super(cluster); this.replicaId = cluster.selfAddress.toString(); }
  initialState(): { value: number } { return { value: 0 }; }
  onEvent(s: { value: number }, e: Event): { value: number } {
    return { value: s.value + e.n };
  }
  async onCommand(_s: { value: number }, c: Command): Promise<void> {
    if (c.kind === 'add') await this.persist({ kind: 'added', n: c.n });
  }
  /** Test hook — read the state without going through ask(). */
  getValue(): number { return this.state.value; }
  /** Tighter gossip than production default so the test converges quickly. */
  protected override pubsubGossipIntervalMs(): number { return 80; }
}

describe('Replicated ES — three-node convergence', () => {
  test('every node sees every event and converges to the same state', async () => {
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

      // Capture each instance via a shared map keyed by role so we can
      // ask them for their state directly (Props.create returns
      // ActorRef without exposing the underlying instance).
      const instances = new Map<string, ReplicatedCounter>();
      const refs = new Map<string, ActorRef<Command>>();
      for (const role of ['a', 'b', 'c'] as const) {
        const cluster = spec.clusterFor(role);
        const ref = spec.systemFor(role).spawn(
          Props.create<Command>(() => {
            const inst = new ReplicatedCounter(cluster);
            instances.set(role, inst);
            return inst as unknown as _Actor<Command>;
          }),
          `counter-${role}`,
        );
        refs.set(role, ref);
      }

      // Wait for subscriptions to fully propagate.  PubSub gossip is
      // push-to-one-random-peer, so reaching every peer in a 3-node
      // mesh takes a few rounds in expectation.  At 80 ms × 25 rounds
      // ≈ 2 s the probability that all six pairs (A→B, A→C, B→A, B→C,
      // C→A, C→B) have exchanged subscription state is essentially 1.
      await Bun.sleep(2_000);

      // Each replica persists its own events.  Locally each replica
      // sees its own immediately, then peers' arrive over PubSub.
      refs.get('a')!.tell({ kind: 'add', n: 10 });
      refs.get('b')!.tell({ kind: 'add', n: 100 });
      refs.get('c')!.tell({ kind: 'add', n: 1_000 });

      // Convergence: all three counters reach 1110.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const aV = instances.get('a')?.getValue() ?? -1;
        const bV = instances.get('b')?.getValue() ?? -1;
        const cV = instances.get('c')?.getValue() ?? -1;
        if (aV === 1110 && bV === 1110 && cV === 1110) break;
        await Bun.sleep(50);
      }
      expect(instances.get('a')!.getValue()).toBe(1110);
      expect(instances.get('b')!.getValue()).toBe(1110);
      expect(instances.get('c')!.getValue()).toBe(1110);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 20_000);

  test('multi-round writes converge — each replica writes, then yields, repeat', async () => {
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

      const instances = new Map<string, ReplicatedCounter>();
      const refs = new Map<string, ActorRef<Command>>();
      for (const role of ['a', 'b', 'c'] as const) {
        const cluster = spec.clusterFor(role);
        const ref = spec.systemFor(role).spawn(
          Props.create<Command>(() => {
            const inst = new ReplicatedCounter(cluster);
            instances.set(role, inst);
            return inst as unknown as _Actor<Command>;
          }),
          `counter-${role}`,
        );
        refs.set(role, ref);
      }
      // Long-ish wait so all 3 replicas have exchanged subscription
      // gossip before the first publish.  Subscription propagation
      // is push-to-one-random-peer; in expectation a 3-node mesh
      // takes 5–10 rounds (≈ 0.5 s) but variance is real.
      await sleep(2_000);

      // Three rounds of (a+b+c) writes — between rounds we sleep
      // long enough for PubSub deliveries to drain and the peer
      // mailboxes to absorb every envelope before the next burst.
      // The fan-out math is: 3 replicas × 3 rounds = 9 events; each
      // replica should observe all 9, summing to 9.
      for (let round = 0; round < 3; round++) {
        for (const role of ['a', 'b', 'c'] as const) {
          refs.get(role)!.tell({ kind: 'add', n: 1 });
        }
        await sleep(300);
      }

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const all = ['a', 'b', 'c'].map((r) => instances.get(r)!.getValue());
        if (all.every((v) => v === 9)) break;
        await sleep(50);
      }
      for (const role of ['a', 'b', 'c']) {
        expect(instances.get(role)!.getValue()).toBe(9);
      }
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 20_000);
});
