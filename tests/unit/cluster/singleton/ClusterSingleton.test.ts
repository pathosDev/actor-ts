import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterSingletonId } from '../../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import { TestKit } from '../../../../src/testkit/TestKit.js';
import type { ActorRef } from '../../../../src/ActorRef.js';

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
  const kit = TestKit.create(systemName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(kit.system, {
    host, port, seeds,
    transport: new InMemoryTransport(new NodeAddress(systemName, host, port)),
    failureDetector: { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 },
    gossipIntervalMs: 80,
  });
  return { system: kit.system, cluster, kit };
}

async function stop(n: Node): Promise<void> {
  await n.cluster.leave();
  await n.system.terminate();
}

describe('ClusterSingleton — single node', () => {
  test('singleton is hosted on the sole leader', async () => {
    const a = await startNode('sng-1', 'h', 52001);
    const kit = a.kit;
    const probe = kit.createTestProbe<string>();

    class Echo extends Actor<string> {
      override onReceive(m: string): void { probe.tell(`got:${m}`); }
    }

    const handle = kit.system.extension(ClusterSingletonId).start(a.cluster, {
      typeName: 'echo',
      props: Props.create(() => new Echo()),
    });
    // Wait until the proxy can locate the leader.
    await waitFor(() => a.cluster.leader().nonEmpty);

    handle.proxy.tell('ping');
    expect(await probe.expectMsg('got:ping', 500)).toBe('got:ping');

    handle.stop();
    await stop(a);
  });

  test('messages sent before a leader exists get buffered and delivered later', async () => {
    // We can't truly predate the leader on a single-node cluster (self goes
    // Up immediately when it is the only seed), so we simulate buffering by
    // spawning the proxy during construction and having it drain once the
    // LeaderChanged event is observed.  The test asserts that no message is
    // lost across the observer window.
    const a = await startNode('sng-buf', 'h', 52002);
    const kit = a.kit;
    const probe = kit.createTestProbe<string>();

    class Echo extends Actor<string> {
      override onReceive(m: string): void { probe.tell(m); }
    }
    const handle = kit.system.extension(ClusterSingletonId).start(a.cluster, {
      typeName: 'echo2',
      props: Props.create(() => new Echo()),
    });

    for (const msg of ['a', 'b', 'c']) handle.proxy.tell(msg);
    expect(await probe.expectMsg('a', 500)).toBe('a');
    expect(await probe.expectMsg('b', 500)).toBe('b');
    expect(await probe.expectMsg('c', 500)).toBe('c');

    handle.stop();
    await stop(a);
  });
});

