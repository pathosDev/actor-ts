import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { StartSingletonOptions } from '../../../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';
import type { Lease } from '../../../../../src/coordination/Lease.js';

/**
 * An unexpected child death must not end the singleton cluster-wide (#1175).
 *
 * `handleTerminated` only recognised `pendingStop` — the planned teardown of
 * a handover.  Every other way the child could die fell through without
 * effect: `this.child` kept pointing at the dead ref so routed messages went
 * to dead letters, and nothing revived the singleton until the next
 * `LeaderChanged`, which in a stable cluster may be never.  With a lease it
 * was worse — the manager stayed alive holding and renewing a lease over a
 * dead child, so no other node could take over either.
 */

type PingMessage = { kind: 'ping' };
type DieMessage = { kind: 'die' };

type Command = PingMessage | DieMessage;

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

type Node = { system: ActorSystem; cluster: Cluster; kit: TestKit };

async function startNode(systemName: string, port: number, seeds: string[] = []): Promise<Node> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(systemName, kitOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { system: kit.system, cluster, kit };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave().catch(() => {});
  await node.system.terminate().catch(() => {});
}

/** Counts starts so a respawn is observable, and stops itself on demand. */
let starts = 0;

class SelfStopper extends Actor<Command> {
  override preStart(): void { starts++; }

  override onReceive(message: Command): void {
    if (message.kind === 'die') this.context.stopSelf();
  }
}

/** Minimal in-memory lease, enough to observe acquire/release. */
class RecordingLease implements Lease {
  held = false;
  releases = 0;
  acquires = 0;
  async acquire(): Promise<boolean> { this.held = true; this.acquires++; return true; }
  async release(): Promise<void> { this.held = false; this.releases++; }
  async check(): Promise<boolean> { return this.held; }
  onLost(): () => void { return () => {}; }
}

describe('ClusterSingleton — an unexpected child death (#1175)', () => {
  test('the singleton is re-spawned by default', async () => {
    starts = 0;
    const node = await startNode('sng-restart-default', 52401);

    const singletonOptions = StartSingletonOptions.create<Command>()
      .withTypeName('self-stopper')
      .withActor(SelfStopper);
    const singletonRef = node.cluster.singleton.start(singletonOptions);

    await waitFor(() => node.cluster.leader().nonEmpty);
    await waitFor(() => starts === 1);

    singletonRef.tell({ kind: 'die' });

    // Before the fix this never arrived: the manager saw a `Terminated` it
    // did not recognise and did nothing at all.
    await waitFor(() => starts === 2);
    expect(starts).toBe(2);

    node.cluster.singleton.stop('self-stopper');
    await stopNode(node);
  }, 15_000);

  test('restartOnTermination: false keeps the actor stopped and releases the lease', async () => {
    // The opt-out, for an actor that uses `stopSelf()` as a terminal state.
    // Not re-spawning is the point; releasing the lease is what stops it
    // being an unrecoverable outage, since a held lease over a dead child
    // blocks every other node too.
    starts = 0;
    const lease = new RecordingLease();
    const node = await startNode('sng-restart-off', 52402);

    const singletonOptions = StartSingletonOptions.create<Command>()
      .withTypeName('terminal')
      .withActor(SelfStopper)
      .withLease(lease)
      .withRestartOnTermination(false);
    const singletonRef = node.cluster.singleton.start(singletonOptions);

    await waitFor(() => node.cluster.leader().nonEmpty);
    await waitFor(() => starts === 1);
    await waitFor(() => lease.held);

    singletonRef.tell({ kind: 'die' });

    // The lease is let go, so another node could host.
    await waitFor(() => lease.releases >= 1);
    expect(lease.held).toBe(false);

    // And no respawn happened — comfortably past the restart backoff.
    await sleep(1_500);
    expect(starts).toBe(1);

    node.cluster.singleton.stop('terminal');
    await stopNode(node);
  }, 15_000);

  /**
   * #637 widened the manager's reconcile trigger from `LeaderChanged` alone to
   * every event that can move the host, which put this opt-out squarely in the
   * blast radius: both reconcile paths decide from `want && no child`, and
   * that reads a terminal stop as "never spawned".  Under the old trigger set
   * a stable cluster might simply never fire again and hide it; now any member
   * joining anywhere reconciles, so "do not re-spawn" had to become state
   * rather than an absence of events.
   *
   * The lease is the sharper half of the assertion: a re-acquire would rebuild
   * exactly the "holding a lease over a dead child" state #1175 released it to
   * avoid, and would block every other node from hosting too.
   */
  test('a membership change after a terminal stop does not resurrect the singleton', async () => {
    starts = 0;
    const lease = new RecordingLease();
    const systemName = 'sng-restart-off-membership';
    const nodeA = await startNode(systemName, 52403);

    const singletonOptions = StartSingletonOptions.create<Command>()
      .withTypeName('terminal-membership')
      .withActor(SelfStopper)
      .withLease(lease)
      .withRestartOnTermination(false);
    const singletonRef = nodeA.cluster.singleton.start(singletonOptions);

    await waitFor(() => nodeA.cluster.leader().nonEmpty);
    await waitFor(() => starts === 1);
    await waitFor(() => lease.held);
    const acquiresBefore = lease.acquires;

    singletonRef.tell({ kind: 'die' });
    await waitFor(() => lease.releases >= 1);

    // A second node joins *above* A's address, so A stays the leader and the
    // only new events are membership ones.  Before the latch this drove a
    // reconcile straight back into acquire-and-spawn.
    const nodeB = await startNode(systemName, 52404, [`${systemName}@h:52403`]);
    await waitFor(() => nodeA.cluster.upMembers().length === 2);
    expect(nodeA.cluster.isLeader()).toBe(true);

    // Comfortably past the restart backoff and the lease retry interval.
    await sleep(1_500);
    expect(starts).toBe(1);
    expect(lease.held).toBe(false);
    expect(lease.acquires).toBe(acquiresBefore);

    nodeA.cluster.singleton.stop('terminal-membership');
    await stopNode(nodeB);
    await stopNode(nodeA);
  }, 20_000);
});
