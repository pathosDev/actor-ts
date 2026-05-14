/**
 * #58 — `ReplicatedEventSourcedActor` enforces single-writer per
 * `persistenceId` per ActorSystem.  Two actors on the same node
 * sharing a pid race their journal appends; this test confirms the
 * second one fails loudly at preStart instead of silently dropping
 * writes.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { ReplicatedEventSourcedActor } from '../../../../src/persistence/ReplicatedEventSourcedActor.js';

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
    const sys = ActorSystem.create('single-writer', {
      logger: new NoopLogger(), logLevel: LogLevel.Off,
    });
    const cluster = await Cluster.join(sys, {
      host: 'h', port: 80_001,
      transport: new InMemoryTransport(new NodeAddress('single-writer', 'h', 80_001)),
      gossipIntervalMs: 30,
    });
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
    const sys = ActorSystem.create('single-writer-restart', {
      logger: new NoopLogger(), logLevel: LogLevel.Off,
    });
    const cluster = await Cluster.join(sys, {
      host: 'h', port: 80_002,
      transport: new InMemoryTransport(new NodeAddress('single-writer-restart', 'h', 80_002)),
      gossipIntervalMs: 30,
    });
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
});
