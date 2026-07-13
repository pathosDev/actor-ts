import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { ClusterSingletonId, StartSingletonOptions } from '../../../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 3_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface Node {
  system: ActorSystem;
  cluster: Cluster;
  kit: TestKit;
}

async function startNode(systemName: string, host: string, port: number, seeds: string[] = []): Promise<Node> {
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

async function stop(n: Node): Promise<void> {
  await n.cluster.leave();
  await n.system.terminate();
}

describe('ClusterSingleton — single node', () => {
  test('singleton is hosted on the sole leader', async () => {
    const nodeA = await startNode('sng-1', 'h', 52001);
    const kit = nodeA.kit;
    const probe = kit.createTestProbe<string>();

    class Echo extends Actor<string> {
      override onReceive(m: string): void { probe.tell(`got:${m}`); }
    }

    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withProps(Props.create(() => new Echo()));
    const handle = kit.system.extension(ClusterSingletonId).start(nodeA.cluster, singletonOptions);
    // Wait until the proxy can locate the leader.
    await waitFor(() => nodeA.cluster.leader().nonEmpty);

    handle.proxy.tell('ping');
    expect(await probe.expectMsg('got:ping', 500)).toBe('got:ping');

    handle.stop();
    await stop(nodeA);
  });

  test('messages sent before a leader exists get buffered and delivered later', async () => {
    // We can't truly predate the leader on a single-node cluster (self goes
    // Up immediately when it is the only seed), so we simulate buffering by
    // spawning the proxy during construction and having it drain once the
    // LeaderChanged event is observed.  The test asserts that no message is
    // lost across the observer window.
    const nodeA = await startNode('sng-buf', 'h', 52002);
    const kit = nodeA.kit;
    const probe = kit.createTestProbe<string>();

    class Echo extends Actor<string> {
      override onReceive(m: string): void { probe.tell(m); }
    }
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo2')
      .withProps(Props.create(() => new Echo()));
    const handle = kit.system.extension(ClusterSingletonId).start(nodeA.cluster, singletonOptions);

    for (const msg of ['a', 'b', 'c']) handle.proxy.tell(msg);
    expect(await probe.expectMsg('a', 500)).toBe('a');
    expect(await probe.expectMsg('b', 500)).toBe('b');
    expect(await probe.expectMsg('c', 500)).toBe('c');

    handle.stop();
    await stop(nodeA);
  });
});

describe('ClusterSingleton — two nodes', () => {
  test('only the leader hosts the singleton; follower forwards through proxy', async () => {
    const nodeA = await startNode('sng-2a', 'h', 52101);
    const nodeB = await startNode('sng-2a', 'h', 52102, ['sng-2a@h:52101']);
    await waitFor(() =>
      nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
    );

    const received: Array<{ where: 'a' | 'b'; msg: string }> = [];

    class Echo extends Actor<string> {
      constructor(private readonly where: 'a' | 'b') { super(); }
      override onReceive(m: string): void { received.push({ where: this.where, msg: m }); }
    }

    const aSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withProps(Props.create(() => new Echo('a')));
    const aHandle = nodeA.system.extension(ClusterSingletonId).start(nodeA.cluster, aSingletonOptions);
    const bSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withProps(Props.create(() => new Echo('b')));
    const bHandle = nodeB.system.extension(ClusterSingletonId).start(nodeB.cluster, bSingletonOptions);

    await sleep(150);

    // Whichever node is leader is the one actually running the child.
    const leaderOpt = nodeA.cluster.leader();
    if (leaderOpt.isNone()) throw new Error('no leader elected');
    const leaderAddr = leaderOpt.value.address;
    const hostedOnA = leaderAddr.equals(nodeA.cluster.selfAddress);

    // Tell via the follower's proxy — it must arrive at the leader's child.
    (hostedOnA ? bHandle.proxy : aHandle.proxy).tell('via-follower');
    await waitFor(() => received.some(r => r.msg === 'via-follower'), 1_500);

    // Tell via the leader's proxy — arrives at the same child.
    (hostedOnA ? aHandle.proxy : bHandle.proxy).tell('via-leader');
    await waitFor(() => received.some(r => r.msg === 'via-leader'), 1_500);

    // Both messages must have been received by the same node (the leader).
    const hosts = new Set(received.map(r => r.where));
    expect(hosts.size).toBe(1);
    expect(hosts.has(hostedOnA ? 'a' : 'b')).toBe(true);

    aHandle.stop(); bHandle.stop();
    await stop(nodeA); await stop(nodeB);
  });

  test('leader failover moves the singleton to the surviving node', async () => {
    const nodeA = await startNode('sng-fo', 'h', 52201);
    const nodeB = await startNode('sng-fo', 'h', 52202, ['sng-fo@h:52201']);
    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2);

    const hosts: string[] = [];
    class Marker extends Actor<string> {
      constructor(private readonly where: string) { super(); }
      override preStart(): void { hosts.push(this.where); }
      override onReceive(): void {}
    }

    const aSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('marker')
      .withProps(Props.create(() => new Marker('a')));
    nodeA.system.extension(ClusterSingletonId).start(nodeA.cluster, aSingletonOptions);
    const bSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('marker')
      .withProps(Props.create(() => new Marker('b')));
    nodeB.system.extension(ClusterSingletonId).start(nodeB.cluster, bSingletonOptions);

    // Wait for one of the nodes to host the marker child (preStart fires).
    await waitFor(() => hosts.length >= 1, 2_000);
    const firstHost = hosts[0]!;

    // Tear down the current leader — the other node should take over.
    const leaderIsA = nodeA.cluster.leader().exists((l) => l.address.equals(nodeA.cluster.selfAddress));
    if (leaderIsA) await stop(nodeA); else await stop(nodeB);

    const surviving = leaderIsA ? nodeB : nodeA;
    const expectedNextHost = firstHost === 'a' ? 'b' : 'a';
    await waitFor(() => hosts.includes(expectedNextHost), 3_000);
    expect(hosts).toContain(expectedNextHost);

    await stop(surviving);
  });

  test('leader-flap re-spawn waits for the previous child to terminate', async () => {
    // Regression: when a node briefly hosts the singleton, then loses
    // leadership (child stopping), then reclaims leadership before the
    // child's cell has been GC'd from the parent's children map,
    // `spawn` used to throw "Child name 'X' is not unique".  The
    // fix watches the child and defers the next `spawn()` until the
    // `Terminated` system message arrives.  This test forces that
    // flap by starting the higher-addressed node first (so it
    // self-elects as sole-leader and spawns), then introducing a
    // lower-addressed node (which takes leadership), then stopping
    // the lower-addressed node so leadership returns to the original.
    //
    // The Marker's `postStop` deliberately takes 200 ms so the test
    // reliably hits the bug pre-fix: the second `reconcileSync` on
    // B fires from `handleLeave`'s synchronous emit chain *before*
    // B's previous child cell has finished terminating, so the
    // pre-fix `spawn` would throw "name not unique".
    const SYS = 'sng-flap';
    // Start B first (higher address, will be sole leader briefly).
    const nodeB = await startNode(SYS, 'h', 52402);
    const hosts: string[] = [];
    const errors: Error[] = [];
    class Marker extends Actor<string> {
      constructor(private readonly where: string) { super(); }
      override preStart(): void { hosts.push(this.where); }
      override async postStop(): Promise<void> {
        // Slow shutdown — keeps the cell in the parent's _children
        // map well past the reconcile that fires when the other node
        // leaves, so the spawn-vs-stop race is deterministic.
        await Bun.sleep(200);
      }
      override onReceive(): void {}
    }
    // Capture any "name not unique" exception thrown inside the
    // singleton manager's listener — `cluster.emit` swallows
    // listener throws via `try/catch` + `log.warn`, so we route it
    // through the system's logger to detect.
    const origWarn = nodeB.system.log.warn.bind(nodeB.system.log);
    nodeB.system.log.warn = ((msg: string, err?: unknown): void => {
      if (typeof msg === 'string' && msg.includes('listener threw')) {
        errors.push(err as Error);
      }
      origWarn(msg, err);
    }) as typeof nodeB.system.log.warn;

    const bSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('marker')
      .withProps(Props.create(() => new Marker('b')));
    nodeB.system.extension(ClusterSingletonId).start(nodeB.cluster, bSingletonOptions);
    await waitFor(() => hosts.includes('b'), 1_500);
    expect(hosts).toEqual(['b']);

    // Bring up A (lower address) — leadership flips to A, B's
    // singleton manager calls stopChild (Marker's postStop sleeps
    // 200 ms before the cell finishes terminating).
    const nodeA = await startNode(SYS, 'h', 52401, [`${SYS}@h:52402`]);
    const aSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('marker')
      .withProps(Props.create(() => new Marker('a')));
    nodeA.system.extension(ClusterSingletonId).start(nodeA.cluster, aSingletonOptions);
    await waitFor(() =>
      nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2,
      2_000,
    );
    await waitFor(() => hosts.includes('a'), 2_000);

    // Stop A immediately — its leave message reaches B while B's
    // previous Marker cell is still mid-`postStop`.  B's reconcile
    // fires from `handleLeave`'s synchronous emit chain.  Pre-fix,
    // this is where `spawn` threw "name not unique"; with the fix,
    // the spawn waits for the `Terminated` message and then runs.
    await stop(nodeA);
    await waitFor(
      () => hosts.filter(h => h === 'b').length >= 2,
      3_000,
    );
    expect(errors).toEqual([]);
    expect(hosts.filter(h => h === 'b').length).toBeGreaterThanOrEqual(2);

    await stop(nodeB);
  });
});

