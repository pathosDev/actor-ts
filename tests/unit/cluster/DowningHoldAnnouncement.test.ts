/**
 * #929 — what a subscriber is *told* while a `DowningProvider` holds an
 * unreachable peer.
 *
 * The eviction half of #929 is covered next door in `DowningWiring.test.ts`:
 * with a provider configured the detector parks the peer at `unreachable` and
 * the member map stops moving.  The **announcement** half was covered nowhere.
 * No downing test subscribed to the cluster event stream at all, so
 * `holdForResolver` could have emitted `MemberDown` on every one of those ticks
 * — roughly three dozen in the park test — with the whole cluster suite green.
 *
 * That gap is not tidiness.  `MemberDown` is a *membership fact*, and the
 * subsystems that act on one are written to ignore a mere reachability
 * observation: `ClusterSingletonManager` reconciles on `MemberDown` and
 * deliberately not on `MemberUnreachable`, so announcing the detector's verdict
 * would let one node's heartbeat timeout trigger a singleton takeover the
 * resolver never sanctioned — and an application that releases a resource on
 * `MemberDown` would release it for a peer that is merely unreachable and may
 * still come back.  Which event is announced *is* the authority #929 moved.
 *
 * Driven ticks rather than timers, the seam `ClusterEventsSubscription.test.ts`
 * uses: reachability is a function of elapsed silence, so the detector's sample
 * is back-dated and `failureDetectionTick` is called directly.  That is what
 * lets these assertions count announcements exactly — and, in particular, count
 * an absence over a known number of ticks rather than sleeping past a window and
 * hoping the loop got there.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  MemberDown,
  MemberRemoved,
  MemberUnreachable,
  type ClusterEvent,
} from '../../../src/cluster/ClusterEvents.js';
import type {
  DowningProvider,
  SplitBrainResolverOptionsType,
} from '../../../src/cluster/downing/index.js';
import type { FailureDetectorLike } from '../../../src/cluster/FailureDetector.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { sleep } from '../../util/AwaitCondition.js';

/** Self sorts below the peer, so the leader never moves and no `LeaderChanged` clouds the stream. */
const SELF_HOST = '10.0.92.1';
const PEER_HOST = '10.0.92.2';

/** Past `unreachableAfterMs` (2 s), short of `downAfterMs` (5 s). */
const SILENT_BUT_NOT_DOWN_MS = 3_000;
/** Past `downAfterMs`, so every subsequent tick's verdict is `down`. */
const SILENT_PAST_DOWN_MS = 6_000;

/**
 * How many `down` verdicts the hold is asked to survive.
 *
 * Matched to the shipped fixture next door: `DowningWiring`'s park test waits
 * three times `down-after` at a 50 ms detector cadence, which is about three
 * dozen ticks that each decide `down`.  The number is the point — an absence
 * asserted over one tick says almost nothing, and this is the count a real
 * partition reaches within seconds.
 */
const HELD_TICKS = 40;

/** A provider that is consulted and never answers — a minority side under `KeepMajority`. */
const NEVER_DECIDES: DowningProvider = { decide: () => new Set<string>() };

/**
 * The window in front of the resolver (#839), pinned below one detector round.
 *
 * These tests are about what the detector announces while the resolver has not
 * answered, not about when it is asked; the shipped 20 s window would simply
 * mean it never is.  `0` is refused by `SplitBrainResolverOptionsValidator` —
 * "no window" already has a spelling — so 1 ms is the floor.
 */
const NO_STABILITY_WINDOW: Partial<SplitBrainResolverOptionsType> = { stableAfterMs: 1 };

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

