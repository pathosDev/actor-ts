import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import {
  ClusterSingletonProxy,
  SingletonKey,
  StartSingletonOptions,
} from '../../../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../../../util/AwaitCondition.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(pred: () => boolean, timeoutMs = 3_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  if (!pred()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  kit: TestKit;
};

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
    const probe = kit.createTestProbe();

    class Echo extends Actor<string> {
      override onReceive(m: string): void { probe.tell(`got:${m}`); }
    }

    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(Echo);
    const singletonRef = nodeA.cluster.singleton.start(singletonOptions);
    // Wait until the proxy can locate the leader.
    await waitFor(() => nodeA.cluster.leader().nonEmpty);

    singletonRef.tell('ping');
    expect(await probe.expectMessage('got:ping', 500)).toBe('got:ping');

    nodeA.cluster.singleton.stop('echo');
    await stop(nodeA);
  });

  test('stop() prunes the registry so the singleton can be started again', async () => {
    // Regression: the registry was populated on start and never emptied, so
    // `stop()` left a dead entry behind and every later `start()` short-
    // circuited to it — returning a proxy that silently dropped everything.
    const nodeA = await startNode('sng-restart', 'h', 52003);
    const kit = nodeA.kit;
    const probe = kit.createTestProbe();

    class Echo extends Actor<string> {
      override onReceive(m: string): void { probe.tell(`got:${m}`); }
    }
    const options = (): StartSingletonOptions<string> => StartSingletonOptions.create<string>()
      .withTypeName('echo3')
      .withActor(Echo);

    const first = nodeA.cluster.singleton.start(options());
    await waitFor(() => nodeA.cluster.leader().nonEmpty);
    first.tell('one');
    expect(await probe.expectMessage('got:one', 500)).toBe('got:one');

    nodeA.cluster.singleton.stop('echo3');
    expect(nodeA.cluster.singleton.isStarted('echo3')).toBe(false);
    expect(nodeA.cluster.singleton.managerFor('echo3').isNone()).toBe(true);

    // Stopping is asynchronous — the manager's cell keeps its name until
    // termination settles, so a restart in the same turn cannot succeed.  It
    // has to say why rather than surfacing the raw "name is not unique".
    expect(() => nodeA.cluster.singleton.start(options()))
      .toThrow(/is still stopping on this node/);

    await waitFor(() => {
      try { nodeA.cluster.singleton.start(options()); return true; } catch { return false; }
    }, 2_000);

    const second = nodeA.cluster.singleton.start(options());
    expect(nodeA.cluster.singleton.isStarted('echo3')).toBe(true);
    second.tell('two');
    expect(await probe.expectMessage('got:two', 1_000)).toBe('got:two');

    nodeA.cluster.singleton.stop('echo3');
    await stop(nodeA);
  });

  test('a manager that dies on its own drops out of the registry', async () => {
    // `stop()` is not the only way a manager goes away — supervision and
    // system shutdown do too, and neither routes through the facade.  The
    // registry is pruned from the manager's own postStop so it cannot keep
    // claiming a dead actor is started.
    const nodeA = await startNode('sng-liveness', 'h', 52004);

    class Idle extends Actor<string> {
      override onReceive(): void {}
    }
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('idle')
      .withActor(Idle);
    nodeA.cluster.singleton.start(singletonOptions);
    expect(nodeA.cluster.singleton.isStarted('idle')).toBe(true);

    // Kill the manager behind the facade's back.
    const manager = nodeA.cluster.singleton.managerFor('idle');
    if (manager.isNone()) throw new Error('no manager registered');
    manager.value.stop();

    await waitFor(() => !nodeA.cluster.singleton.isStarted('idle'), 2_000);
    expect(nodeA.cluster.singleton.managerFor('idle').isNone()).toBe(true);

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
    const probe = kit.createTestProbe();

    class Echo extends Actor<string> {
      override onReceive(m: string): void { probe.tell(m); }
    }
    const singletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo2')
      .withActor(Echo);
    const singletonRef = nodeA.cluster.singleton.start(singletonOptions);

    for (const message of ['a', 'b', 'c']) singletonRef.tell(message);
    expect(await probe.expectMessage('a', 500)).toBe('a');
    expect(await probe.expectMessage('b', 500)).toBe('b');
    expect(await probe.expectMessage('c', 500)).toBe('c');

    nodeA.cluster.singleton.stop('echo2');
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

    const received: Array<{ where: 'a' | 'b'; message: string }> = [];

    class Echo extends Actor<string> {
      constructor(private readonly where: 'a' | 'b') { super(); }
      override onReceive(m: string): void { received.push({ where: this.where, message: m }); }
    }

    const aSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(() => new Echo('a'));
    const aRef = nodeA.cluster.singleton.start(aSingletonOptions);
    const bSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('echo')
      .withActor(() => new Echo('b'));
    const bRef = nodeB.cluster.singleton.start(bSingletonOptions);

    // Everything below reads `leader()`, so wait for both nodes to have one
    // rather than betting 150 ms on the election (#418).
    await awaitCondition(
      () => nodeA.cluster.leader().nonEmpty && nodeB.cluster.leader().nonEmpty,
      { timeoutMs: 4_000, intervalMs: 20, label: 'both nodes elected a leader' },
    );

    // Whichever node is leader is the one actually running the child.
    const leaderOption = nodeA.cluster.leader();
    if (leaderOption.isNone()) throw new Error('no leader elected');
    const leaderAddr = leaderOption.value.address;
    const hostedOnA = leaderAddr.equals(nodeA.cluster.selfAddress);

    // Tell via the follower's proxy — it must arrive at the leader's child.
    (hostedOnA ? bRef : aRef).tell('via-follower');
    await waitFor(() => received.some(r => r.message === 'via-follower'), 1_500);

    // Tell via the leader's proxy — arrives at the same child.
    (hostedOnA ? aRef : bRef).tell('via-leader');
    await waitFor(() => received.some(r => r.message === 'via-leader'), 1_500);

    // Both messages must have been received by the same node (the leader).
    const hosts = new Set(received.map(r => r.where));
    expect(hosts.size).toBe(1);
    expect(hosts.has(hostedOnA ? 'a' : 'b')).toBe(true);

    nodeA.cluster.singleton.stop('echo'); nodeB.cluster.singleton.stop('echo');
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
      .withActor(() => new Marker('a'));
    nodeA.cluster.singleton.start(aSingletonOptions);
    const bSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('marker')
      .withActor(() => new Marker('b'));
    nodeB.cluster.singleton.start(bSingletonOptions);

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
    nodeB.system.log.warn = ((message: string, err?: unknown): void => {
      if (typeof message === 'string' && message.includes('listener threw')) {
        errors.push(err as Error);
      }
      origWarn(message, err);
    }) as typeof nodeB.system.log.warn;

    const bSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('marker')
      .withActor(() => new Marker('b'));
    nodeB.cluster.singleton.start(bSingletonOptions);
    await waitFor(() => hosts.includes('b'), 1_500);
    expect(hosts).toEqual(['b']);

    // Bring up A (lower address) — leadership flips to A, B's
    // singleton manager calls stopChild (Marker's postStop sleeps
    // 200 ms before the cell finishes terminating).
    const nodeA = await startNode(SYS, 'h', 52401, [`${SYS}@h:52402`]);
    const aSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('marker')
      .withActor(() => new Marker('a'));
    nodeA.cluster.singleton.start(aSingletonOptions);
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
      .withActor(() => new Marker('a'));
    nodeA.cluster.singleton.start(aSingletonOptions);
    const bSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('only-worker')
      .withRole('worker')
      .withActor(() => new Marker('b'));
    nodeB.cluster.singleton.start(bSingletonOptions);

    // Two claims here, and only one of them can be polled.  "A hosts it" is
    // positive, so wait for it — the 300 ms budget was the flake, since a
    // loaded run can miss the election entirely and then read an empty array.
    await awaitCondition(() => hosts.includes('a'), {
      timeoutMs: 4_000, intervalMs: 20, label: 'the role-tagged node started hosting',
    });
    // "B does not host it" is the negative half; that one genuinely needs a
    // window in which nothing else appears.
    await sleep(150);

    // The singleton must only exist on node A (the role-tagged one).
    expect(hosts).toEqual(['a']);

    await stop(nodeA); await stop(nodeB);
  });

  /**
   * #524 — hosting used to require leader **and** role, so a role the leader
   * did not carry left the singleton hosted *nowhere*: the leader's manager
   * declined on the role, every other manager declined on not being leader.
   *
   * The test above never caught it because its role sits on the lowest-
   * addressed node, which is the leader anyway.  Here the roles are the other
   * way round: node A sorts first and leads, node B carries the role.
   */
  test('the first member carrying the role hosts it, even when the leader does not', async () => {
    const nodeA = await startNodeWithRole('sng-role-2', 'h', 52311, [], []);
    const nodeB = await startNodeWithRole('sng-role-2', 'h', 52312, ['sng-role-2@h:52311'], ['worker']);
    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2);
    // The premise: the leader is the node *without* the role.
    expect(nodeA.cluster.isLeader()).toBe(true);

    const hosts: string[] = [];
    const received: string[] = [];
    class Marker extends Actor<string> {
      constructor(private readonly where: string) { super(); }
      override preStart(): void { hosts.push(this.where); }
      override onReceive(m: string): void { received.push(`${this.where}:${m}`); }
    }

    const aSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('needs-worker')
      .withRole('worker')
      .withActor(() => new Marker('a'));
    const fromLeader = nodeA.cluster.singleton.start(aSingletonOptions);
    const bSingletonOptions = StartSingletonOptions.create<string>()
      .withTypeName('needs-worker')
      .withRole('worker')
      .withActor(() => new Marker('b'));
    nodeB.cluster.singleton.start(bSingletonOptions);

    await waitFor(() => hosts.length > 0);
    expect(hosts).toEqual(['b']);

    // And the proxy has to agree with that election: a tell from the leader —
    // which hosts nothing — must still cross to node B.
    fromLeader.tell('ping');
    await waitFor(() => received.length > 0);
    expect(received).toEqual(['b:ping']);

    await stop(nodeA); await stop(nodeB);
  });

  /**
   * A node that only calls `ref()` has no options object to read the role
   * from — it has the key.  So the key carries it, and both sides resolve the
   * same host without the ref-only node being told anything extra.
   */
  test('a role declared on the key routes a ref()-only node to the same host', async () => {
    const nodeA = await startNodeWithRole('sng-role-3', 'h', 52321, [], []);
    const nodeB = await startNodeWithRole('sng-role-3', 'h', 52322, ['sng-role-3@h:52321'], ['worker']);
    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2);

    const received: string[] = [];
    class Ingress extends Actor<string> {
      static readonly singleton = SingletonKey.of<string>('keyed-ingress', 'worker');
      override onReceive(m: string): void { received.push(m); }
    }

    // Only node B hosts.  Node A never starts it — it just takes a ref.
    nodeB.cluster.singleton.start(Ingress);
    const fromA = nodeA.cluster.singleton.ref(Ingress);

    fromA.tell('hello');
    await waitFor(() => received.length > 0);
    expect(received).toEqual(['hello']);

    await stop(nodeA); await stop(nodeB);
  });
});

