import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import type { ActorRef } from '../../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { Cluster } from '../../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../../src/cluster/ClusterOptions.js';
import { LeaderChanged } from '../../../../../src/cluster/ClusterEvents.js';
import { ClusterSingletonProxy, StartSingletonOptions } from '../../../../../src/cluster/singleton/index.js';
import { InMemoryTransport } from '../../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { TestKit } from '../../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../../src/testkit/TestKitOptions.js';

/**
 * #637 — the host of a role-restricted singleton moved without anything the
 * manager or the proxy was listening to.
 *
 * Both sides watched `LeaderChanged` (the manager also `SelfUp` and
 * `MemberRemoved`), but the host is `upMembersWithRole(role)[0]` — the first
 * address-ordered up-member carrying the role.  A role-carrying member joining
 * *below* a role-less leader moves that value and changes no leader, so the
 * event never fired.  The joining node spawned anyway, off its own `SelfUp`;
 * the incumbent was never told to stop.  Steady state was **two live
 * singletons**, plus a proxy buffer with no remaining call site to drain it.
 *
 * These tests all hold the leader fixed on purpose.  That is the premise, not
 * an incidental detail: if the leader changed, the old trigger set would have
 * covered the case and the tests would prove nothing.
 */

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

type Node = {
  system: ActorSystem;
  cluster: Cluster;
  transport: InMemoryTransport;
};

type NodeSpec = {
  readonly systemName: string;
  readonly port: number;
  readonly seeds: readonly string[];
  readonly roles: readonly string[];
  /**
   * Left high in the reachability test so an unreachable member *stays*
   * unreachable instead of being downed and removed — `MemberRemoved` was
   * already subscribed before the fix, so a test that let the member get that
   * far would pass either way.
   */
  readonly downAfterMs?: number;
};

async function startNode(spec: NodeSpec): Promise<Node> {
  const kitOptions = TestKitOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const kit = TestKit.create(spec.systemName, kitOptions);
  const transport = new InMemoryTransport(new NodeAddress(spec.systemName, 'h', spec.port));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(spec.port)
    .withSeeds([...spec.seeds])
    .withRoles([...spec.roles])
    .withTransport(transport)
    .withFailureDetector({
      heartbeatIntervalMs: 50,
      unreachableAfterMs: 300,
      downAfterMs: spec.downAfterMs ?? 60_000,
    })
    .withGossipIntervalMs(60);
  const cluster = await Cluster.join(kit.system, clusterOptions);
  return { system: kit.system, cluster, transport };
}

async function stopNode(node: Node): Promise<void> {
  await node.cluster.leave().catch(() => {});
  await node.system.terminate().catch(() => {});
}

/**
 * Counts singleton instances per node, so "exactly one cluster-wide" is a
 * number rather than an inference from who started last.
 */
class SingletonCensus {
  private readonly live = new Map<string, number>();
  readonly startedOn: string[] = [];
  readonly received: string[] = [];

  liveOn(where: string): number { return this.live.get(where) ?? 0; }

  total(): number {
    let sum = 0;
    for (const count of this.live.values()) sum += count;
    return sum;
  }

  /** @internal */ _started(where: string): void {
    this.startedOn.push(where);
    this.live.set(where, this.liveOn(where) + 1);
  }

  /** @internal */ _stopped(where: string): void {
    this.live.set(where, this.liveOn(where) - 1);
  }
}

/** The singleton under test — reports its own lifecycle to a census. */
class CensusMarker extends Actor<string> {
  constructor(
    private readonly census: SingletonCensus,
    private readonly where: string,
  ) { super(); }

  override preStart(): void { this.census._started(this.where); }
  override postStop(): void { this.census._stopped(this.where); }
  override onReceive(message: string): void {
    this.census.received.push(`${this.where}:${message}`);
  }
}

/**
 * Records every `LeaderChanged` a node sees from here on, so "the leader held"
 * is checkable.
 *
 * `replayMode: 'snapshot'` and not the default `'events'`: the events replay
 * re-states the *current* leader as a `LeaderChanged`, which would put one
 * entry in this list before anything has happened.  The snapshot replay states
 * the same thing as a single `CurrentClusterState`, leaving `LeaderChanged` to
 * mean what these tests need it to mean — a change.
 */