/** The private surface these tests drive — the merge and the detector tick, by design. */
interface ClusterInternals {
  mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void;
  failureDetectionTick(): void;
  readonly failureDetector: FailureDetectorLike;
  readonly members: Map<string, Member>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/* --------------------------- what was announced ---------------------------- */

/** The peer went unreachable — an observation, and the only one #929 allows here. */
type MemberUnreachableAnnouncement = {
  readonly kind: 'member-unreachable';
  readonly member: Member;
};
/** The peer was declared down — a membership fact, and the authority #929 moved. */
type MemberDownAnnouncement = { readonly kind: 'member-down'; readonly member: Member };
/** The peer was evicted — `MemberDown`'s other half on the no-provider path. */
type MemberRemovedAnnouncement = { readonly kind: 'member-removed'; readonly member: Member };
/** Everything else a subscriber is told — real, and none of it this file's subject. */
type OtherAnnouncement = { readonly kind: 'other'; readonly event: ClusterEvent };

type Announcement =
  | MemberUnreachableAnnouncement
  | MemberDownAnnouncement
  | MemberRemovedAnnouncement
  | OtherAnnouncement;

/**
 * Restate one cluster event as a `kind`-tagged variant, so the recorder below
 * can dispatch on it.
 *
 * The tag is not ceremony.  `MemberUnreachable`, `MemberDown` and
 * `MemberRemoved` are **structurally identical** — each is `{ member: Member }`
 * — so a `match` whose arms are `P.instanceOf` patterns narrows by *shape*: the
 * first arm removes all three from the union at once, and the later arms then
 * receive `ClusterStatsPublished | CurrentClusterState | …` rather than the
 * class they name.  That compiles under `bun test`, which transpiles without
 * checking, and fails `typecheck:dev`.  `instanceof` is the only thing that can
 * tell the three apart, so it happens once, here, and the matcher gets a
 * discriminant it can actually discriminate on.
 */
function announcementOf(event: ClusterEvent): Announcement {
  if (event instanceof MemberUnreachable) {
    return { kind: 'member-unreachable', member: event.member };
  }
  if (event instanceof MemberDown) return { kind: 'member-down', member: event.member };
  if (event instanceof MemberRemoved) return { kind: 'member-removed', member: event.member };
  return { kind: 'other', event };
}

/**
 * What a subscriber was actually told, bucketed by the three announcements this
 * file is about.
 *
 * A class rather than a closure over three arrays because the dispatch is a
 * `match` over an **incoming cluster event**, and the project's rule for that
 * shape is that every arm delegates to a private `onXxx` handler taking the
 * named variant type, instead of carrying an inline body.
 */
class DowningAnnouncementRecorder {
  /** Every event in arrival order, kept so a failure names what *did* arrive. */
  readonly announced: ClusterEvent[] = [];
  readonly unreachable: Member[] = [];
  readonly down: Member[] = [];
  readonly removed: Member[] = [];

  record(event: ClusterEvent): void {
    // Outside the match: the transcript is not one of the cases, it is the
    // context every case is read against.
    this.announced.push(event);
    match(announcementOf(event))
      .with(
        { kind: 'member-unreachable' },
        (announcement) => this.onMemberUnreachable(announcement),
      )
      .with({ kind: 'member-down' }, (announcement) => this.onMemberDown(announcement))
      .with({ kind: 'member-removed' }, (announcement) => this.onMemberRemoved(announcement))
      .with({ kind: 'other' }, (announcement) => this.onOther(announcement))
      .exhaustive();
  }

  /** The event names in arrival order — the readable half of a failure message. */
  names(): ReadonlyArray<string> {
    return this.announced.map((event) => event.constructor.name);
  }

  /** Forget everything recorded so far — used to drop the subscription replay. */
  reset(): void {
    this.announced.length = 0;
    this.unreachable.length = 0;
    this.down.length = 0;
    this.removed.length = 0;
  }

  private onMemberUnreachable(announcement: MemberUnreachableAnnouncement): void {
    this.unreachable.push(announcement.member);
  }

  private onMemberDown(announcement: MemberDownAnnouncement): void {
    this.down.push(announcement.member);
  }

  private onMemberRemoved(announcement: MemberRemovedAnnouncement): void {
    this.removed.push(announcement.member);
  }

