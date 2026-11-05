/**
 * A replicator restart reloads the durable record into the view the restart
 * kept, rather than over it (found while #1468).
 *
 * The view outlives a restart on purpose — it is shared with the handle, and
 * the actor subscriptions live in it — but `preStart` ran its durable reload
 * as though the view were empty: `applyMerged(key, null, loaded)` set every
 * key to the record's value outright.  The record trails the view whenever a
 * save is still in flight, so a restart at the wrong moment rolled the
 * replica back to an older value, and told every subscriber that older value
 * as a change.  A CRDT has a right answer for two values of one key, and it is
 * the merge.
 *
 * The store here holds its writes on a gate the test opens, which is the "save
 * still in flight" a slow store produces.  The tests restart the replicator by
 * sending it a message outside its protocol, which fails it the way any
 * failure would, so its supervisor restarts it.
 *
 * The same restart used to leave two writers of the durable record.  The
 * store wrapper was built per actor instance, so the restarted replicator
 * loaded the record — and its revision — while the old instance's save was
 * still out; that save then landed past the revision the new wrapper held,
 * every later save failed the optimistic-concurrency check, and the next start
 * lost everything written since the restart.  The second block pins the one
 * writer that now outlives a restart from three sides: a write once the
 * pending save has landed, a write while it is still out, and a reload that
 * read the record before it landed.  The store can hold its loads on a gate
 * too, which is how a reload reads a record that a save then moves past.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger, type Logger } from '../../../src/Logger.js';
import type { DurableStateRecord, DurableStateStore } from '../../../src/persistence/DurableStateStore.js';
import { InMemoryDurableStateStore } from '../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';
import type { PersistenceOptions } from '../../../src/persistence/PersistenceOptions.js';
import { ActorRestarted } from '../../../src/SystemMessages.js';
import type { Option } from '../../../src/util/Option.js';
import { DistributedDataId, DistributedDataOptions, GCounter } from '../../../src/crdt/index.js';
import type { GCounterJson } from '../../../src/crdt/GCounter.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/** A promise the test opens by hand. */
type Gate = { readonly opened: Promise<void>; readonly open: () => void };

const gates: Gate[] = [];

const newGate = (): Gate => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  const gate = { opened, open };
  gates.push(gate);
  return gate;
};

/** An in-memory store whose writes, and loads, wait on a gate while one is set. */
class GatedDurableStateStore implements DurableStateStore {
  private readonly inner = new InMemoryDurableStateStore();
  /** Writes wait on this while it is set. */
  gate: Gate | null = null;
  /** Writes that have landed in the inner store. */
  landed = 0;
  /** Loads read the record when they are called, then wait on this while it is set. */
  loadGate: Gate | null = null;
  /** Loads that have read the record and are waiting on {@link loadGate}. */
  waitingLoads = 0;

  async upsert<S>(
    persistenceId: string, expectedRevision: number, state: S, options?: PersistenceOptions,
  ): Promise<DurableStateRecord<S>> {
    const gate = this.gate;
    if (gate !== null) await gate.opened;
    const written = await this.inner.upsert(persistenceId, expectedRevision, state, options);
    this.landed++;
    return written;
  }

  async load<S>(persistenceId: string, options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>> {
    const read = await this.inner.load<S>(persistenceId, options);
    const gate = this.loadGate;
    if (gate !== null) {
      this.waitingLoads++;
      await gate.opened;
      this.waitingLoads--;
    }
    return read;
  }

  delete(persistenceId: string): Promise<void> {
    return this.inner.delete(persistenceId);
  }
}

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  for (const gate of gates.splice(0)) gate.open();
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function startNode(name: string, port: number, log?: Logger): Promise<Cluster> {
  const options = log === undefined
    ? ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
    : ActorSystemOptions.create().withLogger(log);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)));
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return cluster;
}

const KEY = 'hits';

/**
 * Fail the replicator with a message outside its protocol, so that its
 * supervisor restarts it and the restarted instance runs its preStart —
 * durable reload included — again.
 */
