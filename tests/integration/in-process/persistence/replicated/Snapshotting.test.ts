/**
 * Snapshot tests for ReplicatedEventSourcedActor (#41).
 *
 * Four scenarios:
 *
 *   1. Round-trip without restart — `snapshotPolicy` triggers
 *      `SnapshotStore.save` after every Nth event.
 *   2. Recovery from snapshot — restart-from-snapshot avoids
 *      re-applying the snapshotted prefix; recovered state matches
 *      pre-restart state.
 *   3. seenIds dedup survives a restart — receiving (or replaying)
 *      an event already accounted for by the snapshot is a no-op,
 *      not a double-apply.
 *   4. Default policy = never snapshot — full-replay path stays
 *      green (regression guard).
 *
 * All tests run single-node with `InMemoryJournal` + `InMemorySnapshotStore`,
 * so no MultiNodeSpec / cluster machinery is exercised — the snapshot
 * code path is purely intra-actor.
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
import { ReplicatedEventSourcedActor } from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';
import { everyNEvents } from '../../../../../src/persistence/PersistentActor.js';
import type { SnapshotPolicy } from '../../../../../src/persistence/PersistentActor.js';
import { InMemoryJournal } from '../../../../../src/persistence/journals/InMemoryJournal.js';
import { InMemorySnapshotStore } from '../../../../../src/persistence/snapshot-stores/InMemorySnapshotStore.js';
import { PersistenceExtensionId } from '../../../../../src/persistence/PersistenceExtension.js';
import { Props } from '../../../../../src/Props.js';
import type { ReplicatedSnapshot } from '../../../../../src/persistence/replicated/ReplicatedSnapshot.js';
import type { ReplicatedEventEnvelope } from '../../../../../src/persistence/ReplicatedEventSourcedActor.js';

type Cmd = { kind: 'add'; n: number };
type Event = { kind: 'added'; n: number };
type State = { value: number };

class CountingCounter extends ReplicatedEventSourcedActor<Cmd, Event, State> {
  readonly persistenceId = 'snap-counter';
  readonly replicaId: string;
  /** Spy: how many times `onEvent` was called.  Reset between restarts. */
  static onEventCallCount = 0;
  /** User-controlled snapshot policy override per test. */
  static currentPolicy: SnapshotPolicy<State, Event> = () => false;

  constructor(cluster: Cluster) {
    super(cluster);
    this.replicaId = cluster.selfAddress.toString();
  }
  initialState(): State { return { value: 0 }; }
  onEvent(s: State, e: Event): State {
    CountingCounter.onEventCallCount += 1;
    return { value: s.value + e.n };
  }
  async onCommand(_s: State, c: Cmd): Promise<void> {
    if (c.kind === 'add') await this.persist({ kind: 'added', n: c.n });
  }
  protected override snapshotPolicy(): SnapshotPolicy<State, Event> {
    return CountingCounter.currentPolicy;
  }
  /** Test hook — read state without ask(). */
  getValue(): number { return this.state.value; }
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(20);
  }
  if (!pred()) throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

interface Setup {
  sys: ActorSystem;
  cluster: Cluster;
  ref: import('../../../../../src/ActorRef.js').ActorRef<Cmd>;
  instance: CountingCounter;
}

async function startActor(
  systemName: string, port: number,
  journal: InMemoryJournal, snapshotStore: InMemorySnapshotStore,
): Promise<Setup> {
  const sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const sys = ActorSystem.create(systemName, sysOptions);
  sys.extension(PersistenceExtensionId).setJournal(journal);
  sys.extension(PersistenceExtensionId).setSnapshotStore(snapshotStore);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(30);
  const cluster = await Cluster.join(sys, clusterOptions);
  let instance!: CountingCounter;
  const ref = sys.spawn(
    Props.create<Cmd>(() => {
      const a = new CountingCounter(cluster);
      instance = a;
      return a as unknown as Actor<Cmd>;
    }),
    'counter',
  );
  // Wait for preStart to wire `instance`.
  await waitFor(() => !!instance);
  return { sys, cluster, ref, instance };
}

async function shutdown(s: Setup): Promise<void> {
  await s.cluster.leave();
  await s.sys.terminate();
}