/**
 * #526 — the proxy buffers whatever it cannot route yet, and the buffer had no
 * cap.  "No host yet" is normally momentary, but nothing bounds it: unreachable
 * seeds, or a partition where this node sees nobody, keep the cluster there for
 * the length of the outage while the application keeps sending.
 *
 * A role no member carries is the same state, reachable deterministically and
 * without breaking a transport.
 */
describe('ClusterSingleton — proxy buffer bound', () => {
  test('drops to dead letters past bufferSize instead of growing without limit', async () => {
    const node = await startNodeWithRole('sng-buffer', 'h', 52401, [], []);
    try {
      class Never extends Actor<string> {
        override onReceive(): void {}
      }

      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName('unhostable')
        .withRole('role-nobody-carries')
        .withBufferSize(3)
        .withActor(Never);
      const proxy = node.cluster.singleton.start(singletonOptions) as ClusterSingletonProxy<string>;

      for (let index = 0; index < 10; index++) proxy.tell(`m${index}`);

      // Three held, seven dropped — not ten held.
      expect(proxy.hasPending()).toBe(true);
      expect(proxy.droppedCount).toBe(7);
    } finally {
      await stop(node);
    }
  });

  test('keeps dropping while the buffer stays full — the latch is on the log, not the policy', async () => {
    const node = await startNodeWithRole('sng-buffer-2', 'h', 52411, [], []);
    try {
      class Never extends Actor<string> {
        override onReceive(): void {}
      }

      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName('unhostable-2')
        .withRole('role-nobody-carries')
        .withBufferSize(1)
        .withActor(Never);
      const proxy = node.cluster.singleton.start(singletonOptions) as ClusterSingletonProxy<string>;

      proxy.tell('kept');
      proxy.tell('dropped');
      expect(proxy.droppedCount).toBe(1);

      // The warning latches so a hot path cannot flood the log; the dropping
      // itself must not, or the counter would under-report the loss.
      proxy.tell('also-dropped');
      expect(proxy.droppedCount).toBe(2);
    } finally {
      await stop(node);
    }
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
