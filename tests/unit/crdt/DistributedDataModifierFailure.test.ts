/**
 * A factory or modifier that throws fails its own update and nothing else.
 *
 * Both are the caller's code, and the replicator runs them on its own turn.
 * A throw from either used to escape into the replicator: the update went
 * down with the failed message, so an `updateAsync` never settled, and the
 * replicator restarted — and its supervisor stops it after ten restarts a
 * minute.  The failure now goes to the caller: a quorum update's promise
 * rejects with it, an update nobody awaits is logged once at error naming
 * the key, and the key keeps the value it had.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { DistributedDataId, GCounter } from '../../../src/crdt/index.js';
import { ActorRestarted } from '../../../src/SystemMessages.js';
import { assertCompletesWithin } from '../../util/AsyncAssertions.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const unsubscribes: Array<() => void> = [];

afterEach(async () => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

type Node = {
  readonly cluster: Cluster;
  readonly log: RecordingLogger;
  /** How often the replicator has restarted so far. */
  readonly restarts: () => number;
};

async function startNode(name: string, port: number): Promise<Node> {
  const log = new RecordingLogger();
  const system = ActorSystem.create(name, ActorSystemOptions.create().withLogger(log));
  systems.push(system);
  let restarts = 0;
  unsubscribes.push(system.eventStream.subscribeFunction(ActorRestarted, (event) => {
    if (event.actor.path.toString().endsWith('/cluster/crdt/data')) restarts++;
  }));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(name, 'h', port)));
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return { cluster, log, restarts: () => restarts };
}

/** What `promise` rejected with; fails the test when it resolves or does not settle. */
async function rejectionOf(promise: Promise<unknown>, label: string): Promise<unknown> {
  const outcome = promise.then(
    () => ({ resolved: true as const, reason: undefined }),
    (reason: unknown) => ({ resolved: false as const, reason }),
  );
  const settled = await assertCompletesWithin(outcome, 2_000, label);
  if (settled.resolved) throw new Error(`${label}: resolved instead of rejecting`);
  return settled.reason;
}

/** The error lines that name `key`. */
function errorsNaming(node: Node, key: string): string[] {
  return node.log.records
    .filter((record) => record.level === 'error' && record.message.includes(`"${key}"`))
    .map((record) => record.message);
}

function encoded(value: { toJSON(): unknown } | undefined): string {
  return JSON.stringify(value?.toJSON());
}

describe('DistributedData: an update whose modifier throws', () => {
  test('rejects updateAsync with that error, and the replicator keeps running with the value it had', async () => {
    const node = await startNode('ddata-modifier-async', 46_951);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);
    const self = data.selfReplicaId();
    await data.updateAsync<GCounter>('hits', GCounter.empty, (c) => c.increment(self, 2));
    const held = encoded(data.get('hits'));

    const failure = new Error('modifier failed');
    const rejection = await rejectionOf(
      data.updateAsync<GCounter>('hits', GCounter.empty, () => { throw failure; }),
      'the failed update settled',
    );

    expect(rejection).toBe(failure);
    expect(node.restarts()).toBe(0);
    expect(encoded(data.get('hits'))).toBe(held);
    await assertCompletesWithin(
      data.updateAsync<GCounter>('hits', GCounter.empty, (c) => c.increment(self, 1)),
      2_000,
      'the next update settled',
    );
    expect(data.get<GCounter>('hits')?.value()).toBe(3);
  });

  test('is logged once at error, naming the key, when nobody awaits it', async () => {
    const node = await startNode('ddata-modifier-tell', 46_952);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);
    const self = data.selfReplicaId();
    await data.updateAsync<GCounter>('hits', GCounter.empty, (c) => c.increment(self, 2));
    const held = encoded(data.get('hits'));

    data.update<GCounter>('hits', GCounter.empty, () => { throw new Error('modifier failed'); });
    // Handled after the update: one mailbox, in order.
    await assertCompletesWithin(data.getAsync('hits', { consistency: 'local' }), 2_000, 'the next read settled');

    expect(errorsNaming(node, 'hits')).toHaveLength(1);
    expect(node.restarts()).toBe(0);
    expect(encoded(data.get('hits'))).toBe(held);
  });
});

describe('DistributedData: an update whose modifier returns something that is not a CRDT', () => {
  test('is rejected the same way, before anything is stored', async () => {
    const node = await startNode('ddata-modifier-result', 46_954);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);
    const self = data.selfReplicaId();
    await data.updateAsync<GCounter>('hits', GCounter.empty, (c) => c.increment(self, 2));
    const held = encoded(data.get('hits'));

    const rejection = await rejectionOf(
      data.updateAsync<GCounter>('hits', GCounter.empty, () => undefined as unknown as GCounter),
      'the failed update settled',
    );

    expect(rejection).toBeInstanceOf(TypeError);
    expect(node.restarts()).toBe(0);
    expect(encoded(data.get('hits'))).toBe(held);
  });
});

describe('DistributedData: an update whose factory throws', () => {
  test('rejects updateAsync with that error and stores nothing', async () => {
    const node = await startNode('ddata-factory-async', 46_953);
    const data = node.cluster.system.extension(DistributedDataId).start(node.cluster);

    const failure = new Error('factory failed');
    const rejection = await rejectionOf(
      data.updateAsync<GCounter>('fresh', () => { throw failure; }, (c) => c),
      'the failed update settled',
    );

    expect(rejection).toBe(failure);
    expect(data.get('fresh')).toBeUndefined();
    expect(node.restarts()).toBe(0);
  });
});