describe('ReplicatedEventSourcedActor — snapshotting', () => {
  test('1. policy fires saveSnapshot after every Nth event', async () => {
    const journal = new InMemoryJournal();
    const snapshotStore = new InMemorySnapshotStore();
    CountingCounter.currentPolicy = everyNEvents<State, Event>(5);
    CountingCounter.onEventCallCount = 0;

    const a = await startActor('snap-1', 70_001, journal, snapshotStore);
    for (let i = 0; i < 12; i++) a.ref.tell({ kind: 'add', n: 1 });

    // Wait for state to converge.
    await waitFor(() => a.instance.getValue() === 12);

    // Allow the (fire-and-forget) snapshot save to settle.
    await sleep(80);

    // 12 events, every 5 → snapshots at observedCount=5 and observedCount=10.
    // (At 15 we'd save again but we only fired 12 events.)
    const stored = await snapshotStore.loadLatest<ReplicatedSnapshot<Event, State>>(
      a.instance.persistenceId,
    );
    expect(stored.isSome()).toBe(true);
    const snap = stored.value!.state;
    // Most recent snapshot is at the second policy hit (observedCount = 10).
    expect(snap.events.length).toBe(10);
    expect(snap.state.value).toBe(10);

    await shutdown(a);
  }, 10_000);

  test('2. recovery from snapshot avoids re-applying the prefix', async () => {
    const journal = new InMemoryJournal();
    const snapshotStore = new InMemorySnapshotStore();
    CountingCounter.currentPolicy = everyNEvents<State, Event>(5);
    CountingCounter.onEventCallCount = 0;

    const a1 = await startActor('snap-2', 70_011, journal, snapshotStore);
    // 7 events: snapshot saved at #5; events #6 and #7 only in journal.
    for (let i = 0; i < 7; i++) a1.ref.tell({ kind: 'add', n: 1 });
    await waitFor(() => a1.instance.getValue() === 7);
    await sleep(80);
    const callsDuringFirst = CountingCounter.onEventCallCount;
    expect(callsDuringFirst).toBe(7);
    await shutdown(a1);

    // Restart — recover from snapshot, then replay only events #6 + #7.
    CountingCounter.onEventCallCount = 0;
    const a2 = await startActor('snap-2-restart', 70_012, journal, snapshotStore);

    expect(a2.instance.getValue()).toBe(7);
    // The snapshot covered the first 5 events.  Recovery only had to
    // re-apply 2 more events (#6, #7) through `onEvent` — NOT all 7.
    expect(CountingCounter.onEventCallCount).toBeLessThanOrEqual(2);

    await shutdown(a2);
  }, 10_000);

  test('3. seenIds dedup survives — re-receiving a pre-snapshot event is a no-op', async () => {
    const journal = new InMemoryJournal();
    const snapshotStore = new InMemorySnapshotStore();
    CountingCounter.currentPolicy = everyNEvents<State, Event>(3);

    // Pre-seed the journal with an event whose `replica` id matches
    // a peer (not us) — so it ends up in `_seenIds` after recovery.
    const peerEnvelope: ReplicatedEventEnvelope<Event> = {
      persistenceId: 'snap-counter',
      replica: 'peer-x',
      seqAtReplica: 1,
      vc: { 'peer-x': 1 },
      timestamp: Date.now(),
      event: { kind: 'added', n: 100 },
    };
    await journal.append('snap-counter', [peerEnvelope], 0, ['replicated-es']);

    const a1 = await startActor('snap-3', 70_021, journal, snapshotStore);
    // After preStart: the peer event was absorbed once → state.value = 100,
    // _seenIds includes 'peer-x#1'.
    expect(a1.instance.getValue()).toBe(100);

    // Trigger a snapshot.
    for (let i = 0; i < 3; i++) a1.ref.tell({ kind: 'add', n: 1 });
    await waitFor(() => a1.instance.getValue() === 103);
    await sleep(80);
    await shutdown(a1);

    // Restart — recovery loads snapshot (seenIds includes 'peer-x#1').
    // We then replay the journal delta which DOES NOT include the peer
    // event again (it was already in the snapshot's `events`).  But to
    // simulate a re-broadcast, we manually re-append the same peer
    // event to the journal under a fresh local seq — this would
    // happen in production if peer-x re-broadcast its event.
    await journal.append('snap-counter', [peerEnvelope], await journal.highestSeq('snap-counter'), ['replicated-es']);

    CountingCounter.onEventCallCount = 0;
    const a2 = await startActor('snap-3-restart', 70_022, journal, snapshotStore);

    // State must be unchanged — the duplicate peer event is dropped
    // by the seenIds dedupe loaded from the snapshot.
    expect(a2.instance.getValue()).toBe(103);

    await shutdown(a2);
  }, 10_000);

  test('4. default policy (never): full journal replay, no snapshot saved', async () => {
    const journal = new InMemoryJournal();
    const snapshotStore = new InMemorySnapshotStore();
    CountingCounter.currentPolicy = () => false;

    const a1 = await startActor('snap-4', 70_031, journal, snapshotStore);
    for (let i = 0; i < 10; i++) a1.ref.tell({ kind: 'add', n: 1 });
    await waitFor(() => a1.instance.getValue() === 10);
    await sleep(80);

    // No snapshot was ever saved.
    const stored = await snapshotStore.loadLatest<ReplicatedSnapshot<Event, State>>(
      a1.instance.persistenceId,
    );
    expect(stored.isNone()).toBe(true);
    await shutdown(a1);

    // Restart goes through the full-replay path — onEvent fires for
    // every journal entry.
    CountingCounter.onEventCallCount = 0;
    const a2 = await startActor('snap-4-restart', 70_032, journal, snapshotStore);
    expect(a2.instance.getValue()).toBe(10);
    expect(CountingCounter.onEventCallCount).toBe(10);

    await shutdown(a2);
  }, 10_000);
});
