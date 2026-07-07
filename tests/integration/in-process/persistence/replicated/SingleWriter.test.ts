/**
 * #58 — `ReplicatedEventSourcedActor` enforces single-writer per
 * `persistenceId` per ActorSystem.  Two actors on the same node
 * sharing a pid race their journal appends; this test confirms the
 * second one fails loudly at preStart instead of silently dropping
 * writes.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import { ReplicatedEventSourcedActor } from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';

type Cmd = { kind: 'add'; n: number };
type Event = { kind: 'added'; n: number };
type State = { value: number };

/** Static counter so the test can assert preStart actually ran on
 *  the surviving actor and threw on the duplicate. */
let preStartFailures = 0;

class Counter extends ReplicatedEventSourcedActor<Cmd, Event, State> {
  readonly persistenceId = 'shared-counter';
  readonly replicaId: string;
  constructor(cluster: Cluster) {
    super(cluster);
    this.replicaId = cluster.selfAddress.toString();
  }
  initialState(): State { return { value: 0 }; }
  onEvent(s: State, e: Event): State { return { value: s.value + e.n }; }
  async onCommand(_s: State, c: Cmd): Promise<void> {
    if (c.kind === 'add') await this.persist({ kind: 'added', n: c.n });
  }
  override async preStart(): Promise<void> {
    try { await super.preStart(); }
    catch (err) { preStartFailures += 1; throw err; }
  }
}

describe('ReplicatedEventSourcedActor — single-writer per pid (#58)', () => {
  test('spawning two actors with the same persistenceId on one node — second fails loudly', async () => {
    preStartFailures = 0;
    const sys = ActorSystem.create('single-writer', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const cluster = await Cluster.join(
      sys,
      ClusterOptions.create()
        .withHost('h')
        .withPort(80_001)
        .withTransport(new InMemoryTransport(new NodeAddress('single-writer', 'h', 80_001)))
        .withGossipIntervalMs(30),
    );
    try {
      // First actor — succeeds.
      const a1 = sys.spawn(
        Props.create(() => new Counter(cluster) as unknown as Actor<unknown>),
        'a1',
      );
      // Give it time to enter preStart.
      await Bun.sleep(50);

      // Second actor with the SAME pid — its preStart should throw.
      // The actor goes into supervision-restart loop; we let it
      // settle and then verify the registry blocked it consistently
      // (every restart attempt re-throws because a1 is still live).
      const a2 = sys.spawn(
        Props.create(() => new Counter(cluster) as unknown as Actor<unknown>),
        'a2',
      );
      await Bun.sleep(150);

      expect(preStartFailures).toBeGreaterThanOrEqual(1);

      // Stop both — a1 cleanly, a2 is already in a failed state.
      a1.stop();
      a2.stop();
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  }, 5_000);

  test('after a clean stop, a fresh actor with the same pid can be spawned', async () => {
    preStartFailures = 0;
    const sys = ActorSystem.create('single-writer-restart', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const cluster = await Cluster.join(
      sys,
      ClusterOptions.create()
        .withHost('h')
        .withPort(80_002)
        .withTransport(new InMemoryTransport(new NodeAddress('single-writer-restart', 'h', 80_002)))
        .withGossipIntervalMs(30),
    );
    try {
      const a1 = sys.spawn(
        Props.create(() => new Counter(cluster) as unknown as Actor<unknown>),
        'a1',
      );
      await Bun.sleep(50);
      a1.stop();
      // Wait for postStop to release the registration.
      await Bun.sleep(50);

      // Fresh spawn with the same pid — no failure.
      const a2 = sys.spawn(
        Props.create(() => new Counter(cluster) as unknown as Actor<unknown>),
        'a2',
      );
      await Bun.sleep(50);
      expect(preStartFailures).toBe(0);

      a2.stop();
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  }, 5_000);

  test('different ActorSystems can reuse the same persistenceId (registry is per-system)', async () => {
    // The PID registry is WeakMap-keyed by ActorSystem, so isolated
    // test fixtures with disposable systems don't trip over each
    // other's registrations.  Pin this — a future bug that promotes
    // the registry to a module-level Set would break test isolation.
    preStartFailures = 0;
    const sys1 = ActorSystem.create('sw-isolated-1', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const sys2 = ActorSystem.create('sw-isolated-2', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const cluster1 = await Cluster.join(
      sys1,
      ClusterOptions.create()
        .withHost('h')
        .withPort(80_010)
        .withTransport(new InMemoryTransport(new NodeAddress('sw-isolated-1', 'h', 80_010)))
        .withGossipIntervalMs(30),
    );
    const cluster2 = await Cluster.join(
      sys2,
      ClusterOptions.create()
        .withHost('h')
        .withPort(80_011)
        .withTransport(new InMemoryTransport(new NodeAddress('sw-isolated-2', 'h', 80_011)))
        .withGossipIntervalMs(30),
    );
    try {
      // Both spawn with persistenceId='shared-counter' — different systems.
      const a1 = sys1.spawn(
        Props.create(() => new Counter(cluster1) as unknown as Actor<unknown>),
        'a-in-sys1',
      );
      const a2 = sys2.spawn(
        Props.create(() => new Counter(cluster2) as unknown as Actor<unknown>),
        'a-in-sys2',
      );
      await Bun.sleep(100);
      // Neither preStart should have failed — the registry is per-system.
      expect(preStartFailures).toBe(0);
      a1.stop();
      a2.stop();
    } finally {
      await cluster1.leave();
      await cluster2.leave();
      await sys1.terminate();
      await sys2.terminate();
    }
  }, 5_000);

  test('preStart failure message names the conflicting persistenceId', async () => {
    // The message guides operators to the offending pid; pin the
    // shape so a refactor that drops the pid from the error doesn't
    // silently degrade debuggability.
    preStartFailures = 0;
    const errors: string[] = [];
    class CapturingCounter extends ReplicatedEventSourcedActor<Cmd, Event, State> {
      readonly persistenceId = 'capture-pid';
      readonly replicaId: string;
      constructor(cluster: Cluster) { super(cluster); this.replicaId = cluster.selfAddress.toString(); }
      initialState(): State { return { value: 0 }; }
      onEvent(s: State, e: Event): State { return { value: s.value + e.n }; }
      async onCommand(): Promise<void> { /* noop */ }
      override async preStart(): Promise<void> {
        try { await super.preStart(); }
        catch (err) { errors.push((err as Error).message); throw err; }
      }
    }

    const sys = ActorSystem.create('sw-msg', ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
    const cluster = await Cluster.join(
      sys,
      ClusterOptions.create()
        .withHost('h')
        .withPort(80_020)
        .withTransport(new InMemoryTransport(new NodeAddress('sw-msg', 'h', 80_020)))
        .withGossipIntervalMs(30),
    );
    try {
      const a1 = sys.spawn(
        Props.create(() => new CapturingCounter(cluster) as unknown as Actor<unknown>),
        'a1',
      );
      await Bun.sleep(50);
      const a2 = sys.spawn(
        Props.create(() => new CapturingCounter(cluster) as unknown as Actor<unknown>),
        'a2',
      );
      await Bun.sleep(100);
      expect(errors.some((m) => m.includes("'capture-pid'"))).toBe(true);
      a1.stop();
      a2.stop();
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  }, 5_000);
});
