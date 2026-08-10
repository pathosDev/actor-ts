/**
 * #161 — a subscriber that attaches after convergence, over real gossip.
 *
 * The unit tests drive the merge directly, which is the right tool for the
 * shapes that need an exact member table.  What they cannot show is that the
 * replay reflects a membership this node *learned* rather than one a test
 * wrote into it — so this one lets two nodes actually find each other first,
 * and only then subscribes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import {
  CurrentClusterState,
  MemberJoined,
  MemberUp,
  SelfUp,
  type ClusterEvent,
} from '../../../../src/cluster/ClusterEvents.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

const SYSTEM = 'replay-converged';
const HOST = 'h';

type Node = { readonly system: ActorSystem; readonly cluster: Cluster };

const running: Node[] = [];

afterEach(async () => {
  for (const node of running.splice(0)) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

async function startNode(port: number, seeds: ReadonlyArray<string>): Promise<Node> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(SYSTEM, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(HOST)
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(SYSTEM, HOST, port)))
    .withSeeds([...seeds])
    .withGossipIntervalMs(60)
    .withSeedRetryIntervalMs(60);
  const cluster = await Cluster.join(system, clusterOptions);
  const node: Node = { system, cluster };
  running.push(node);
  return node;
}

/** Both nodes up, seen from `cluster` — the state a late subscriber should be told about. */
async function awaitTwoUpMembers(cluster: Cluster, label: string): Promise<void> {
  await awaitCondition(() => cluster.upMembers().length === 2, {
    timeoutMs: 4_000, intervalMs: 20, label,
  });
}

describe('a late subscriber sees the converged cluster (#161)', () => {
  test('the default replay names both members and marks self up', async () => {
    const first = await startNode(55_301, []);
    const second = await startNode(55_302, [`${SYSTEM}@${HOST}:55301`]);
    await awaitTwoUpMembers(second.cluster, 'the joining node saw both members up');

    const seen: ClusterEvent[] = [];
    second.cluster.subscribe((event) => { seen.push(event); });

    const joined = seen
      .filter((event): event is MemberJoined => event instanceof MemberJoined)
      .map((event) => event.member.address.toString());
    expect(joined.sort()).toEqual([`${SYSTEM}@${HOST}:55301`, `${SYSTEM}@${HOST}:55302`]);
    expect(seen.filter((event) => event instanceof MemberUp).length).toBe(2);
    // The one event a subscriber usually waits on, and the reason the replay
    // exists at all: attaching after convergence must not miss it.
    expect(seen.some((event) => event instanceof SelfUp)).toBe(true);
    expect(first.cluster.upMembers().length).toBe(2);
  });

  test('snapshot mode states the same membership in one event', async () => {
    await startNode(55_311, []);
    const second = await startNode(55_312, [`${SYSTEM}@${HOST}:55311`]);
    await awaitTwoUpMembers(second.cluster, 'the joining node saw both members up');

    const seen: ClusterEvent[] = [];
    second.cluster.subscribe((event) => { seen.push(event); }, { replayMode: 'snapshot' });

    expect(seen.length).toBe(1);
    const snapshot = seen[0] as CurrentClusterState;
    expect(snapshot).toBeInstanceOf(CurrentClusterState);
    expect(snapshot.members.map((member) => member.address.toString())).toEqual([
      `${SYSTEM}@${HOST}:55311`, `${SYSTEM}@${HOST}:55312`,
    ]);
    expect(snapshot.unreachable).toEqual([]);
    // Lowest address leads, and both nodes must name the same one.
    expect(snapshot.leader.toNullable()?.address.toString()).toBe(`${SYSTEM}@${HOST}:55311`);
  });
});
