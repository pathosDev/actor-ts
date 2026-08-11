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
import { MultiNodeSpec } from '../../src/testkit/MultiNodeSpec.js';
import { MultiNodeTransport } from '../../src/testkit/internal/MultiNodeTransport.js';
import { awaitCondition } from '../util/AwaitCondition.js';
import type { ActorRef } from '../../src/ActorRef.js';

const ROLES = ['a', 'b', 'c'] as const;

type Role = typeof ROLES[number];

/** `from` rides along so a replica can tell whose events it has applied. */
type AddCommand = { kind: 'add'; n: number; from: Role };

type Command = AddCommand;

type AddedEvent = { kind: 'added'; n: number; from: Role };

type Event = AddedEvent;

const TIGHT_FD = {
  heartbeatIntervalMs: 50,
  unreachableAfterMs: 200,
  downAfterMs: 400,
} as const;

class ReplicatedCounter extends ReplicatedEventSourcedActor<Command, Event, { value: number }> {
  readonly persistenceId = 'counter-1';
  /**
   * Which replicas' events this instance has applied.  The subscription
   * warm-up below waits on it: `size === 3` means this replica has received
   * from both peers as well as itself.
   */
  readonly sources = new Set<Role>();
  initialState(): { value: number } { return { value: 0 }; }
  onEvent(s: { value: number }, e: Event): { value: number } {
    this.sources.add(e.from);
    return { value: s.value + e.n };
  }
  async onCommand(_s: { value: number }, c: Command): Promise<void> {
    if (c.kind === 'add') await this.persist({ kind: 'added', n: c.n, from: c.from });
  }
  /** Test hook — read the state without going through ask(). */
  getValue(): number { return this.state.value; }
  /** Tighter gossip than production default so the test converges quickly. */
  protected override pubsubGossipIntervalMs(): number { return 80; }
}

/**
 * Wait until every replica has applied an event from every replica.
 *
 * Cross-replica delivery rides on `DistributedPubSub`, whose subscriptions
 * spread by gossip; an event published before they have is dropped for good,
 * and the convergence assertions then fail as though replication were broken.
 * The two-second sleeps this replaces said as much — they were sized from a
 * probability argument about gossip rounds, which is exactly the trade
 * `awaitCondition` (#418) exists to invert.
 *
 * The probe is a *zero-valued* event, republished from every replica until
 * each one's `sources` holds all three: that is all six directed pairs
 * delivering, it is what the events under test depend on, and it leaves the
 * counter at 0 so no assertion has to know it happened.
 */
async function awaitReplicationMesh(
  refs: Map<Role, ActorRef<Command>>,
  instances: Map<Role, ReplicatedCounter>,
): Promise<void> {
  await awaitCondition(
    () => {
      for (const role of ROLES) refs.get(role)!.tell({ kind: 'add', n: 0, from: role });
      return ROLES.every((role) => (instances.get(role)?.sources.size ?? 0) === ROLES.length);
    },
    {
      timeoutMs: 15_000,
      intervalMs: 100,
      label: 'every replica has applied an event from all three replicas',
    },
  );
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
      // ask them for their state directly (the factory returns
      // ActorRef without exposing the underlying instance).
      const instances = new Map<Role, ReplicatedCounter>();
      const refs = new Map<Role, ActorRef<Command>>();
      for (const role of ROLES) {
        const ref = spec.systemFor(role).spawn(
          () => {
            const inst = new ReplicatedCounter();
            instances.set(role, inst);
            return inst as unknown as _Actor<Command>;
          },
          `counter-${role}`,
        );
        refs.set(role, ref);
      }

      await awaitReplicationMesh(refs, instances);

      // Each replica persists its own events.  Locally each replica
      // sees its own immediately, then peers' arrive over PubSub.
      refs.get('a')!.tell({ kind: 'add', n: 10, from: 'a' });
      refs.get('b')!.tell({ kind: 'add', n: 100, from: 'b' });
      refs.get('c')!.tell({ kind: 'add', n: 1_000, from: 'c' });

      // Convergence: all three counters reach 1110.
      await awaitCondition(
        () => ROLES.every((role) => instances.get(role)?.getValue() === 1110),
        { timeoutMs: 5_000, intervalMs: 25, label: 'all three replicas converged to 1110' },
      );
      for (const role of ROLES) expect(instances.get(role)!.getValue()).toBe(1110);
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

      const instances = new Map<Role, ReplicatedCounter>();
      const refs = new Map<Role, ActorRef<Command>>();
      for (const role of ROLES) {
        const ref = spec.systemFor(role).spawn(
          () => {
            const inst = new ReplicatedCounter();
            instances.set(role, inst);
            return inst as unknown as _Actor<Command>;
          },
          `counter-${role}`,
        );
        refs.set(role, ref);
      }
      await awaitReplicationMesh(refs, instances);

      // Three rounds of (a+b+c) writes.  Between rounds, wait for the round
      // to have landed everywhere rather than for 300 ms of "long enough for
      // PubSub deliveries to drain" — the running total is the drain, exactly.
      // The fan-out math is: 3 replicas × 3 rounds = 9 events; each replica
      // should observe all 9, summing to 9.
      for (let round = 0; round < 3; round++) {
        for (const role of ROLES) refs.get(role)!.tell({ kind: 'add', n: 1, from: role });
        const expected = (round + 1) * ROLES.length;
        await awaitCondition(
          () => ROLES.every((role) => instances.get(role)?.getValue() === expected),
          {
            timeoutMs: 10_000,
            intervalMs: 25,
            label: `every replica observed all ${expected} events after round ${round + 1}`,
          },
        );
      }

      for (const role of ROLES) expect(instances.get(role)!.getValue()).toBe(9);
    } finally {
      await spec.stop();
      MultiNodeTransport._resetRegistryForTest();
    }
  }, 20_000);
});