describe('ClusterSingleton — role filter', () => {
  test('only role-tagged nodes host the singleton', async () => {
    // Both nodes are in the same cluster; only node A carries the role 'worker'.
    const nodeA = await startNodeWithRole('sng-role', 'h', 52301, [], ['worker']);
    const nodeB = await startNodeWithRole('sng-role', 'h', 52302, ['sng-role@h:52301'], []);
    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2);

    const hosts: string[] = [];
    class Marker extends Actor<string> {
      constructor(private readonly where: string) { super(); }
      override preStart(): void { hosts.push(this.where); }
      override onReceive(): void {}
    }

    const aSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('only-worker')
      .withRole('worker')
      .withProps(Props.create(() => new Marker('a')));
    nodeA.system.extension(ClusterSingletonId).start(nodeA.cluster, aSingletonOptions);
    const bSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('only-worker')
      .withRole('worker')
      .withProps(Props.create(() => new Marker('b')));
    nodeB.system.extension(ClusterSingletonId).start(nodeB.cluster, bSingletonOptions);

    // Allow time: if the leader is B (no role), it shouldn't spawn; wait a
    // long beat to confirm no unwanted host appears.
    await sleep(300);

    // The singleton must only exist on node A (the role-tagged one).
    expect(hosts).toEqual(['a']);

    void _unusedRef;
    await stop(nodeA); await stop(nodeB);
  });
});

async function startNodeWithRole(systemName: string, host: string, port: number, seeds: string[], roles: string[]): Promise<Node> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(systemName, kitOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(host)
    .withPort(port)
    .withSeeds(seeds)
    .withRoles(roles)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, host, port)))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { system: kit.system, cluster, kit };
}

let _unusedRef: ActorRef | undefined;
