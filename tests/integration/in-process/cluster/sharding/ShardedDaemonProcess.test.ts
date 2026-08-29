import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { ShardedDaemonProcess } from '../../../../../src/cluster/sharding/ShardedDaemonProcess.js';
import { ShardedDaemonProcessOptions } from '../../../../../src/cluster/sharding/ShardedDaemonProcessOptions.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import type { ActorFactory } from '../../../../../src/Actor.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';
import { awaitCondition, sleep } from '../../../../util/AwaitCondition.js';

/**
 * Kept as a name so every call site here stays unchanged; the body forwards to
 * the shared helper (#418), which names the awaited state in its timeout message
 * and — unlike the deadline loop it replaces — cannot fall through silently.
 */
const waitFor = (
  predicate: () => boolean,
  timeoutMs = 3_000,
  stepMs = 25,
  label = 'the awaited daemon-process state',
): Promise<void> => awaitCondition(predicate, { timeoutMs, intervalMs: stepMs, label });

type NodeSetup = {
  system: ActorSystem;
  cluster: Cluster;
  kit: TestKit;
};

async function startNode(systemName: string, host: string, port: number, seeds: string[] = []): Promise<NodeSetup> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(systemName, kitOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, host, port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { system: kit.system, cluster, kit };
}

describe('ShardedDaemonProcess — single node', () => {
  test('spawns exactly N daemons and routes messages by index', async () => {
    const nodeA = await startNode('sdp-1', 'h', 53001);
    const kit = nodeA.kit;
    const probe = kit.createTestProbe();

    class Worker extends Actor<string> {
      private readonly index: number;
      constructor(i: number) { super(); this.index = i; }
      override preStart(): void { probe.tell(`start-${this.index}`); }
      override onReceive(m: string): void { probe.tell(`${this.index}:${m}`); }
    }

    const daemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(4)
      .withActorFor((i) => () => new Worker(i));
    const handle = ShardedDaemonProcess.init<string>(nodeA.system, nodeA.cluster, daemonOptions);

    // No warm-up wait: the four `receiveOne(1_000)` calls below each wait for
    // their own message, so a fixed delay in front of them only ever added
    // 150 ms to a passing run (#418).
    const starts: string[] = [];
    for (let i = 0; i < 4; i++) starts.push(await probe.receiveOne(1_000) as string);
    expect(new Set(starts)).toEqual(new Set(['start-0', 'start-1', 'start-2', 'start-3']));

    handle.tell(2, 'hello');
    expect(await probe.expectMessage('2:hello', 1_000)).toBe('2:hello');

    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });
});

