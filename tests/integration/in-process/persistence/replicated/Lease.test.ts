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
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Cluster, ClusterOptions } from '../../../../../src/cluster/Cluster.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import { ReplicatedEventSourcedActor } from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { InMemoryLease, inMemoryLeaseStore } from '../../../../../src/coordination/leases/InMemoryLease.js';
import type { Lease } from '../../../../../src/coordination/Lease.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

type Cmd = { kind: 'add'; n: number } | { kind: 'getValue' };
type Event = { kind: 'added'; n: number };
type State = { value: number };

class LeasedCounter extends ReplicatedEventSourcedActor<Cmd, Event, State> {
  readonly persistenceId: string;
  readonly replicaId: string;
  /** Captured loss callbacks for assertions. */
  readonly leaseLossEvents: string[] = [];
  /** Track persist throws separately from the value query. */
  lastPersistError: Error | null = null;

  constructor(
    cluster: Cluster,
    pid: string,
    replica: string,
    private readonly leaseInstance: Lease | null,
  ) {
    super(cluster);
    this.persistenceId = pid;
    this.replicaId = replica;
  }

  initialState(): State { return { value: 0 }; }
  onEvent(s: State, e: Event): State { return { value: s.value + e.n }; }

  override lease(): Lease | null { return this.leaseInstance; }
  override onLeaseLost(reason: string): void { this.leaseLossEvents.push(reason); }

  async onCommand(s: State, c: Cmd): Promise<void> {
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
  const sys = ActorSystem.create(name, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(
    sys,
    ClusterOptions.create()
      .withHost('h')
      .withPort(port)
      .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)))
      .withGossipIntervalMs(30),
  );
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
        Props.create(() => {
          actor = new LeasedCounter(cluster, 'no-lease', 'r1', null);
          return actor as unknown as Actor<unknown>;
        }),
        'a',
      );
      await sleep(80);
      expect(actor!.isLeaseHolder).toBe(true);

      // Drive a few persists straight through.
      const ref = actor!.self;
      ref.tell({ kind: 'add', n: 5 } as Cmd);
      ref.tell({ kind: 'add', n: 7 } as Cmd);
      await sleep(50);
      expect(actor!.state.value).toBe(12);
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
      const leaseA = new InMemoryLease({ name: 'shared-pid', owner: 'a', ttlMs: 30_000 });
      const leaseB = new InMemoryLease({ name: 'shared-pid', owner: 'b', ttlMs: 30_000 });
      sys.spawn(
        Props.create(() => {
          a = new LeasedCounter(cluster, 'lease-a', 'r-a', leaseA);
          return a as unknown as Actor<unknown>;
        }),
        'a',
      );
      await sleep(60);
      sys.spawn(
        Props.create(() => {
          b = new LeasedCounter(cluster, 'lease-b', 'r-b', leaseB);
          return b as unknown as Actor<unknown>;
        }),
        'b',
      );
      await sleep(60);

      expect(a!.isLeaseHolder).toBe(true);
      expect(b!.isLeaseHolder).toBe(false);

      // Holder writes → state advances.
      a!.self.tell({ kind: 'add', n: 10 } as Cmd);
      await sleep(40);
      expect(a!.state.value).toBe(10);
      expect(a!.lastPersistError).toBeNull();

      // Observer writes → onCommand catches a throw, state stays put.
      b!.self.tell({ kind: 'add', n: 99 } as Cmd);
      await sleep(40);
      expect(b!.state.value).toBe(0);
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
      const lease = new InMemoryLease({ name: 'losable', owner: 'a', ttlMs: 200 });
      sys.spawn(
        Props.create(() => {
          a = new LeasedCounter(cluster, 'lease-loss', 'r-a', lease);
          return a as unknown as Actor<unknown>;
        }),
        'a',
      );
      await sleep(60);
      expect(a!.isLeaseHolder).toBe(true);

      // Wipe the store — InMemoryLease's renewal loop will hit
      // `renew(name, owner)` next tick, find no record, and fire
      // `onLost` exactly like a real backend would on a fence/TTL
      // expiry.
      inMemoryLeaseStore._clear();
      await sleep(200); // > renewalInterval (≈ ttlMs/3 = ~70 ms)

      expect(a!.isLeaseHolder).toBe(false);
      expect(a!.leaseLossEvents).toEqual(['lease lost during renewal']);

      // Persist now throws.
      a!.self.tell({ kind: 'add', n: 1 } as Cmd);
      await sleep(40);
      expect(a!.lastPersistError).not.toBeNull();
      expect(a!.state.value).toBe(0);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  });

  test('postStop releases the lease so a fresh actor can immediately acquire', async () => {
    inMemoryLeaseStore._clear();
    const { sys, cluster } = await bootCluster('lease-handover', 70_004);
    try {
      const first = new InMemoryLease({ name: 'handover', owner: 'first', ttlMs: 30_000 });
      let ref1: LeasedCounter | null = null;
      const a1 = sys.spawn(
        Props.create(() => {
          ref1 = new LeasedCounter(cluster, 'handover-1', 'r-1', first);
          return ref1 as unknown as Actor<unknown>;
        }),
        'a1',
      );
      await sleep(60);
      expect(ref1!.isLeaseHolder).toBe(true);

      // Stop the holder cleanly — postStop releases the lease.
      a1.stop();
      await sleep(80);

      // Fresh actor with a different owner can immediately acquire
      // the same lease name.
      const second = new InMemoryLease({ name: 'handover', owner: 'second', ttlMs: 30_000 });
      let ref2: LeasedCounter | null = null;
      sys.spawn(
        Props.create(() => {
          ref2 = new LeasedCounter(cluster, 'handover-2', 'r-2', second);
          return ref2 as unknown as Actor<unknown>;
        }),
        'a2',
      );
      await sleep(60);
      expect(ref2!.isLeaseHolder).toBe(true);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  });
});