function recordLeaderChanges(node: Node): string[] {
  const seen: string[] = [];
  node.cluster.subscribe(
    (event) => {
      if (event instanceof LeaderChanged) {
        seen.push(event.leader.fold(() => 'none', (member) => member.address.toString()));
      }
    },
    { replayMode: 'snapshot' },
  );
  return seen;
}

describe('ClusterSingleton — the host moves without a leader change (#637)', () => {
  test('a lower-addressed role member joining takes over, and the incumbent stops', async () => {
    // Addresses decide both the leader and the role host, so the ports are the
    // whole setup: A leads (lowest overall) and carries no role; B is the only
    // role member and therefore hosts; C joins later *below* B and takes over
    // without A ever ceasing to be the leader.
    const systemName = 'sng-host-move';
    const seeds = [`${systemName}@h:52510`];
    const nodeA = await startNode({ systemName, port: 52510, seeds: [], roles: [] });
    const nodeB = await startNode({ systemName, port: 52530, seeds, roles: ['worker'] });
    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2);

    const census = new SingletonCensus();
    const startOn = (node: Node, where: string): ActorRef<string> => {
      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName('needs-worker')
        .withRole('worker')
        .withActor(() => new CensusMarker(census, where));
      return node.cluster.singleton.start(singletonOptions);
    };

    const fromLeader = startOn(nodeA, 'a');
    startOn(nodeB, 'b');

    // B is the only role member, so it hosts.
    await waitFor(() => census.liveOn('b') === 1);
    expect(census.total()).toBe(1);
    expect(nodeA.cluster.isLeader()).toBe(true);

    // From here the leader must not move — that is what makes the case a
    // regression test rather than a restatement of `LeaderChanged`.
    const leaderChangesOnA = recordLeaderChanges(nodeA);
    const leaderChangesOnB = recordLeaderChanges(nodeB);

    const nodeC = await startNode({ systemName, port: 52520, seeds, roles: ['worker'] });
    startOn(nodeC, 'c');
    await waitFor(() => [nodeA, nodeB, nodeC].every(n => n.cluster.upMembers().length === 3));

    // C sorts below B among the role members, so C is the host now.  Before
    // the fix B kept its child and the census settled on two.
    await waitFor(() => census.liveOn('c') === 1 && census.liveOn('b') === 0, 8_000);
    expect(census.total()).toBe(1);
    expect(census.liveOn('c')).toBe(1);

    // The premise held throughout: no leader change was available to react to.
    expect(nodeA.cluster.isLeader()).toBe(true);
    expect(leaderChangesOnA).toEqual([]);
    expect(leaderChangesOnB).toEqual([]);

    // And both sides agree where to route: a tell from the leader — which
    // hosts nothing — reaches C, and reaches it once.
    census.received.length = 0;
    fromLeader.tell('after-handover');
    await waitFor(() => census.received.length > 0);
    await sleep(200);
    expect(census.received).toEqual(['c:after-handover']);

    await stopNode(nodeC); await stopNode(nodeB); await stopNode(nodeA);
  }, 30_000);

  test('the proxy buffer drains when the first role member joins', async () => {
    // The deterministic half of the defect.  With one role-less node the
    // singleton has no host, so every tell buffers; the first role-carrying
    // member to join changes no leader, and `drainBuffer` had exactly two call
    // sites — construction and `LeaderChanged` — so the buffer never drained.
    // Messages sent *afterwards* routed normally, which is what made it look
    // like a race rather than a permanent hole.
    //
    // What is asserted is the drain, not the arrival.  A drained message is
    // handed to whichever node is now the host, and that node's manager can
    // still be a gossip round away from having spawned its child — where it is
    // dropped (`onSingletonDeliver`).  Closing *that* is a separate change to
    // the manager's drop path; see the note on #637.  The buffer never
    // draining at all is what this covers, and it is the half that never
    // recovered on its own.
    const systemName = 'sng-host-drain';
    const seeds = [`${systemName}@h:52501`];
    const nodeA = await startNode({ systemName, port: 52501, seeds: [], roles: [] });
    await waitFor(() => nodeA.cluster.leader().nonEmpty);

    const census = new SingletonCensus();
    const singletonOptionsA = StartSingletonOptions.create<string>()
      .withTypeName('buffered-worker')
      .withRole('worker')
      .withActor(() => new CensusMarker(census, 'a'));
    const proxy = nodeA.cluster.singleton.start(singletonOptionsA) as ClusterSingletonProxy<string>;

    // Nobody carries the role yet, so this is held rather than routed.
    proxy.tell('buffered-before-any-host');
    await sleep(100);
    expect(proxy.hasPending()).toBe(true);
    expect(proxy.droppedCount).toBe(0);
    expect(census.total()).toBe(0);

    const leaderChangesOnA = recordLeaderChanges(nodeA);

    const nodeB = await startNode({ systemName, port: 52502, seeds, roles: ['worker'] });
    const singletonOptionsB = StartSingletonOptions.create<string>()
      .withTypeName('buffered-worker')
      .withRole('worker')
      .withActor(() => new CensusMarker(census, 'b'));
    nodeB.cluster.singleton.start(singletonOptionsB);

    await waitFor(() => nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2);
    await waitFor(() => census.liveOn('b') === 1);

    // Before the fix this stayed pending forever — nothing left to fire.
    await waitFor(() => !proxy.hasPending(), 8_000);
    expect(proxy.hasPending()).toBe(false);
    expect(proxy.droppedCount).toBe(0);

    // A is still the leader it was when the message was buffered, so no
    // `LeaderChanged` was ever available to drain on.
    expect(nodeA.cluster.isLeader()).toBe(true);
    expect(leaderChangesOnA).toEqual([]);

    // And the proxy now routes to the node that joined.
    census.received.length = 0;
    proxy.tell('after-host-exists');
    await waitFor(() => census.received.length > 0);
    expect(census.received).toEqual(['b:after-host-exists']);

    await stopNode(nodeB); await stopNode(nodeA);
  }, 30_000);

  test('the role host going unreachable hands over to the next role member', async () => {
    // Wider than the issue filed it.  An unreachable member drops out of
    // `upMembers()` without being removed, so the host moves — and neither
    // `MemberUnreachable` nor `MemberReachable` was subscribed on either side.
    // With a role-less leader sitting still, the singleton was hosted nowhere
    // until the member was finally downed, which `downAfterMs` here puts a
    // minute away.
    const systemName = 'sng-host-unreachable';
    const seeds = [`${systemName}@h:52511`];
    const nodeA = await startNode({ systemName, port: 52511, seeds: [], roles: [] });
    const nodeB = await startNode({ systemName, port: 52512, seeds, roles: ['worker'] });
    const nodeC = await startNode({ systemName, port: 52513, seeds, roles: ['worker'] });
    await waitFor(() => [nodeA, nodeB, nodeC].every(n => n.cluster.upMembers().length === 3));

    const census = new SingletonCensus();
    for (const [node, where] of [[nodeA, 'a'], [nodeB, 'b'], [nodeC, 'c']] as const) {
      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName('unreachable-worker')
        .withRole('worker')
        .withActor(() => new CensusMarker(census, where));
      node.cluster.singleton.start(singletonOptions);
    }

    // B sorts first among the role members.
    await waitFor(() => census.liveOn('b') === 1);
    expect(nodeA.cluster.isLeader()).toBe(true);

    const leaderChangesOnC = recordLeaderChanges(nodeC);

    // Silence B without letting it leave: its peers' failure detectors move it
    // to `unreachable`, which is a status change with no membership change.
    await nodeB.transport.shutdown();

    await waitFor(() => census.liveOn('c') === 1, 10_000);
    expect(census.liveOn('c')).toBe(1);

    // It really was the unreachability that moved it — B is still a member on
    // C's books, and C never saw a leader change.
    expect(nodeC.cluster.getMembers().length).toBe(3);
    expect(leaderChangesOnC).toEqual([]);

    await stopNode(nodeC); await stopNode(nodeB); await stopNode(nodeA);
  }, 30_000);
});
