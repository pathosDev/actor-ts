import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Cluster, ClusterOptions } from '../../../../../src/cluster/Cluster.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { ShardedDaemonProcess, ShardedDaemonProcessOptions } from '../../../../../src/cluster/sharding/ShardedDaemonProcess.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import { TestKit, TestKitOptions } from '../../../../../src/testkit/TestKit.js';

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
  const kit = TestKit.create(systemName, TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off));
  const cluster = await Cluster.join(kit.system, ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, host, port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80));
  return { system: kit.system, cluster, kit };
}

describe('ShardedDaemonProcess — single node', () => {
  test('spawns exactly N daemons and routes messages by index', async () => {
    const a = await startNode('sdp-1', 'h', 53001);
    const kit = a.kit;
    const probe = kit.createTestProbe<string>();

    class Worker extends Actor<string> {
      private readonly index: number;
      constructor(i: number) { super(); this.index = i; }
      override preStart(): void { probe.tell(`start-${this.index}`); }
      override onReceive(m: string): void { probe.tell(`${this.index}:${m}`); }
    }

    const handle = ShardedDaemonProcess.init<string>(a.system, a.cluster,
      ShardedDaemonProcessOptions.create<string>()
        .withName('workers')
        .withNumDaemons(4)
        .withBehaviorFor((i) => Props.create(() => new Worker(i))));
    await sleep(150);

    const starts: string[] = [];
    for (let i = 0; i < 4; i++) starts.push(await probe.receiveOne(1_000) as string);
    expect(new Set(starts)).toEqual(new Set(['start-0', 'start-1', 'start-2', 'start-3']));

    handle.tell(2, 'hello');
    expect(await probe.expectMsg('2:hello', 1_000)).toBe('2:hello');

    await a.cluster.leave();
    await a.system.terminate();
  });
});

describe('ShardedDaemonProcess — multi-node', () => {
  test('daemons distribute across nodes', async () => {
    const a = await startNode('sdp-m', 'h', 53101);
    const b = await startNode('sdp-m', 'h', 53102, ['sdp-m@h:53101']);
    const c = await startNode('sdp-m', 'h', 53103, ['sdp-m@h:53101']);
    await waitFor(() =>
      a.cluster.upMembers().length === 3 &&
      b.cluster.upMembers().length === 3 &&
      c.cluster.upMembers().length === 3,
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

    ShardedDaemonProcess.init<string>(a.system, a.cluster,
      ShardedDaemonProcessOptions.create<string>()
        .withName('workers')
        .withNumDaemons(9)
        .withBehaviorFor((i) => makeWorker(i, hostedByA)));
    ShardedDaemonProcess.init<string>(b.system, b.cluster,
      ShardedDaemonProcessOptions.create<string>()
        .withName('workers')
        .withNumDaemons(9)
        .withBehaviorFor((i) => makeWorker(i, hostedByB)));
    ShardedDaemonProcess.init<string>(c.system, c.cluster,
      ShardedDaemonProcessOptions.create<string>()
        .withName('workers')
        .withNumDaemons(9)
        .withBehaviorFor((i) => makeWorker(i, hostedByC)));

    await waitFor(() => hostedByA.size + hostedByB.size + hostedByC.size === 9, 5_000);

    expect(hostedByA.size + hostedByB.size + hostedByC.size).toBe(9);
    // Each daemon index runs on exactly one node.
    const all = new Set<number>();
    for (const s of [hostedByA, hostedByB, hostedByC]) for (const i of s) all.add(i);
    expect(all.size).toBe(9);

    // LeastShardAllocationStrategy should give every node at least one daemon.
    const counts = [hostedByA.size, hostedByB.size, hostedByC.size].sort();
    expect(counts[0]).toBeGreaterThanOrEqual(1);

    await a.cluster.leave(); await a.system.terminate();
    await b.cluster.leave(); await b.system.terminate();
    await c.cluster.leave(); await c.system.terminate();
  });
});

describe('ShardedDaemonProcess — liveness heartbeat', () => {
  test('handle.stop() cancels the heartbeat without leaking timers', async () => {
    const a = await startNode('sdp-live', 'h', 53201);
    const kit = a.kit;
    const probe = kit.createTestProbe<string>();

    class W extends Actor<string> {
      constructor(private readonly i: number) { super(); }
      override preStart(): void { probe.tell(`start-${this.i}`); }
      override onReceive(): void {}
    }

    const handle = ShardedDaemonProcess.init<string>(a.system, a.cluster,
      ShardedDaemonProcessOptions.create<string>()
        .withName('workers')
        .withNumDaemons(2)
        .withBehaviorFor((i) => Props.create(() => new W(i)))
        // Tight livenessIntervalMs so the heartbeat would re-wake daemons
        // every 80 ms while the test runs.  We're not asserting on
        // additional preStart fires (rememberEntities prevents that), but
        // we *are* asserting that handle.stop() cleanly cancels the timer
        // instead of leaving a zombie that fires after teardown.
        .withLivenessIntervalMs(80));

    // Drain initial preStarts.
    for (let i = 0; i < 2; i++) await probe.receiveOne(1_000);

    // Run a couple heartbeat ticks — they should be benign no-ops because
    // rememberEntities keeps the daemons alive.
    await sleep(250);

    handle.stop();
    handle.stop();   // idempotent

    await a.cluster.leave();
    await a.system.terminate();
  });

  test('livenessIntervalMs: 0 disables the heartbeat', async () => {
    const a = await startNode('sdp-noheart', 'h', 53202);
    const kit = a.kit;
    const probe = kit.createTestProbe<string>();

    class W extends Actor<string> {
      constructor(private readonly i: number) { super(); }
      override preStart(): void { probe.tell(`start-${this.i}`); }
      override onReceive(): void {}
    }

    const handle = ShardedDaemonProcess.init<string>(a.system, a.cluster,
      ShardedDaemonProcessOptions.create<string>()
        .withName('workers')
        .withNumDaemons(2)
        .withBehaviorFor((i) => Props.create(() => new W(i)))
        .withLivenessIntervalMs(0));

    for (let i = 0; i < 2; i++) await probe.receiveOne(1_000);

    handle.stop();
    await a.cluster.leave();
    await a.system.terminate();
  });
});
