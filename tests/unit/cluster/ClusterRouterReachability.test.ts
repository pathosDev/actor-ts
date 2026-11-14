/**
 * `ClusterRouter` keeps its routee set in step with what the cluster would
 * place work on (#942).
 *
 * The router used to rebuild on `MemberUp` / `MemberRemoved` only, while
 * `upMembers()` — the set it rebuilds *from* — drops a member the moment it
 * stops being `up`.  An unreachable member therefore stayed a routee for the
 * whole `unreachable → removed` window (`downAfterMs`), and `1/N` of the
 * routed traffic went into a transport buffer nobody would ever drain, with
 * nothing reaching dead letters.  The same held for a `leaving` status learned
 * through gossip, which emits `MemberLeft` and nothing else.
 *
 * The cluster here is a stand-in: it holds a member map, answers
 * `placementCandidates` the way the real one does (status `up` only), emits
 * the events the real one emits on each transition, and records every
 * envelope a routee asks it to send.  That makes "zero envelopes addressed to
 * the unreachable member" an exact count rather than a timing argument.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import {
  type ClusterEvent,
  MemberLeft,
  MemberReachable,
  MemberUnreachable,
  MemberUp,
} from '../../../src/cluster/ClusterEvents.js';
import { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { EnvelopeMessage, MemberStatus } from '../../../src/cluster/Protocol.js';
import { ClusterRouter, ClusterRouterOptions } from '../../../src/cluster/router/index.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { DeadLetter } from '../../../src/SystemMessages.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

type WorkMessage = { kind: 'work'; id: number };

const SELF = new NodeAddress('router-sys', 'h', 1);
const PEER = new NodeAddress('router-sys', 'h', 2);

class StandInCluster {
  readonly sentTo: string[] = [];
  private readonly members = new Map<string, Member>();
  private readonly listeners: Array<(event: ClusterEvent) => void> = [];

  constructor(readonly system: ActorSystem) {}

  add(address: NodeAddress, status: MemberStatus): void {
    this.members.set(address.toString(), new Member(address, status, 1));
  }

  /** Move a member to `status` and announce it the way `Cluster` does. */
  transition(address: NodeAddress, status: MemberStatus, event: (member: Member) => ClusterEvent): void {
    const member = new Member(address, status, 2);
    this.members.set(address.toString(), member);
    for (const listener of [...this.listeners]) listener(event(member));
  }

  subscribe(listener: (event: ClusterEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  placementCandidates(): Member[] {
    return [...this.members.values()]
      .filter((member) => member.status === 'up')
      .sort((a, b) => a.address.compareTo(b.address));
  }

  placementCandidatesWithRole(role: string): Member[] {
    return this.placementCandidates().filter((member) => member.hasRole(role));
  }

  _sendEnvelope(to: NodeAddress, _envelope: EnvelopeMessage): void {
    this.sentTo.push(to.toString());
  }

  countTo(address: NodeAddress): number {
    return this.sentTo.filter((entry) => entry === address.toString()).length;
  }
}

let system: ActorSystem | null = null;

afterEach(async () => {
  await system?.terminate();
  system = null;
});

type RouterRig = {
  cluster: StandInCluster;
  router: ActorRef<WorkMessage>;
  tellBatch: (from: number, count: number) => Promise<void>;
};

/**
 * Spawns the router and waits until it has routed a first pair of messages, so
 * its `preStart` rebuild is behind us: a transition announced before the actor
 * started would be read by that initial rebuild, and prove nothing about the
 * subscription.  The warm-up envelopes are then forgotten.
 */
async function setUp(): Promise<RouterRig> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  system = ActorSystem.create('router-sys', systemOptions);
  const cluster = new StandInCluster(system);
  cluster.add(SELF, 'up');
  cluster.add(PEER, 'up');
  const routerOptions = ClusterRouterOptions.create<WorkMessage>()
    .withCluster(cluster as unknown as Cluster)
    .withRouterType('round-robin')
    .withRouteePath('/user/worker');
  const router = system.spawn(ClusterRouter.factory<WorkMessage>(routerOptions), 'router');
  const tellBatch = async (from: number, count: number): Promise<void> => {
    const before = cluster.sentTo.length;
    for (let id = from; id < from + count; id++) router.tell({ kind: 'work', id });
    await awaitCondition(() => cluster.sentTo.length === before + count, {
      timeoutMs: 2_000, label: `${count} routed envelopes reached the transport`,
    });
  };
  await tellBatch(-2, 2);
  cluster.sentTo.length = 0;
  return { cluster, router, tellBatch };
}

describe('ClusterRouter — routee set follows reachability (#942)', () => {
  test('an unreachable member stops receiving envelopes at once, not at removal', async () => {
    const { cluster, tellBatch } = await setUp();
    await tellBatch(0, 4);
    expect(cluster.countTo(PEER)).toBe(2);

    cluster.transition(PEER, 'unreachable', (member) => new MemberUnreachable(member));
    const peerBefore = cluster.countTo(PEER);
    await tellBatch(4, 10);
    expect(cluster.countTo(PEER)).toBe(peerBefore);
    expect(cluster.countTo(SELF)).toBe(12);
  });

  test('MemberReachable puts the member back into the rotation', async () => {
    const { cluster, tellBatch } = await setUp();
    cluster.transition(PEER, 'unreachable', (member) => new MemberUnreachable(member));
    await tellBatch(0, 4);
    expect(cluster.countTo(PEER)).toBe(0);

    cluster.transition(PEER, 'up', (member) => new MemberReachable(member));
    await tellBatch(4, 4);
    expect(cluster.countTo(PEER)).toBe(2);
  });

  test('a leaving status learned through gossip (MemberLeft alone) drops the member', async () => {
    const { cluster, tellBatch } = await setUp();
    cluster.transition(PEER, 'leaving', (member) => new MemberLeft(member));
    await tellBatch(0, 6);
    expect(cluster.countTo(PEER)).toBe(0);
    expect(cluster.countTo(SELF)).toBe(6);
  });

  test('with every routee gone a routed message reaches dead letters, not just a log line', async () => {
    const { cluster, router } = await setUp();
    const letters: DeadLetter[] = [];
    system!.eventStream.subscribeFunction(DeadLetter, (letter) => letters.push(letter));
    cluster.transition(PEER, 'unreachable', (member) => new MemberUnreachable(member));
    cluster.transition(SELF, 'unreachable', (member) => new MemberUnreachable(member));
    router.tell({ kind: 'work', id: 99 });
    await awaitCondition(() => letters.length === 1, {
      timeoutMs: 2_000, label: 'the unroutable message reached dead letters',
    });
    expect(letters[0]!.message).toEqual({ kind: 'work', id: 99 });
    expect(cluster.sentTo).toEqual([]);
  });

  test('a fresh MemberUp still rebuilds (the original trigger is kept)', async () => {
    const { cluster, tellBatch } = await setUp();
    const third = new NodeAddress('router-sys', 'h', 3);
    cluster.transition(third, 'up', (member) => new MemberUp(member));
    await tellBatch(0, 6);
    expect(cluster.countTo(third)).toBe(2);
  });
});