describe('ClusterSingleton — two nodes', () => {
  test('only the leader hosts the singleton; follower forwards through proxy', async () => {
    const a = await startNode('sng-2a', 'h', 52101);
    const b = await startNode('sng-2a', 'h', 52102, ['sng-2a@h:52101']);
    await waitFor(() =>
      a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2,
    );

    const received: Array<{ where: 'a' | 'b'; msg: string }> = [];

    class Echo extends Actor<string> {
      constructor(private readonly where: 'a' | 'b') { super(); }
      override onReceive(m: string): void { received.push({ where: this.where, msg: m }); }
    }

    const aHandle = a.system.extension(ClusterSingletonId).start(a.cluster, {
      typeName: 'echo',
      props: Props.create(() => new Echo('a')),
    });
    const bHandle = b.system.extension(ClusterSingletonId).start(b.cluster, {
      typeName: 'echo',
      props: Props.create(() => new Echo('b')),
    });

    await sleep(150);

    // Whichever node is leader is the one actually running the child.
    const leaderOpt = a.cluster.leader();
    if (leaderOpt.isNone()) throw new Error('no leader elected');
    const leaderAddr = leaderOpt.value.address;
    const hostedOnA = leaderAddr.equals(a.cluster.selfAddress);

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
    await stop(a); await stop(b);
  });

  test('leader failover moves the singleton to the surviving node', async () => {
    const a = await startNode('sng-fo', 'h', 52201);
    const b = await startNode('sng-fo', 'h', 52202, ['sng-fo@h:52201']);
    await waitFor(() => a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2);

    const hosts: string[] = [];
    class Marker extends Actor<string> {
      constructor(private readonly where: string) { super(); }
      override preStart(): void { hosts.push(this.where); }
      override onReceive(): void {}
    }

    a.system.extension(ClusterSingletonId).start(a.cluster, {
      typeName: 'marker',
      props: Props.create(() => new Marker('a')),
    });
    b.system.extension(ClusterSingletonId).start(b.cluster, {
      typeName: 'marker',
      props: Props.create(() => new Marker('b')),
    });

    // Wait for one of the nodes to host the marker child (preStart fires).
    await waitFor(() => hosts.length >= 1, 2_000);
    const firstHost = hosts[0]!;

    // Tear down the current leader — the other node should take over.
    const leaderIsA = a.cluster.leader().exists((l) => l.address.equals(a.cluster.selfAddress));
    if (leaderIsA) await stop(a); else await stop(b);

    const surviving = leaderIsA ? b : a;
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
    const b = await startNode(SYS, 'h', 52402);
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
    const origWarn = b.system.log.warn.bind(b.system.log);
    b.system.log.warn = ((msg: string, err?: unknown): void => {
      if (typeof msg === 'string' && msg.includes('listener threw')) {
        errors.push(err as Error);
      }
      origWarn(msg, err);
    }) as typeof b.system.log.warn;

    b.system.extension(ClusterSingletonId).start(b.cluster, {
      typeName: 'marker',
      props: Props.create(() => new Marker('b')),
    });
    await waitFor(() => hosts.includes('b'), 1_500);
    expect(hosts).toEqual(['b']);

    // Bring up A (lower address) — leadership flips to A, B's
    // singleton manager calls stopChild (Marker's postStop sleeps
    // 200 ms before the cell finishes terminating).
    const a = await startNode(SYS, 'h', 52401, [`${SYS}@h:52402`]);
    a.system.extension(ClusterSingletonId).start(a.cluster, {
      typeName: 'marker',
      props: Props.create(() => new Marker('a')),
    });
    await waitFor(() =>
      a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2,
      2_000,
    );
    await waitFor(() => hosts.includes('a'), 2_000);

    // Stop A immediately — its leave message reaches B while B's
    // previous Marker cell is still mid-`postStop`.  B's reconcile
    // fires from `handleLeave`'s synchronous emit chain.  Pre-fix,
    // this is where `spawn` threw "name not unique"; with the fix,
    // the spawn waits for the `Terminated` message and then runs.
    await stop(a);
    await waitFor(
      () => hosts.filter(h => h === 'b').length >= 2,
      3_000,
    );
    expect(errors).toEqual([]);
    expect(hosts.filter(h => h === 'b').length).toBeGreaterThanOrEqual(2);

    await stop(b);
  });
});

describe('ClusterSingleton — role filter', () => {
  test('only role-tagged nodes host the singleton', async () => {
    // Both nodes are in the same cluster; only node A carries the role 'worker'.
    const a = await startNodeWithRole('sng-role', 'h', 52301, [], ['worker']);
    const b = await startNodeWithRole('sng-role', 'h', 52302, ['sng-role@h:52301'], []);
    await waitFor(() => a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2);

    const hosts: string[] = [];
    class Marker extends Actor<string> {
      constructor(private readonly where: string) { super(); }
      override preStart(): void { hosts.push(this.where); }
      override onReceive(): void {}
    }

    a.system.extension(ClusterSingletonId).start(a.cluster, {
      typeName: 'only-worker', role: 'worker',
      props: Props.create(() => new Marker('a')),
    });
    b.system.extension(ClusterSingletonId).start(b.cluster, {
      typeName: 'only-worker', role: 'worker',
      props: Props.create(() => new Marker('b')),
    });

    // Allow time: if the leader is B (no role), it shouldn't spawn; wait a
    // long beat to confirm no unwanted host appears.
    await sleep(300);

    // The singleton must only exist on node A (the role-tagged one).
    expect(hosts).toEqual(['a']);

    void _unusedRef;
    await stop(a); await stop(b);
  });
});

async function startNodeWithRole(systemName: string, host: string, port: number, seeds: string[], roles: string[]): Promise<Node> {
  const kit = TestKit.create(systemName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const cluster = await Cluster.join(kit.system, {
    host, port, seeds, roles,
    transport: new InMemoryTransport(new NodeAddress(systemName, host, port)),
    failureDetector: { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 },
    gossipIntervalMs: 80,
  });
  return { system: kit.system, cluster, kit };
}

let _unusedRef: ActorRef | undefined;
