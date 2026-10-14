/**
 * What one callback subscription of `DistributedDataHandle.subscribe` is
 * (#1468).
 *
 * A subscription belongs to its subscriber and its key — the function here,
 * the actor's path in the `ActorRef` form — and the two forms answer the same
 * three questions the same way:
 *
 *  - Subscribing again adds no second subscription.  The function is called
 *    once per merge however often it subscribed, and every `subscribe` replays
 *    the current value to it, since that is what a caller asking twice wants.
 *  - Any function `subscribe` returned for a subscription ends it, and one
 *    returned for a subscription that has already ended does nothing — it
 *    cannot end the one a later `subscribe` started.
 *  - A subscription that ended and began again is a new one, so a fan-out
 *    already in flight does not mistake it for the one it captured.
 *
 * The listener set used to hold the bare function, which settled the first
 * question by accident and the other two wrongly: a stale unsubscribe removed
 * whatever subscription the function had by then, and a function unsubscribed
 * and subscribed again from inside a notification was the same set member the
 * fan-out had captured, so it got the value twice — its replay, then the
 * fan-out.  `DistributedDataSubscribers.test.ts` covers the cases a bare
 * snapshot of the set gets wrong; these are the ones the function's identity
 * alone cannot settle.
 *
 * Single node on `InMemoryTransport`; `getAsync(key, { consistency: 'local' })`
 * is the mailbox barrier, as in the sibling suites.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DistributedDataId, GCounter } from '../../../src/crdt/index.js';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
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

describe('a callback subscription belongs to its function and key', () => {
  test('a function subscribed twice is called once per merge, and replayed on each subscribe', async () => {
    const node = await startNode('ddata-identity-a', 48_701);
    const data = node.system.extension(DistributedDataId).start(node);
    const increment = (): void => {
      data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    };
    increment();
    await data.getAsync(KEY, { consistency: 'local' });

    const seen: number[] = [];
    const listener = (counter: GCounter): void => { seen.push(counter.value()); };
    const unsubscribeFirst = data.subscribe<GCounter>(KEY, listener);
    data.subscribe<GCounter>(KEY, listener);
    // Two replays — each `subscribe` asked for the current value — and no
    // second subscription behind them.
    expect(seen).toEqual([1, 1]);

    increment();
    await data.getAsync(KEY, { consistency: 'local' });
    expect(seen).toEqual([1, 1, 2]);

    // Either returned function ends the one subscription the two calls share.
    unsubscribeFirst();
    increment();
    await data.getAsync(KEY, { consistency: 'local' });
    expect(seen).toEqual([1, 1, 2]);
  });

  test('an unsubscribe returned for a subscription that already ended does not end a later one', async () => {
    // The bare function was the set member, so the first call's unsubscribe
    // removed it again — whichever subscription it belonged to by then.
    const node = await startNode('ddata-identity-b', 48_711);
    const data = node.system.extension(DistributedDataId).start(node);

    const seen: number[] = [];
    const listener = (counter: GCounter): void => { seen.push(counter.value()); };
    const unsubscribeFirst = data.subscribe<GCounter>(KEY, listener);
    unsubscribeFirst();
    const unsubscribeSecond = data.subscribe<GCounter>(KEY, listener);
    unsubscribeFirst();

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(seen).toEqual([1]);

    unsubscribeSecond();
    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(seen).toEqual([1]);
  });

  test('a function unsubscribed and subscribed again inside a notification gets the value in flight once', async () => {
    // Another listener keeps the key's subscriptions alive throughout, so the
    // second subscription lands where the fan-out is looking — and the
    // function it finds there is the very one it captured.  Asking whether
    // that function is still subscribed answers yes, and the value it already
    // had from its replay was handed to it a second time: `[1, 1]`.
    const node = await startNode('ddata-identity-c', 48_721);
    const data = node.system.extension(DistributedDataId).start(node);

    const seen: number[] = [];
    const listener = (counter: GCounter): void => { seen.push(counter.value()); };
    let unsubscribeListener: () => void = () => {};
    let resubscribed = false;
    data.subscribe<GCounter>(KEY, () => {
      if (resubscribed) return;
      resubscribed = true;
      unsubscribeListener();
      unsubscribeListener = data.subscribe<GCounter>(KEY, listener);
    });
    unsubscribeListener = data.subscribe<GCounter>(KEY, listener);

    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(seen).toEqual([1]);

    // And the subscription it took out from inside the notification is a
    // live one: the next merge reaches it, once.
    data.update<GCounter>(KEY, GCounter.empty, (counter) => counter.increment(data.selfReplicaId(), 1));
    await data.getAsync(KEY, { consistency: 'local' });
    expect(seen).toEqual([1, 2]);
  });
});
