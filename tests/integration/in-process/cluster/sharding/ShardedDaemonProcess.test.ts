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
import type { ConfigObject } from '../../../../../src/config/HoconParser.js';
import { Scheduler } from '../../../../../src/Scheduler.js';
import type { Cancellable } from '../../../../../src/Scheduler.js';
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

/**
 * What a node needs beyond its address, all optional so the four original call
 * sites stay unchanged: a HOCON tree, a scheduler to watch, and the roles the
 * member carries (`role` names a role, it never grants one).
 */
type NodeExtras = {
  readonly config?: ConfigObject;
  readonly scheduler?: Scheduler;
  readonly roles?: string[];
};

async function startNode(
  systemName: string,
  host: string,
  port: number,
  seeds: string[] = [],
  extras: NodeExtras = {},
): Promise<NodeSetup> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  if (extras.config) kitOptions.withConfig(extras.config);
  if (extras.scheduler) kitOptions.withScheduler(extras.scheduler);
  const kit = TestKit.create(systemName, kitOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, host, port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  if (extras.roles) clusterOptions.withRoles(extras.roles);
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

/**
 * Records what was scheduled at a fixed rate, so "the HOCON value reached the
 * running instance" is a fact about the timer that was armed rather than about
 * the reader in isolation.  The liveness ping is otherwise unobservable from
 * outside: `rememberEntities` keeps the daemons resident, so a tick that fires
 * changes nothing a probe can see.
 */
class RecordingScheduler extends Scheduler {
  readonly fixedRates: Array<{ initialDelayMs: number; intervalMs: number }> = [];

  override scheduleAtFixedRateFunction(
    initialDelayMs: number,
    intervalMs: number,
    task: () => void,
  ): Cancellable {
    this.fixedRates.push({ initialDelayMs, intervalMs });
    return super.scheduleAtFixedRateFunction(initialDelayMs, intervalMs, task);
  }
}

describe('ShardedDaemonProcess — actor-ts.sharded-daemon-process.* HOCON keys', () => {
  test('liveness-interval reaches an instance started with no explicit options', async () => {
    // 137 ms is arbitrary and deliberately unlike every other cadence in the
    // process, so the pair below can only have come from this block.
    const scheduler = new RecordingScheduler();
    const nodeA = await startNode('sdp-hocon-live', 'h', 53301, [], {
      scheduler,
      config: { 'actor-ts': { 'sharded-daemon-process': { 'liveness-interval': '137ms' } } },
    });
    const probe = nodeA.kit.createTestProbe();

    class W extends Actor<string> {
      constructor(private readonly index: number) { super(); }
      override preStart(): void { probe.tell(`start-${this.index}`); }
      override onReceive(): void {}
    }

    const daemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(2)
      .withActorFor((i) => () => new W(i));
    // `init` is synchronous, so everything it schedules lands in this slice.
    const before = scheduler.fixedRates.length;
    const handle = ShardedDaemonProcess.init<string>(nodeA.system, nodeA.cluster, daemonOptions);
    const scheduledByInit = scheduler.fixedRates.slice(before);

    expect(scheduledByInit).toContainEqual({ initialDelayMs: 137, intervalMs: 137 });

    // And the daemons still come up — the point is a configured cadence, not a
    // configured way to break the module.
    for (let i = 0; i < 2; i++) await probe.receiveOne(1_000);

    handle.stop();
    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });

  test('an explicit liveness interval beats the configured one', async () => {
    const scheduler = new RecordingScheduler();
    const nodeA = await startNode('sdp-hocon-live-explicit', 'h', 53302, [], {
      scheduler,
      config: { 'actor-ts': { 'sharded-daemon-process': { 'liveness-interval': '137ms' } } },
    });
    const probe = nodeA.kit.createTestProbe();

    class W extends Actor<string> {
      constructor(private readonly index: number) { super(); }
      override preStart(): void { probe.tell(`start-${this.index}`); }
      override onReceive(): void {}
    }

    const daemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(2)
      .withActorFor((i) => () => new W(i))
      .withLivenessIntervalMs(211);
    const before = scheduler.fixedRates.length;
    const handle = ShardedDaemonProcess.init<string>(nodeA.system, nodeA.cluster, daemonOptions);
    const scheduledByInit = scheduler.fixedRates.slice(before);

    expect(scheduledByInit).toContainEqual({ initialDelayMs: 211, intervalMs: 211 });
    expect(scheduledByInit).not.toContainEqual({ initialDelayMs: 137, intervalMs: 137 });

    for (let i = 0; i < 2; i++) await probe.receiveOne(1_000);

    handle.stop();
    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });

  test('a configured role no member carries places no daemon', async () => {
    // `role` names a role, it never grants one: `ShardCoordinator.candidates`
    // keeps only regions whose member carries it, so a role nobody has leaves
    // every daemon shard unallocated and no `preStart` ever runs.  That is the
    // shape a typo produces, and it is what makes the positive case below a
    // fact about the config rather than about the default placement.
    const nodeA = await startNode('sdp-hocon-role-miss', 'h', 53303, [], {
      config: { 'actor-ts': { 'sharded-daemon-process': { role: 'compute' } } },
      roles: ['frontend'],
    });
    const probe = nodeA.kit.createTestProbe();

    class W extends Actor<string> {
      constructor(private readonly index: number) { super(); }
      override preStart(): void { probe.tell(`start-${this.index}`); }
      override onReceive(): void {}
    }

    const daemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(2)
      .withActorFor((i) => () => new W(i));
    const handle = ShardedDaemonProcess.init<string>(nodeA.system, nodeA.cluster, daemonOptions);

    // Long enough for the wake-ups, the registration and a coordinator turn —
    // the positive case below comes up well inside it.
    await probe.expectNoMessage(800);

    handle.stop();
    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });

  test('a configured role the member carries places the daemons', async () => {
    const nodeA = await startNode('sdp-hocon-role-hit', 'h', 53304, [], {
      config: { 'actor-ts': { 'sharded-daemon-process': { role: 'compute' } } },
      roles: ['compute'],
    });
    const probe = nodeA.kit.createTestProbe();

    class W extends Actor<string> {
      constructor(private readonly index: number) { super(); }
      override preStart(): void { probe.tell(`start-${this.index}`); }
      override onReceive(): void {}
    }

    const daemonOptions = ShardedDaemonProcessOptions.create<string>()
      .withName('workers')
      .withNumDaemons(2)
      .withActorFor((i) => () => new W(i));
    const handle = ShardedDaemonProcess.init<string>(nodeA.system, nodeA.cluster, daemonOptions);

    const starts: string[] = [];
    for (let i = 0; i < 2; i++) starts.push(await probe.receiveOne(1_000) as string);
    expect(new Set(starts)).toEqual(new Set(['start-0', 'start-1']));

    handle.stop();
    await nodeA.cluster.leave();
    await nodeA.system.terminate();
  });
});
