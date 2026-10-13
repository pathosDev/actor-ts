/**
 * The synchronous subscriber contract of `DistributedDataHandle.subscribe`
 * (#1468).
 *
 * A listener runs on the replicator's own turn, inside the merge, and a key
 * that already holds a value is replayed to a new listener on the caller's
 * stack.  Both halves stay; what this file pins is where they used to
 * disagree with each other: the fan-out walked the live listener `Set`, and a
 * `Set` iterator visits members added while it runs — so a listener
 * subscribed from inside a notification for the same key got that value
 * twice, once from its own replay and once from the merge still in progress.
 *
 * Single node on `InMemoryTransport`, as the other suites in this directory
 * run it.  `getAsync(key, { consistency: 'local' })` is the mailbox barrier:
 * it is answered on the replicator's turn, after every `update` told before
 * it, so the listeners have already run when it resolves — nothing here waits
 * on a clock.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { NoopLogger, type Logger } from '../../../src/Logger.js';
import { DistributedDataId, GCounter } from '../../../src/crdt/index.js';

/* ============================== fixtures ================================ */

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

async function startNode(name: string, port: number, logger: Logger = new NoopLogger()): Promise<Cluster> {
  const options = ActorSystemOptions.create().withLogger(logger);
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

/* ================ subscribing from inside a notification ================ */

describe('a subscribe from inside a notification', () => {
  test('receives the value in flight once, by its own replay', async () => {
    // The live-`Set` walk handed the late listener `2` from its replay and
    // then again from the fan-out it was added during: `[2, 2]`, and
    // `[2, 2, 3]` after the next update.
    const node = await startNode('ddata-subscribers-a', 48_601);
    const data = node.system.extension(DistributedDataId).start(node);
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };

    const late: number[] = [];
    let lateSubscribed = false;
    data.subscribe<GCounter>(KEY, (counter) => {
      if (counter.value() !== 2 || lateSubscribed) return;
      lateSubscribed = true;
      data.subscribe<GCounter>(KEY, (seen) => late.push(seen.value()));
    });

    increment();
    increment();
    await data.getAsync(KEY, { consistency: 'local' });
    expect(late).toEqual([2]);

    increment();
    await data.getAsync(KEY, { consistency: 'local' });
    expect(late).toEqual([2, 3]);
  });

  test('a listener unsubscribed earlier in the same fan-out is not called for that value', async () => {
    // The other half of the same walk, and the half a bare copy of the set
    // would break: it would still call `second`, which `first` had already
    // let go of.
    const node = await startNode('ddata-subscribers-b', 48_611);
    const data = node.system.extension(DistributedDataId).start(node);

    const calls: string[] = [];
    let unsubscribeSecond: () => void = () => {};
    data.subscribe<GCounter>(KEY, (counter) => {
      calls.push(`first:${counter.value()}`);
      unsubscribeSecond();
    });
    unsubscribeSecond = data.subscribe<GCounter>(KEY, (counter) => {
      calls.push(`second:${counter.value()}`);
    });

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(calls).toEqual(['first:1']);

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(calls).toEqual(['first:1', 'first:2']);
  });
});