describe('ShardedDaemonProcess — multi-node', () => {
  test('daemons distribute across nodes', async () => {
    const nodeA = await startNode('sdp-m', 'h', 53101);
    const nodeB = await startNode('sdp-m', 'h', 53102, ['sdp-m@h:53101']);
    const nodeC = await startNode('sdp-m', 'h', 53103, ['sdp-m@h:53101']);
    await waitFor(() =>
      nodeA.cluster.upMembers().length === 3 &&
      nodeB.cluster.upMembers().length === 3 &&
      nodeC.cluster.upMembers().length === 3,
    );

    // Each node needs a record so we can tell which node hosted which daemon.
    const hostedByA: Set<number> = new Set();
    const hostedByB: Set<number> = new Set();
    const hostedByC: Set<number> = new Set();

    const makeWorker = (i: number, where: Set<number>): ActorFactory<string> =>
      () => new class extends Actor<string> {
        override preStart(): void { where.add(i); }
        override onReceive(): void {}
      };

    const aDaemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(9)
      .withActorFor((i) => makeWorker(i, hostedByA));
    ShardedDaemonProcess.init<string>(nodeA.system, nodeA.cluster, aDaemonOptions);
    const bDaemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(9)
      .withActorFor((i) => makeWorker(i, hostedByB));
    ShardedDaemonProcess.init<string>(nodeB.system, nodeB.cluster, bDaemonOptions);
    const cDaemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(9)
      .withActorFor((i) => makeWorker(i, hostedByC));
    ShardedDaemonProcess.init<string>(nodeC.system, nodeC.cluster, cDaemonOptions);

    await waitFor(() => hostedByA.size + hostedByB.size + hostedByC.size === 9, 5_000);

    expect(hostedByA.size + hostedByB.size + hostedByC.size).toBe(9);
    // Each daemon index runs on exactly one node.
    const all = new Set<number>();
    for (const shardId of [hostedByA, hostedByB, hostedByC]) for (const i of shardId) all.add(i);
    expect(all.size).toBe(9);

    // LeastShardAllocationStrategy should give every node at least one daemon —
    // but that is an *eventual* guarantee, delivered by the rebalancer, not a
    // property of the first allocation.
    //
    // The coordinator allocates against the regions that have registered by
    // the time it handles the request, and since #409 it handles a batch of
    // requests per turn rather than one.  So on a cold start the node whose
    // region registers first can legitimately take every shard — measured
    // here as 9/0/0 immediately, converging to 3/3/3 once
    // `rebalance-interval` (2s) has fired twice, since
    // `maxSimultaneousRebalance` moves 3 at a time.  Asserting on the
    // immediate split only ever passed because one message per turn left
    // enough room for the other two registrations to interleave.
    //
    // These sets are cumulative — a worker adds its index in `preStart` and
    // nothing removes it — so the condition is monotone and safe to poll.
    await waitFor(
      () => hostedByA.size >= 1 && hostedByB.size >= 1 && hostedByC.size >= 1,
      20_000,
    );
    const counts = [hostedByA.size, hostedByB.size, hostedByC.size].sort();
    expect(counts[0]).toBeGreaterThanOrEqual(1);

    await nodeA.cluster.leave(); await nodeA.system.terminate();
    await nodeB.cluster.leave(); await nodeB.system.terminate();
    await nodeC.cluster.leave(); await nodeC.system.terminate();
  }, 30_000);
});

describe('ShardedDaemonProcess — liveness heartbeat', () => {
  test('handle.stop() cancels the heartbeat without leaking timers', async () => {
    const nodeA = await startNode('sdp-live', 'h', 53201);
    const kit = nodeA.kit;
    const probe = kit.createTestProbe();

    class W extends Actor<string> {
      constructor(private readonly i: number) { super(); }
      override preStart(): void { probe.tell(`start-${this.i}`); }
      override onReceive(): void {}
    }

    const daemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(2)
      .withActorFor((i) => () => new W(i))
      // Tight livenessIntervalMs so the heartbeat would re-wake daemons
      // every 80 ms while the test runs.  We're not asserting on
      // additional preStart fires (rememberEntities prevents that), but
      // we *are* asserting that handle.stop() cleanly cancels the timer
      // instead of leaving a zombie that fires after teardown.
      .withLivenessIntervalMs(80);
    const handle = ShardedDaemonProcess.init<string>(nodeA.system, nodeA.cluster, daemonOptions);

    // Drain initial preStarts.
    for (let i = 0; i < 2; i++) await probe.receiveOne(1_000);

    // Run a couple heartbeat ticks — they should be benign no-ops because
    // rememberEntities keeps the daemons alive.
    await sleep(250);

    handle.stop();
    handle.stop();   // idempotent

    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });

  test('livenessIntervalMs: 0 disables the heartbeat', async () => {
    const nodeA = await startNode('sdp-noheart', 'h', 53202);
    const kit = nodeA.kit;
    const probe = kit.createTestProbe();

    class W extends Actor<string> {
      constructor(private readonly i: number) { super(); }
      override preStart(): void { probe.tell(`start-${this.i}`); }
      override onReceive(): void {}
    }

    const daemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(2)
      .withActorFor((i) => () => new W(i))
      .withLivenessIntervalMs(0);
    const handle = ShardedDaemonProcess.init<string>(nodeA.system, nodeA.cluster, daemonOptions);

    for (let i = 0; i < 2; i++) await probe.receiveOne(1_000);

    handle.stop();
    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });
});
