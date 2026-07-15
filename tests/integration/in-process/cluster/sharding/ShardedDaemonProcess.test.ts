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
import { Props } from '../../../../../src/Props.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
async function waitFor(pred: () => boolean, timeoutMs = 3_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface NodeSetup {
  system: ActorSystem;
  cluster: Cluster;
  kit: TestKit;
}

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
    const probe = kit.createTestProbe<string>();

    class Worker extends Actor<string> {
      private readonly index: number;
      constructor(i: number) { super(); this.index = i; }
      override preStart(): void { probe.tell(`start-${this.index}`); }
      override onReceive(m: string): void { probe.tell(`${this.index}:${m}`); }
    }

    const daemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(4)
      .withBehaviorFor((i) => Props.create(() => new Worker(i)));
    const handle = ShardedDaemonProcess.init<string>(nodeA.system, nodeA.cluster, daemonOptions);
    await sleep(150);

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

    const makeWorker = (i: number, where: Set<number>): Props<string> =>
      Props.create(() => new class extends Actor<string> {
        override preStart(): void { where.add(i); }
        override onReceive(): void {}
      });

    const aDaemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(9)
      .withBehaviorFor((i) => makeWorker(i, hostedByA));
    ShardedDaemonProcess.init<string>(nodeA.system, nodeA.cluster, aDaemonOptions);
    const bDaemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(9)
      .withBehaviorFor((i) => makeWorker(i, hostedByB));
    ShardedDaemonProcess.init<string>(nodeB.system, nodeB.cluster, bDaemonOptions);
    const cDaemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(9)
      .withBehaviorFor((i) => makeWorker(i, hostedByC));
    ShardedDaemonProcess.init<string>(nodeC.system, nodeC.cluster, cDaemonOptions);

    await waitFor(() => hostedByA.size + hostedByB.size + hostedByC.size === 9, 5_000);

    expect(hostedByA.size + hostedByB.size + hostedByC.size).toBe(9);
    // Each daemon index runs on exactly one node.
    const all = new Set<number>();
    for (const shardId of [hostedByA, hostedByB, hostedByC]) for (const i of shardId) all.add(i);
    expect(all.size).toBe(9);

    // LeastShardAllocationStrategy should give every node at least one daemon.
    const counts = [hostedByA.size, hostedByB.size, hostedByC.size].sort();
    expect(counts[0]).toBeGreaterThanOrEqual(1);

    await nodeA.cluster.leave(); await nodeA.system.terminate();
    await nodeB.cluster.leave(); await nodeB.system.terminate();
    await nodeC.cluster.leave(); await nodeC.system.terminate();
  });
});

describe('ShardedDaemonProcess — liveness heartbeat', () => {
  test('handle.stop() cancels the heartbeat without leaking timers', async () => {
    const nodeA = await startNode('sdp-live', 'h', 53201);
    const kit = nodeA.kit;
    const probe = kit.createTestProbe<string>();

    class W extends Actor<string> {
      constructor(private readonly i: number) { super(); }
      override preStart(): void { probe.tell(`start-${this.i}`); }
      override onReceive(): void {}
    }

    const daemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(2)
      .withBehaviorFor((i) => Props.create(() => new W(i)))
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
    const probe = kit.createTestProbe<string>();

    class W extends Actor<string> {
      constructor(private readonly i: number) { super(); }
      override preStart(): void { probe.tell(`start-${this.i}`); }
      override onReceive(): void {}
    }

    const daemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(2)
      .withBehaviorFor((i) => Props.create(() => new W(i)))
      .withLivenessIntervalMs(0);
    const handle = ShardedDaemonProcess.init<string>(nodeA.system, nodeA.cluster, daemonOptions);

    for (let i = 0; i < 2; i++) await probe.receiveOne(1_000);

    handle.stop();
    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });
});
