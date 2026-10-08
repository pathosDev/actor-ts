/**
 * #1294 — who a cluster event reaches when the set of listeners changes while
 * that event is being delivered.
 *
 * `Cluster.emit` walked the live listener array, and the closure `subscribe`
 * returns splices that same array.  An array iterator advances by index, so a
 * listener that unsubscribed itself mid-dispatch shifted the next one into the
 * slot the loop had already passed, and that listener never saw the event — no
 * log line, and only for whichever listener happened to be registered right
 * after.  That is not a contrived shape: `ClusterReadiness`,
 * `StorageLocalityAdvisory` and the bootstrap's await-ready listener all leave
 * from inside their own callback once they have seen what they waited for.
 * The mirror image was wrong too: a listener subscribed mid-dispatch was
 * appended to the array being walked and handed the event in flight, on top of
 * the replay that already described it.
 *
 * Every event here is driven through the gossip merge, which announces a status
 * transition exactly once, so each count below is a count of deliveries rather
 * than of emits.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  CurrentClusterState,
  MemberUnreachable,
  type ClusterEvent,
} from '../../../src/cluster/ClusterEvents.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';

/** Self sorts below the peer, so the leader never moves and no `LeaderChanged` joins the transcripts. */
const SELF_HOST = '10.0.129.1';
const PEER_HOST = '10.0.129.2';

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
};

/** The private surface these tests drive — the gossip merge, by design. */
interface ClusterInternals {
  mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/**
 * A one-node cluster with every periodic task pushed past the test's lifetime,
 * so nothing but the merges a test drives ever announces anything.
 */
async function startNode(systemName: string, port: number): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({
      heartbeatIntervalMs: 60_000,
      unreachableAfterMs: 2_000,
      downAfterMs: 5_000,
    })
    .withGossipIntervalMs(60_000)
    .withPublishStatsIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster };
}

/**
 * Merge the peer's own record at `status`, as its gossip would carry it.  The
 * peer speaking for itself is the one claim `maySpeakFor` always admits, and an
 * explicit version keeps the order of the merges the order of the test.
 */
function gossipPeer(cluster: Cluster, peer: NodeAddress, status: MemberStatus, version: number): void {
  internals(cluster).mergeMember(peer, 'up', {
    address: peer.toJSON(), status, version, roles: [],
  });
}

/** The event names in arrival order — the readable half of a failure message. */
const namesOf = (events: ReadonlyArray<ClusterEvent>): ReadonlyArray<string> =>
  events.map((event) => event.constructor.name);

/**
 * A listener that keeps what it was told and writes its name into a shared call
 * log, attached in `'snapshot'` mode with its replay discarded — so every entry
 * is a delivery of an event the test drove, and the call log says in which
 * order the listeners were reached.
 */
