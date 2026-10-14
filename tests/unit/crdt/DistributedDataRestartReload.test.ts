/**
 * A replicator restart reloads the durable record into the view the restart
 * kept, rather than over it (found while #1468).
 *
 * The view outlives a restart on purpose — it is shared with the handle, and
 * the actor subscriptions live in it — but `preStart` ran its durable reload
 * as though the view were empty: `applyMerged(key, null, loaded)` set every
 * key to the record's value outright.  The record trails the view whenever a
 * save is still in flight, so a mutator that threw at the wrong moment rolled
 * the replica back to an older value, and told every subscriber that older
 * value as a change.  A CRDT has a right answer for two values of one key, and
 * it is the merge.
 *
 * The store here holds its writes on a gate the test opens, which is the "save
 * still in flight" a slow store produces.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { DurableStateRecord, DurableStateStore } from '../../../src/persistence/DurableStateStore.js';
import { InMemoryDurableStateStore } from '../../../src/persistence/durable-state-stores/InMemoryDurableStateStore.js';
import type { PersistenceOptions } from '../../../src/persistence/PersistenceOptions.js';
import { ActorRestarted } from '../../../src/SystemMessages.js';
import type { Option } from '../../../src/util/Option.js';
import { DistributedDataId, DistributedDataOptions, GCounter } from '../../../src/crdt/index.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

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

/** An in-memory store whose writes wait on a gate while one is set. */
class GatedDurableStateStore implements DurableStateStore {
  private readonly inner = new InMemoryDurableStateStore();
  /** Writes wait on this while it is set. */
  gate: Gate | null = null;
  /** Writes that have landed in the inner store. */
  landed = 0;

  async upsert<S>(
    persistenceId: string, expectedRevision: number, state: S, options?: PersistenceOptions,
  ): Promise<DurableStateRecord<S>> {
    const gate = this.gate;
    if (gate !== null) await gate.opened;
    const written = await this.inner.upsert(persistenceId, expectedRevision, state, options);
    this.landed++;
    return written;
  }

  load<S>(persistenceId: string, options?: PersistenceOptions): Promise<Option<DurableStateRecord<S>>> {
    return this.inner.load<S>(persistenceId, options);
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

async function startNode(name: string, port: number): Promise<Cluster> {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
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

      data.update<GCounter>('other', GCounter.empty, () => { throw new Error('mutator failed'); });
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