async function failReplicator(system: ActorSystem): Promise<void> {
  const replicator = await system.actorSelection('/system/cluster/crdt/data').resolveOne();
  replicator.tell({ kind: 'not-a-replicator-message' } as never);
}

describe('a replicator restart with a durable store', () => {
  test('merges the reloaded record into the view instead of rolling the view back to it', async () => {
    const node = await startNode('ddata-reload-a', 48_961);
    const store = new GatedDurableStateStore();
    const distributedDataOptions = DistributedDataOptions.create().withDurableStore(store);
    const data = node.system.extension(DistributedDataId).start(node, distributedDataOptions);
    const restarts: ActorRestarted[] = [];
    const unsubscribeRestarts = node.system.eventStream.subscribeFunction(ActorRestarted, (event) => {
      restarts.push(event);
    });
    try {
      const increment = (): void => {
        data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
      };
      increment();
      await data.getAsync(KEY, { consistency: 'local' });
      await awaitCondition(() => store.landed === 1, { label: 'the value 1 reached the store' });

      // The record says 1 from here on: the next save waits on the gate.
      store.gate = newGate();
      increment();
      await data.getAsync(KEY, { consistency: 'local' });
      const seen: number[] = [];
      data.subscribe<GCounter>(KEY, (counter) => seen.push(counter.value()));
      expect(seen).toEqual([2]);

      await failReplicator(node.system);
      await awaitCondition(
        () => restarts.some((event) => event.actor.path.toString().endsWith('/cluster/crdt/data')),
        { label: 'the replicator restarted' },
      );
      // Handled after the restarted instance's preStart, reload included.
      await data.getAsync(KEY, { consistency: 'local' });

      expect(data.get<GCounter>(KEY)?.value()).toBe(2);
      // Nothing changed, so nobody is told anything — least of all the 1.
      expect(seen).toEqual([2]);
    } finally {
      unsubscribeRestarts();
    }
  });
});

type Replica = {
  readonly cluster: Cluster;
  readonly data: ReturnType<typeof startData>;
  readonly log: RecordingLogger;
  /** How often the replicator has restarted so far. */
  readonly restarts: () => number;
};

function startData(cluster: Cluster, store: DurableStateStore) {
  const distributedDataOptions = DistributedDataOptions.create().withDurableStore(store);
  return cluster.system.extension(DistributedDataId).start(cluster, distributedDataOptions);
}

async function startReplica(name: string, port: number, store: DurableStateStore): Promise<Replica> {
  const log = new RecordingLogger();
  const cluster = await startNode(name, port, log);
  let restarts = 0;
  const unsubscribe = cluster.system.eventStream.subscribeFunction(ActorRestarted, (event) => {
    if (event.actor.path.toString().endsWith('/cluster/crdt/data')) restarts++;
  });
  void cluster.system.whenTerminated().then(unsubscribe);
  return { cluster, data: startData(cluster, store), log, restarts: () => restarts };
}

function increment(replica: Replica): void {
  const self = replica.data.selfReplicaId();
  replica.data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(self, 1));
}

/** Restart the replicator through its supervisor; resolves once the restarted one has handled a message. */
async function restartReplicator(replica: Replica): Promise<void> {
  const before = replica.restarts();
  await failReplicator(replica.cluster.system);
  await awaitCondition(() => replica.restarts() === before + 1, { label: 'the replicator restarted' });
  // Handled after the restarted instance's preStart, reload included.
  await replica.data.getAsync(KEY, { consistency: 'local' });
}

/** What the durable record holds for {@link KEY} — what the next start would load. */
async function recorded(store: DurableStateStore, replica: Replica): Promise<number | undefined> {
  const persistenceId = `ddata|${replica.cluster.selfAddress.toString()}`;
  const record = await store.load<{ readonly entries: Record<string, GCounterJson> }>(persistenceId);
  if (!record.isSome()) return undefined;
  const entry = record.value.state.entries[KEY];
  return entry === undefined ? undefined : GCounter.fromJSON(entry).value();
}