function recordInto(
  cluster: Cluster, name: string, calls: string[],
): { readonly events: ClusterEvent[]; readonly unsubscribe: () => void } {
  const events: ClusterEvent[] = [];
  const unsubscribe = cluster.subscribe((event) => {
    calls.push(name);
    events.push(event);
  }, { replayMode: 'snapshot' });
  events.length = 0;
  calls.length = 0;
  return { events, unsubscribe };
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('a listener set that changes while an event is being delivered (#1294)', () => {
  test('a listener that unsubscribes itself mid-dispatch does not cost the next one the event', async () => {
    const node = await startNode('dispatch-leaves-itself', 12_941);
    nodes.push(node);
    const peer = new NodeAddress('dispatch-leaves-itself', PEER_HOST, 12_942);
    gossipPeer(node.cluster, peer, 'up', 1);

    const calls: string[] = [];
    const first = recordInto(node.cluster, 'first', calls);
    // The shape `ClusterReadiness` has: it saw what it was waiting for, so it
    // leaves from inside its own callback.
    const second: ClusterEvent[] = [];
    let leave: (() => void) | null = null;
    leave = node.cluster.subscribe((event) => {
      calls.push('second');
      second.push(event);
      if (event instanceof MemberUnreachable) leave?.();
    }, { replayMode: 'snapshot' });
    second.length = 0;
    const third = recordInto(node.cluster, 'third', calls);

    gossipPeer(node.cluster, peer, 'unreachable', 2);

    expect(calls).toEqual(['first', 'second', 'third']);
    expect(namesOf(first.events)).toEqual(['MemberUnreachable']);
    expect(namesOf(second)).toEqual(['MemberUnreachable']);
    expect(namesOf(third.events)).toEqual(['MemberUnreachable']);

    // And the unsubscribe took: the next transition reaches the other two only.
    gossipPeer(node.cluster, peer, 'up', 3);
    expect(namesOf(second)).toEqual(['MemberUnreachable']);
    expect(namesOf(first.events)).toEqual(['MemberUnreachable', 'MemberUp']);
    expect(namesOf(third.events)).toEqual(['MemberUnreachable', 'MemberUp']);
  });

  test('a listener that unsubscribes an earlier one mid-dispatch does not cost the next one the event', async () => {
    // The same skip from the other side: removing an entry *behind* the loop's
    // position shifts the not-yet-visited ones down just the same.
    const node = await startNode('dispatch-removes-earlier', 12_943);
    nodes.push(node);
    const peer = new NodeAddress('dispatch-removes-earlier', PEER_HOST, 12_944);
    gossipPeer(node.cluster, peer, 'up', 1);

    const calls: string[] = [];
    const first = recordInto(node.cluster, 'first', calls);
    const second: ClusterEvent[] = [];
    node.cluster.subscribe((event) => {
      calls.push('second');
      second.push(event);
      if (event instanceof MemberUnreachable) first.unsubscribe();
    }, { replayMode: 'snapshot' });
    second.length = 0;
    const third = recordInto(node.cluster, 'third', calls);

    gossipPeer(node.cluster, peer, 'unreachable', 2);

    expect(calls).toEqual(['first', 'second', 'third']);
    expect(namesOf(third.events)).toEqual(['MemberUnreachable']);
    gossipPeer(node.cluster, peer, 'up', 3);
    expect(namesOf(first.events)).toEqual(['MemberUnreachable']);
    expect(namesOf(third.events)).toEqual(['MemberUnreachable', 'MemberUp']);
  });

  test('a listener unsubscribed by another before its turn is not called with the event in flight', async () => {
    // What a plain copy of the array would get wrong.  Its unsubscribe has
    // returned, so whoever called it may already have released what the
    // callback reads — being called once more, after leaving, is not a
    // harmless extra.  The listener behind it is still reached.
    const node = await startNode('dispatch-removes-later', 12_945);
    nodes.push(node);
    const peer = new NodeAddress('dispatch-removes-later', PEER_HOST, 12_946);
    gossipPeer(node.cluster, peer, 'up', 1);

    const calls: string[] = [];
    let third: { readonly events: ClusterEvent[]; readonly unsubscribe: () => void } | null = null;
    node.cluster.subscribe((event) => {
      calls.push('first');
      if (event instanceof MemberUnreachable) third?.unsubscribe();
    }, { replayMode: 'snapshot' });
    const second = recordInto(node.cluster, 'second', calls);
    third = recordInto(node.cluster, 'third', calls);
    const fourth = recordInto(node.cluster, 'fourth', calls);

    gossipPeer(node.cluster, peer, 'unreachable', 2);

    expect(calls).toEqual(['first', 'second', 'fourth']);
    expect(namesOf(third.events)).toEqual([]);
    expect(namesOf(second.events)).toEqual(['MemberUnreachable']);
    expect(namesOf(fourth.events)).toEqual(['MemberUnreachable']);
  });

  test('a listener subscribed mid-dispatch is told by its replay, not handed the event in flight', async () => {
    const node = await startNode('dispatch-joins-late', 12_947);
    nodes.push(node);
    const peer = new NodeAddress('dispatch-joins-late', PEER_HOST, 12_948);
    gossipPeer(node.cluster, peer, 'up', 1);

    const lateWithEvents: ClusterEvent[] = [];
    const lateWithSnapshot: ClusterEvent[] = [];
    const inFlight: ClusterEvent[] = [];
    node.cluster.subscribe((event) => {
      if (!(event instanceof MemberUnreachable) || inFlight.length > 0) return;
      inFlight.push(event);
      node.cluster.subscribe((lateEvent) => { lateWithEvents.push(lateEvent); });
      node.cluster.subscribe(
        (lateEvent) => { lateWithSnapshot.push(lateEvent); },
        { replayMode: 'snapshot' },
      );
    }, { replayMode: 'snapshot' });

    gossipPeer(node.cluster, peer, 'unreachable', 2);

    expect(inFlight).toHaveLength(1);
    // The member map moved before the announcement went out, so each replay
    // already says the peer is unreachable — once.  Handing the event in flight
    // to the same listener as well told it twice.
    const unreachableAnnouncements = lateWithEvents.filter((event) => event instanceof MemberUnreachable);
    expect(unreachableAnnouncements).toHaveLength(1);
    expect(lateWithEvents.some((event) => event === inFlight[0])).toBe(false);
    expect(namesOf(lateWithSnapshot)).toEqual(['CurrentClusterState']);
    const snapshot = lateWithSnapshot[0] as CurrentClusterState;
    expect(snapshot.unreachable.map((member) => member.address.toString())).toEqual([peer.toString()]);
  });
});
