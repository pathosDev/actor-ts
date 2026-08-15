/**
 * #89 — Optional Lease for `ReplicatedEventSourcedActor`.  Single-
 * writer mode for multi-master event sourcing: the lease holder
 * persists, non-holders are observers that throw on `persist`.
 *
 * Tests use `InMemoryLease` (shared store across instances within the
 * same test process) so two replicas can fight over the same lease
 * name without bringing up a real cluster.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { ReplicatedEventSourcedActor } from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { InMemoryLease, inMemoryLeaseStore } from '../../../../../src/coordination/leases/InMemoryLease.js';
import { LeaseOptions } from '../../../../../src/coordination/LeaseOptions.js';
import { type Lease } from '../../../../../src/coordination/Lease.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

/**
 * `ReplicatedEventSourcedActor._isLeaseHolder` starts **true** and only
 * flips on the `acquire` outcome, so "the actor reports it holds the
 * lease" is not evidence that acquisition ran — an actor whose preStart
 * has not reached `acquire()` yet reports exactly the same thing.  Waits
 * for acquisition therefore poll the lease itself (`checkAlive()` / the
 * shared store), and waits for *refusal* poll the true→false transition,
 * which only the failed acquire can produce (#418).
 */
const WAIT = { timeoutMs: 4_000 } as const;

type Command = { kind: 'add'; n: number } | { kind: 'getValue' };
type Event = { kind: 'added'; n: number };
type State = { value: number };

class LeasedCounter extends ReplicatedEventSourcedActor<Command, Event, State> {
  readonly persistenceId: string;
  /** Captured loss callbacks for assertions. */
  readonly leaseLossEvents: string[] = [];
  /** Track persist throws separately from the value query. */
  lastPersistError: Error | null = null;

  constructor(
    persistenceId: string,
    private readonly replica: string,
    private readonly leaseInstance: Lease | null,
  ) {
    super();
    this.persistenceId = persistenceId;
  }

  /**
   * Fixed names rather than the node-address default: these replicas all
   * share one node, so the default would give them the same id.
   */
  override get replicaId(): string { return this.replica; }

  initialState(): State { return { value: 0 }; }
  onEvent(s: State, e: Event): State { return { value: s.value + e.n }; }

  override lease(): Lease | null { return this.leaseInstance; }
  override onLeaseLost(reason: string): void { this.leaseLossEvents.push(reason); }

  /*
   * `isLeaseHolder`, `state` and `self` are protected on the base classes
   * and stay that way — they are an actor's own business, and a `Reflect`
   * or `as any` reach-around from the test body would be exactly the debt
   * #488 exists to remove.  A subclass may read its own protected members,
   * so this fixture publishes the three the assertions need, under names
   * that say what the test is looking at.
   */

  /** Whether this replica currently holds the lease (observer when false). */
  get leaseHeld(): boolean { return this.isLeaseHolder; }
  /** The replicated state as this replica has folded it so far. */
  get currentState(): State { return this.state; }
  /** This replica's own ref, for driving commands straight at it. */
  get ref(): ActorRef<Command> { return this.self; }

  async onCommand(s: State, c: Command): Promise<void> {
    if (c.kind === 'getValue') {
      this.sender.toNullable()?.tell(s.value);
      return;
    }
    if (c.kind === 'add') {
      try {
        await this.persist({ kind: 'added', n: c.n });
      } catch (e) {
        this.lastPersistError = e as Error;
      }
    }
  }
}

async function bootCluster(name: string, port: number): Promise<{
  sys: ActorSystem; cluster: Cluster;
}> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(name, sysOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(sys, clusterOptions);
  return { sys, cluster };
}