function failedSaves(replica: Replica): string[] {
  return replica.log.records
    .filter((record) => record.level === 'warn' && record.message.includes('durable save failed'))
    .map((record) => record.message);
}

/** Stop the replica's node and start it again on the same address and store: what a process restart does. */
async function nextStart(replica: Replica, name: string, port: number, store: DurableStateStore): Promise<number | undefined> {
  await replica.cluster.leave().catch(() => {});
  await replica.cluster.system.terminate();
  const next = await startReplica(name, port, store);
  await next.data.getAsync(KEY, { consistency: 'local' });
  return next.data.get<GCounter>(KEY)?.value();
}

describe('a replicator restart while a durable save is still out', () => {
  test('leaves one writer: a write after that save landed reaches the record and the next start', async () => {
    const store = new GatedDurableStateStore();
    const replica = await startReplica('ddata-overlap-landed', 46_901, store);
    increment(replica);
    await awaitCondition(() => store.landed === 1, { label: 'the value 1 reached the store' });

    const pending = newGate();
    store.gate = pending;
    increment(replica);
    await replica.data.getAsync(KEY, { consistency: 'local' });
    await restartReplicator(replica);

    pending.open();
    store.gate = null;
    await awaitCondition(() => store.landed === 2, { label: 'the save out across the restart landed' });
    increment(replica);
    await awaitCondition(async () => (await recorded(store, replica)) === 3, {
      label: 'the write after the restart reached the record',
    });

    expect(failedSaves(replica)).toEqual([]);
    expect(await nextStart(replica, 'ddata-overlap-landed', 46_901, store)).toBe(3);
  });

  test('a write made while that save is still out follows it into the record', async () => {
    const store = new GatedDurableStateStore();
    const replica = await startReplica('ddata-overlap-pending', 46_911, store);
    increment(replica);
    await awaitCondition(() => store.landed === 1, { label: 'the value 1 reached the store' });

    const pending = newGate();
    store.gate = pending;
    increment(replica);
    await replica.data.getAsync(KEY, { consistency: 'local' });
    await restartReplicator(replica);
    // Before the save from before the restart has landed.
    increment(replica);
    await replica.data.getAsync(KEY, { consistency: 'local' });

    pending.open();
    store.gate = null;
    await awaitCondition(async () => (await recorded(store, replica)) === 3, {
      label: 'the write made during the save reached the record',
    });

    expect(failedSaves(replica)).toEqual([]);
    expect(await nextStart(replica, 'ddata-overlap-pending', 46_911, store)).toBe(3);
  });

  test('a reload that read the record before that save landed does not take the writer back to it', async () => {
    const store = new GatedDurableStateStore();
    const replica = await startReplica('ddata-overlap-reload', 46_921, store);
    increment(replica);
    await awaitCondition(() => store.landed === 1, { label: 'the value 1 reached the store' });

    const pending = newGate();
    store.gate = pending;
    increment(replica);
    await replica.data.getAsync(KEY, { consistency: 'local' });

    // The restarted replicator reads the record — still the 1 — and its load
    // is held until the save from before the restart has landed.
    const loading = newGate();
    store.loadGate = loading;
    await failReplicator(replica.cluster.system);
    await awaitCondition(() => store.waitingLoads === 1, { label: 'the reload read the record and is waiting' });
    pending.open();
    store.gate = null;
    await awaitCondition(() => store.landed === 2, { label: 'the save out across the restart landed' });
    loading.open();
    store.loadGate = null;
    await replica.data.getAsync(KEY, { consistency: 'local' });

    increment(replica);
    await awaitCondition(async () => (await recorded(store, replica)) === 3, {
      label: 'the write after the reload reached the record',
    });

    expect(replica.restarts()).toBe(1);
    expect(failedSaves(replica)).toEqual([]);
    expect(await nextStart(replica, 'ddata-overlap-reload', 46_921, store)).toBe(3);
  });
});
