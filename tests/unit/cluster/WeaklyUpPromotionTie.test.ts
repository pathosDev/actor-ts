/**
 * #935, the equal-version tie a `weaklyUpAfterMs` node walks into (#1493).
 *
 * A joining node is `joining@E`.  Its own timer moves it to `weakly-up@E+1`;
 * the leader, promoting from the `joining@E` record it holds, moves it to
 * `up@E+1`.  The two records carry the same version, and the merge ignored
 * every record not strictly newer than the one it held — so the node never
 * took its own promotion: no `SelfUp`, `isReady()` false for good, while
 * every peer counted it `up`.  Nothing ever moved either side again, because
 * neither had a newer record to send.
 *
 * The merge now resolves exactly that tie toward `up`, on every node: `up` is
 * where the leader's decision leaves the member, and `weakly-up` is only the
 * member's own timer standing in for that decision until it arrives.  Every
 * other equal-version pair is still ignored, which is the rest of #935.
 *
 * Driven frame by frame on a {@link ManualScheduler}, so the race is a fixed
 * order rather than one that has to be won.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { type ClusterEvent, MemberUp, MemberWeaklyUp, SelfUp } from '../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { GossipMessage, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';

/** The node's own timer: it fires on the first `advance` of this length. */
const WEAKLY_UP_AFTER_MS = 100;

const SYSTEM = 'promotion-tie';
const NODE_HOST = '10.0.193.1';
const LEADER_HOST = '10.0.193.2';
const OTHER_HOST = '10.0.193.3';

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly scheduler: ManualScheduler;
  readonly events: ClusterEvent[];
};

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

/**
 * A node whose one seed nobody answers on, so nothing but the frames a case
 * delivers ever moves its membership.  Every periodic task is far past the
 * case's virtual clock, except the weakly-up timer when one is asked for.
 */
async function startNode(port: number, weaklyUpAfterMs?: number): Promise<NodeHandle> {
  const address = new NodeAddress(SYSTEM, NODE_HOST, port);
  const scheduler = new ManualScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler);
  const system = ActorSystem.create(SYSTEM, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withSeeds([`${OTHER_HOST}:${port}`])
    .withSeedRetryIntervalMs(60_000)
    .withGossipIntervalMs(60_000)
    .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 120_000, downAfterMs: 240_000 });
  if (weaklyUpAfterMs !== undefined) clusterOptions.withWeaklyUpAfterMs(weaklyUpAfterMs);
  const cluster = await Cluster.join(system, clusterOptions);
  const events: ClusterEvent[] = [];
  cluster.subscribe((event) => events.push(event));
  events.length = 0;
  const node = { system, cluster, scheduler, events };
  nodes.push(node);
  return node;
}

/** Frames from one sender must out-number each other (#112), even inside one millisecond. */
let lastSequence = 0;
function nextSequence(): number {
  lastSequence = Math.max(lastSequence + 1, Date.now());
  return lastSequence;
}

/** A gossip frame from `sender` carrying one record: `subject` at `status`, version `version`. */
function gossip(node: NodeHandle, sender: NodeAddress, subject: NodeAddress, status: MemberStatus, version: number): void {
  const frame: GossipMessage = {
    kind: 'gossip',
    from: sender.toJSON(),
    sequence: nextSequence(),
    members: [{ address: subject.toJSON(), status, version, roles: [] }],
  };
  (node.cluster as unknown as { handleWire(from: NodeAddress, message: GossipMessage): void }).handleWire(sender, frame);
}

function statusHeldBy(node: NodeHandle, subject: NodeAddress): { status?: MemberStatus; version?: number } {
  const held = node.cluster.getMembers().find((member) => member.address.equals(subject));
  return { status: held?.status, version: held?.version };
}

const namesOf = (events: ReadonlyArray<ClusterEvent>): string[] => events.map((event) => event.constructor.name);

describe('an equal-version tie between weakly-up and up resolves toward up (#935)', () => {
  test('the node itself takes the promotion its own timer tied with', async () => {
    const node = await startNode(19_301, WEAKLY_UP_AFTER_MS);
    const leader = new NodeAddress(SYSTEM, LEADER_HOST, 19_302, 'leader-run');
    const joiningVersion = node.cluster.selfMember()!.version;

    node.scheduler.advance(WEAKLY_UP_AFTER_MS);
    expect(statusHeldBy(node, node.cluster.selfAddress)).toEqual({ status: 'weakly-up', version: joiningVersion + 1 });

    // The leader saw the joining record and promoted it: up, at the same version.
    gossip(node, leader, leader, 'up', joiningVersion);
    gossip(node, leader, node.cluster.selfAddress, 'up', joiningVersion + 1);

    expect(statusHeldBy(node, node.cluster.selfAddress)).toEqual({ status: 'up', version: joiningVersion + 1 });
    expect(node.events.filter((event) => event instanceof SelfUp)).toHaveLength(1);
    expect(node.cluster.isReady()).toBe(true);
  });

  test('a third node holding the member weakly-up takes the leader\'s up at the same version', async () => {
    // Converging on the node itself is not enough: an observer that heard the
    // member's own weakly-up first would otherwise show it weakly-up for good.
    const observer = await startNode(19_311);
    const member = new NodeAddress(SYSTEM, OTHER_HOST, 19_312, 'member-run');
    const leader = new NodeAddress(SYSTEM, LEADER_HOST, 19_313, 'leader-run');
    const version = Date.now();

    gossip(observer, member, member, 'weakly-up', version);
    gossip(observer, leader, leader, 'up', version);
    observer.events.length = 0;

    gossip(observer, leader, member, 'up', version);

    expect(statusHeldBy(observer, member)).toEqual({ status: 'up', version });
    expect(namesOf(observer.events.filter((event) => event instanceof MemberUp && event.member.address.equals(member))))
      .toEqual(['MemberUp']);
  });

  test('the member\'s own weakly-up at the same version does not take an up back', async () => {
    // The other order of the same two frames.  A tie-break that simply took the
    // incoming record would flap the member between the two for as long as
    // both kept arriving.
    const observer = await startNode(19_321);
    const member = new NodeAddress(SYSTEM, OTHER_HOST, 19_322, 'member-run');
    const leader = new NodeAddress(SYSTEM, LEADER_HOST, 19_323, 'leader-run');
    const version = Date.now();

    gossip(observer, leader, leader, 'up', version);
    gossip(observer, leader, member, 'up', version);
    observer.events.length = 0;

    gossip(observer, member, member, 'weakly-up', version);

    expect(statusHeldBy(observer, member)).toEqual({ status: 'up', version });
    expect(observer.events.filter((event) => event instanceof MemberWeaklyUp)).toHaveLength(0);
  });
});