describe('ReplicatedEventSourcedActor — optional Lease (#89)', () => {
  test('no lease configured → multi-master baseline (every replica may persist)', async () => {
    // Sanity check: the default `lease()` returns null and the actor
    // never throws on persist — the v0.6.0 behaviour is unchanged.
    const { sys, cluster } = await bootCluster('lease-default', 70_001);
    let actor: LeasedCounter | null = null;
    try {
      sys.spawn(
        () => {
          actor = new LeasedCounter('no-lease', 'r1', null);
          return actor as unknown as Actor<unknown>;
        },
        'a',
      );
      await awaitCondition(() => actor !== null, { ...WAIT, label: 'the actor was constructed' });
      expect(actor!.leaseHeld).toBe(true);

      // Drive a few persists straight through.
      const ref = actor!.ref;
      ref.tell({ kind: 'add', n: 5 } as Command);
      ref.tell({ kind: 'add', n: 7 } as Command);
      await awaitCondition(() => actor!.currentState.value === 12, {
        ...WAIT, label: 'both adds folded into the replicated state',
      });
      expect(actor!.currentState.value).toBe(12);
      expect(actor!.lastPersistError).toBeNull();
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  });

  test('lease holder may persist; non-holder throws and stays in observer state', async () => {
    // Two replicas in the same process race for the SAME lease name.
    // Use distinct persistenceIds so the in-process single-writer
    // registry (#58) doesn't fire — the lease is the only coordinator.
    inMemoryLeaseStore._clear();
    const { sys, cluster } = await bootCluster('lease-contention', 70_002);
    let a: LeasedCounter | null = null;
    let b: LeasedCounter | null = null;
    try {
      const leaseAOptions = LeaseOptions.create()
        .withName('shared-pid')
        .withOwner('a')
        .withTtlMs(30_000);
      const leaseA = new InMemoryLease(leaseAOptions);
      const leaseBOptions = LeaseOptions.create()
        .withName('shared-pid')
        .withOwner('b')
        .withTtlMs(30_000);
      const leaseB = new InMemoryLease(leaseBOptions);
      sys.spawn(
        () => {
          a = new LeasedCounter('lease-a', 'r-a', leaseA);
          return a as unknown as Actor<unknown>;
        },
        'a',
      );
      // a must actually hold the lease before b races for it, or the test
      // proves nothing about contention.
      await awaitCondition(() => leaseA.checkAlive(), {
        ...WAIT, label: 'replica a holds the shared lease',
      });
      sys.spawn(
        () => {
          b = new LeasedCounter('lease-b', 'r-b', leaseB);
          return b as unknown as Actor<unknown>;
        },
        'b',
      );
      // The true→false flip is the refusal itself — the only thing that
      // produces it is `acquire()` coming back false.
      await awaitCondition(() => b !== null && !b.leaseHeld, {
        ...WAIT, label: 'replica b was refused and dropped to observer mode',
      });

      expect(a!.leaseHeld).toBe(true);
      expect(b!.leaseHeld).toBe(false);

      // Holder writes → state advances.
      a!.ref.tell({ kind: 'add', n: 10 } as Command);
      await awaitCondition(() => a!.currentState.value === 10, {
        ...WAIT, label: 'the holder persisted its add',
      });
      expect(a!.currentState.value).toBe(10);
      expect(a!.lastPersistError).toBeNull();

      // Observer writes → onCommand catches a throw, state stays put.
      b!.ref.tell({ kind: 'add', n: 99 } as Command);
      await awaitCondition(() => b!.lastPersistError !== null, {
        ...WAIT, label: 'the observer\'s persist threw',
      });
      expect(b!.currentState.value).toBe(0);
      expect(b!.lastPersistError).not.toBeNull();
      expect(b!.lastPersistError!.message).toMatch(/observer mode/);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  });

  test('lease loss flips the holder to observer mode and fires onLeaseLost', async () => {
    inMemoryLeaseStore._clear();
    const { sys, cluster } = await bootCluster('lease-loss', 70_003);
    let a: LeasedCounter | null = null;
    try {
      // Short TTL so the renewal loop runs every ~70 ms — quick
      // enough for the test to observe loss without a long sleep.
      const leaseOptions = LeaseOptions.create()
        .withName('losable')
        .withOwner('a')
        .withTtlMs(200);
      const lease = new InMemoryLease(leaseOptions);
      sys.spawn(
        () => {
          a = new LeasedCounter('lease-loss', 'r-a', lease);
          return a as unknown as Actor<unknown>;
        },
        'a',
      );
      await awaitCondition(() => lease.checkAlive(), {
        ...WAIT, label: 'the actor acquired the losable lease',
      });
      expect(a!.leaseHeld).toBe(true);

      // Wipe the store — InMemoryLease's renewal loop will hit
      // `renew(name, owner)` next tick, find no record, and fire
      // `onLost` exactly like a real backend would on a fence/TTL
      // expiry.
      inMemoryLeaseStore._clear();
      // The renewal tick is ~70 ms on an idle machine; the old 200 ms budget
      // was under three of them.  What the test is about is the *reaction* to
      // loss, not the cadence, so wait for the callback.
      await awaitCondition(() => a!.leaseLossEvents.length > 0, {
        ...WAIT, intervalMs: 20, label: 'the renewal loop reported the lost lease',
      });

      expect(a!.leaseHeld).toBe(false);
      expect(a!.leaseLossEvents).toEqual(['lease lost during renewal']);

      // Persist now throws.
      a!.ref.tell({ kind: 'add', n: 1 } as Command);
      await awaitCondition(() => a!.lastPersistError !== null, {
        ...WAIT, label: 'the persist after the loss threw',
      });
      expect(a!.lastPersistError).not.toBeNull();
      expect(a!.currentState.value).toBe(0);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  });

  test('postStop releases the lease so a fresh actor can immediately acquire', async () => {
    inMemoryLeaseStore._clear();
    const { sys, cluster } = await bootCluster('lease-handover', 70_004);
    try {
      const firstOptions = LeaseOptions.create()
        .withName('handover')
        .withOwner('first')
        .withTtlMs(30_000);
      const first = new InMemoryLease(firstOptions);
      let ref1: LeasedCounter | null = null;
      const a1 = sys.spawn(
        () => {
          ref1 = new LeasedCounter('handover-1', 'r-1', first);
          return ref1 as unknown as Actor<unknown>;
        },
        'a1',
      );
      await awaitCondition(() => first.checkAlive(), {
        ...WAIT, label: 'the first actor acquired the handover lease',
      });
      expect(ref1!.leaseHeld).toBe(true);

      // Stop the holder cleanly — postStop releases the lease.  The released
      // record disappearing from the store is the handover itself; a fixed
      // wait here is what made this test a coin flip under load.
      a1.stop();
      await awaitCondition(() => inMemoryLeaseStore.peek('handover') === undefined, {
        ...WAIT, label: 'postStop released the handover lease',
      });

      // Fresh actor with a different owner can immediately acquire
      // the same lease name.
      const secondOptions = LeaseOptions.create()
        .withName('handover')
        .withOwner('second')
        .withTtlMs(30_000);
      const second = new InMemoryLease(secondOptions);
      let ref2: LeasedCounter | null = null;
      sys.spawn(
        () => {
          ref2 = new LeasedCounter('handover-2', 'r-2', second);
          return ref2 as unknown as Actor<unknown>;
        },
        'a2',
      );
      await awaitCondition(() => second.checkAlive(), {
        ...WAIT, label: 'the second actor acquired the released lease',
      });
      expect(ref2!.leaseHeld).toBe(true);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  });
});