  private onOther(_announcement: OtherAnnouncement): void {
    // `MemberJoined`, `MemberUp`, `SelfUp`, `LeaderChanged`, `ReachabilityChanged`,
    // `CurrentClusterState`: real announcements, none of them the authority #929 moved.
  }
}

/**
 * A one-node cluster with every periodic task pushed past the test's lifetime,
 * so the only tick that ever runs is the one a test calls.
 *
 * With no seeds the node elects itself `up` and is its own leader.  The
 * detector's two thresholds keep their defaults — it is driven by back-dating
 * its sample, not by waiting for them.
 */
async function startNode(
  systemName: string, port: number, downing?: DowningProvider,
): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  let clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({
      heartbeatIntervalMs: 60_000,
      unreachableAfterMs: 2_000,
      downAfterMs: 5_000,
    })
    .withSplitBrainResolver(NO_STABILITY_WINDOW)
    .withGossipIntervalMs(60_000)
    .withPublishStatsIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  if (downing !== undefined) clusterOptions = clusterOptions.withDowning(downing);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address };
}

const peerAddress = (systemName: string, port: number): NodeAddress =>
  new NodeAddress(systemName, PEER_HOST, port);

/**
 * Merge a peer's own record, as its gossip would carry it.  `from` is the peer
 * itself, which is the one claim `maySpeakFor` always admits — otherwise no
 * node could join at all.
 */
function gossipSelfRecord(cluster: Cluster, peer: NodeAddress, status: MemberStatus): void {
  internals(cluster).mergeMember(peer, 'up', {
    address: peer.toJSON(), status, version: Date.now(), roles: [],
  });
}

/** Pretend the last thing heard from `peer` arrived `agoMs` ago. */
function lastHeardFrom(cluster: Cluster, peer: NodeAddress, agoMs: number): void {
  internals(cluster).failureDetector.heartbeat(peer, Date.now() - agoMs);
}

/**
 * Attach a recorder and drop the subscription replay, so every event counted
 * afterwards is one the detector announced during this test.
 *
 * `'snapshot'` mode because it makes that discard one event instead of one per
 * member: an `'events'` replay would re-announce the peer's current status, and
 * a test whose subject is *which status event was announced* should not have to
 * subtract its own attach from the transcript.
 */
function recordFrom(cluster: Cluster): DowningAnnouncementRecorder {
  const recorder = new DowningAnnouncementRecorder();
  cluster.subscribe((event) => { recorder.record(event); }, { replayMode: 'snapshot' });
  recorder.reset();
  return recorder;
}

const statusOf = (cluster: Cluster, peer: NodeAddress): MemberStatus | undefined =>
  internals(cluster).members.get(peer.toString())?.status;

const addressesOf = (members: ReadonlyArray<Member>): ReadonlyArray<string> =>
  members.map((member) => member.address.toString());

/**
 * The distinct subjects of an announcement, in first-seen order.
 *
 * The detector's own no-provider arm announces `MemberDown` **twice** — once
 * from `updateMember`'s `up → down` status transition and once from the
 * explicit `emit` beside it.  That duplication long pre-dates #929 (the
 * transition emit arrived with `emitStatusTransition`, the explicit one was
 * always there) and is not what these tests are about, so the control below
 * asserts *who* was announced rather than how many times — otherwise a future
 * dedupe would read as a regression in a file that has no opinion on it.
 */
const distinct = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('what the detector announces while a downing provider holds a peer (#929)', () => {
  test('an `up` peer is announced unreachable and never down, for every held tick', async () => {
    const node = await startNode('hold-announce-up', 9_291, NEVER_DECIDES);
    nodes.push(node);
    const peer = peerAddress('hold-announce-up', 9_391);
    gossipSelfRecord(node.cluster, peer, 'up');
    const recorder = recordFrom(node.cluster);

    // A verdict short of `down-after` first, so the peer is marked by the
    // detector's own `unreachable` arm rather than by the hold.
    lastHeardFrom(node.cluster, peer, SILENT_BUT_NOT_DOWN_MS);
    internals(node.cluster).failureDetectionTick();
    expect(addressesOf(recorder.unreachable)).toContain(peer.toString());
    // A count, not a `1`: that arm announces twice today — once through
    // `updateMember`'s `up → unreachable` transition and once explicitly beside
    // it — and how many times is this file's baseline, not its subject.
    const announcedByTheUnreachableArm = recorder.unreachable.length;

    // …and then past it, for as long as the resolver declines to answer.  Every
    // one of these ticks reaches `holdForResolver` with a `down` verdict in hand.
    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    for (let tick = 0; tick < HELD_TICKS; tick++) internals(node.cluster).failureDetectionTick();

    // The claim, stated as the two halves it has: the membership fact is never
    // announced, and the reachability observation is not re-announced either —
    // a park that re-emitted would flood a subscriber once per detector round.
    expect(addressesOf(recorder.down)).toEqual([]);
    expect(addressesOf(recorder.removed)).toEqual([]);
    expect(recorder.names()).not.toContain('MemberDown');
    expect(recorder.unreachable.length).toBe(announcedByTheUnreachableArm);
    // Still held, which is what makes the absence above the right absence
    // rather than a peer that quietly went away.
    expect(statusOf(node.cluster, peer)).toBe('unreachable');
  });

  test('a peer parked from a status the detector never marks is announced the same way', async () => {
    // The re-mark path, and the one `holdForResolver` does real work on: the
    // detector's `unreachable` arm fires only for a member that was `up`, so a
    // peer that fell silent while `leaving` (or `joining`, or `weakly-up`)
    // arrives at `down-after` unmarked and is parked from there.  A `MemberDown`
    // emitted *after* the already-`unreachable` guard would be invisible to the
    // test above and would land here.
    const node = await startNode('hold-announce-leaving', 9_292, NEVER_DECIDES);
    nodes.push(node);
    const peer = peerAddress('hold-announce-leaving', 9_392);
    gossipSelfRecord(node.cluster, peer, 'leaving');
    const recorder = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    for (let tick = 0; tick < HELD_TICKS; tick++) internals(node.cluster).failureDetectionTick();

    expect(statusOf(node.cluster, peer)).toBe('unreachable');
    // Exactly once, by `updateMember`'s status transition — the hold does not
    // announce a second time, and the guard keeps the re-mark from repeating.
    expect(addressesOf(recorder.unreachable)).toEqual([peer.toString()]);
    expect(addressesOf(recorder.down)).toEqual([]);
    expect(addressesOf(recorder.removed)).toEqual([]);
    expect(recorder.names()).not.toContain('MemberDown');
  });

  test('with no provider the same silence *is* announced as down — so the absence above is real', async () => {
    // The control arm, and the reason the two tests above are not vacuous.
    // Identical peer, identical back-dating, identical ticks: without a
    // provider the detector owns the eviction and says so.  If this arm ever
    // stopped announcing `MemberDown`, the assertions above would be measuring
    // a tick that never reached a `down` verdict at all.
    const node = await startNode('hold-announce-control', 9_293);
    nodes.push(node);
    const peer = peerAddress('hold-announce-control', 9_393);
    gossipSelfRecord(node.cluster, peer, 'up');
    const recorder = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    internals(node.cluster).failureDetectionTick();

    expect(distinct(addressesOf(recorder.down))).toEqual([peer.toString()]);
    expect(distinct(addressesOf(recorder.removed))).toEqual([peer.toString()]);
    expect(internals(node.cluster).members.has(peer.toString())).toBe(false);
  });

  test('the provider really is consulted about the partition it is being asked to hold', async () => {
    // The other half of non-vacuity: the hold is worth nothing if the resolver
    // is never asked, because then "the resolver has not answered yet" is just
    // a cluster with no resolver in it.  A count rather than a wall clock — the
    // stability window is pinned at 1 ms, and `Date.now()` advances between
    // ticks because each awaits a turn of the event loop.
    let consultedAboutPartition = 0;
    const counting: DowningProvider = {
      decide(view) {
        if (view.unreachable.size > 0) consultedAboutPartition++;
        return new Set<string>();
      },
    };
    const node = await startNode('hold-announce-consulted', 9_294, counting);
    nodes.push(node);
    const peer = peerAddress('hold-announce-consulted', 9_394);
    gossipSelfRecord(node.cluster, peer, 'up');
    const recorder = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    for (let tick = 0; tick < HELD_TICKS; tick++) {
      internals(node.cluster).failureDetectionTick();
      await sleep(1);
    }

    // Re-asked rather than asked once and cached: `lastDownedView` is written
    // only when a decision is *applied*, so an undecided view comes back.
    expect(consultedAboutPartition).toBeGreaterThan(1);
    expect(addressesOf(recorder.down)).toEqual([]);
    expect(statusOf(node.cluster, peer)).toBe('unreachable');
  }, 15_000);
});
