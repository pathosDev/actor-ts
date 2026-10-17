/**
 * #1477 — what a downed address may do next, route by route.
 *
 * The cluster has no quarantine state, and the decision recorded for #1477 is
 * that it gets no second one: the refusal a downed peer meets is its `removed`
 * tombstone, kept for `max(tombstone.time-to-live, tombstone.min-retention)` —
 * 24 h at the defaults — and then pruned.  The routes that remove a member do
 * not all leave one behind, and `cluster/downing-strategies.mdx` ("What a
 * downed address may do next") states the difference as behaviour an operator
 * can rely on.  This file is what holds that page to the tree:
 *
 * - `Cluster.down()`, a resolver decision and the peer's own `leave` write a
 *   tombstone, so the **same run** of the peer — same incarnation, the version
 *   it was removed at — is refused until the prune, and comes back with its
 *   old roles after it.
 * - The failure detector's own removal (`failure-detector.auto-down = on`, no
 *   provider) deletes the entry: the one route with no refusal, so the same
 *   run is readmitted on its next frame.  Under the default it removes nothing
 *   at all — the peer is parked at `unreachable`, and its next heartbeat
 *   brings it back.
 * - The tombstone is a version floor, not a ban.  A restart (new incarnation,
 *   version from a fresh wall clock) out-versions it and is readmitted at once,
 *   and so is the same run restamping its version, because nothing compares
 *   incarnations yet (#823, #940).  A peer with standing can use the same floor
 *   the other way round and keep a restart out.
 *
 * The peer is simulated: its frames enter through `handleWire`, the entry point
 * every transport calls, so each one meets the replay guard and the merge
 * exactly as a real peer's would.  The detector is driven by back-dating the
 * peer's last sign of life and calling `failureDetectionTick` directly — the
 * seam `FailureDetectorAutoDown.test.ts` uses — so an absence is counted over
 * ticks instead of waited out.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { MemberRemoved, MemberUp } from '../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { DowningProvider } from '../../../src/cluster/downing/index.js';
import type { FailureDetectorLike } from '../../../src/cluster/FailureDetector.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/** Self sorts below every peer, so the leader never moves while a test runs. */
const SELF_HOST = '10.0.147.1';
const PEER_HOST = '10.0.147.2';
const STANDING_PEER_HOST = '10.0.147.3';

/** The role the downed peer carries — what placement would route by if it came back. */
const ROLE = 'payments';

/**
 * The window at the shipped settings, as the docs quote it: `time-to-live` is
 * a day and the derived `min-retention` floor (6 × `down-after`) is half a
 * minute, so the larger of the two is the day.
 */
const DEFAULT_REFUSAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A tombstone short-lived enough to outlive inside one test. */
const SHORT_TOMBSTONE_TTL_MS = 25;

/** Far past the fixture's `down-after` (5 s), so every tick decides `down`. */
const SILENT_PAST_DOWN_MS = 60_000;

/**
 * How many `down` verdicts the parked peer is asked to survive — an absence
 * asserted over one tick says little.  The count `FailureDetectorAutoDown`
 * and `DowningHoldAnnouncement` use for the same question.
 */
const HELD_TICKS = 40;

/** How long before "now" the peer started, so a restart's fresh version out-versions it. */
const EARLIER_START_MS = 60_000;

/** Inside the shipped five-minute `max-version-skew`, so a peer's version claim is admitted. */
const INSIDE_VERSION_SKEW_MS = 4 * 60 * 1000;

/** Downs every member the view holds unreachable — the shape of any strategy's verdict. */
const DOWNS_EVERY_UNREACHABLE: DowningProvider = {
  decide: (view) => new Set(view.unreachable),
};

/** The private surface these tests drive — the wire entry point and the two periodic ticks, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
  failureDetectionTick(): void;
  tombstonePruneTick(): void;
  readonly failureDetector: FailureDetectorLike;
  readonly members: Map<string, Member>;
  readonly tombstoneTtlMs: number;
  readonly tombstoneMinRetentionMs: number;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
};

type NodeSetup = {
  readonly autoDown?: boolean;
  readonly downing?: DowningProvider;
  readonly tombstoneTtlMs?: number;
  readonly tombstoneMinRetentionMs?: number;
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
 * A one-node cluster whose periodic tasks all sit past the test's lifetime, so
 * the only detector tick and prune pass that run are the ones a test calls.
 *
 * The stability window is pinned at its 1 ms floor: what a resolver decision
 * leaves behind is the subject here, not when the resolver is asked.
 */
async function startNode(systemName: string, port: number, setup: NodeSetup = {}): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 2_000, downAfterMs: 5_000 })
    .withSplitBrainResolver({ stableAfterMs: 1 })
    .withGossipIntervalMs(60_000)
    .withPublishStatsIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  if (setup.autoDown !== undefined) clusterOptions.withFailureDetectorAutoDown(setup.autoDown);
  if (setup.downing !== undefined) clusterOptions.withDowning(setup.downing);
  if (setup.tombstoneTtlMs !== undefined) clusterOptions.withTombstoneTtlMs(setup.tombstoneTtlMs);
  if (setup.tombstoneMinRetentionMs !== undefined) {
    clusterOptions.withTombstoneMinRetentionMs(setup.tombstoneMinRetentionMs);
  }
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster };
  nodes.push(node);
  return node;
}

/** One run of the peer: the same `system@host:port`, told apart only by its incarnation. */
const peerRun = (systemName: string, port: number, incarnation: string): NodeAddress =>
  new NodeAddress(systemName, PEER_HOST, port, incarnation);

/**
 * Gossip frames are numbered by their author, from its wall clock, and a
 * receiver drops one that does not out-number the last it accepted from the
 * same connection (#112).  One counter for every simulated author keeps each
 * frame here newer than the one before it — which is what a live peer's next
 * frame is, as opposed to a recording.
 */
let lastSequence = Date.now();
const nextSequence = (): number => {
  lastSequence += 1;
  return lastSequence;
};

/** `sender` gossips the given records over its own connection. */
function gossip(cluster: Cluster, sender: NodeAddress, members: MemberData[]): void {
  internals(cluster).handleWire(sender, {
    kind: 'gossip', from: sender.toJSON(), sequence: nextSequence(), members,
  });
}

/** `run` announces itself `up` at `version`, carrying {@link ROLE} — a peer's ordinary gossip about itself. */
function announce(cluster: Cluster, run: NodeAddress, version: number): void {
  gossip(cluster, run, [{ address: run.toJSON(), status: 'up', version, roles: [ROLE] }]);
}

let lastHeartbeat = 0;
function heartbeat(cluster: Cluster, run: NodeAddress): void {
  lastHeartbeat += 1;
  internals(cluster).handleWire(run, {
    kind: 'heartbeat', from: run.toJSON(), seq: lastHeartbeat, ts: Date.now(),
  });
}

function leave(cluster: Cluster, run: NodeAddress): void {
  internals(cluster).handleWire(run, { kind: 'leave', node: run.toJSON() });
}

/** Pretend the last frame from `peer` arrived `agoMs` ago. */
function lastHeardFrom(cluster: Cluster, peer: NodeAddress, agoMs: number): void {
  internals(cluster).failureDetector.heardFrom(peer, Date.now() - agoMs);
}

function tick(cluster: Cluster, times = 1): void {
  for (let round = 0; round < times; round++) internals(cluster).failureDetectionTick();
}

const entryFor = (cluster: Cluster, peer: NodeAddress): Member | undefined =>
  internals(cluster).members.get(peer.toString());

const upWithRole = (cluster: Cluster): number => cluster.upMembersWithRole(ROLE).length;

/**
 * The same run speaks again, more than once — a refusal that held for one
 * frame and gave way on the second would be no refusal.  The record it sends
 * is the one it was downed with: same incarnation, same version.
 */
function sameRunKeepsTalking(cluster: Cluster, run: NodeAddress, version: number): void {
  for (let frame = 0; frame < 3; frame++) announce(cluster, run, version);
}

/** The run is refused: the tombstone stands where it stood, and nothing carries the role. */
function expectRefused(cluster: Cluster, run: NodeAddress, tombstone: Member): void {
  const entry = entryFor(cluster, run);
  expect(entry?.status).toBe('removed');
  expect(entry?.version).toBe(tombstone.version);
  expect(upWithRole(cluster)).toBe(0);
}

/** The run is back as the member it was: `up`, at the version it announced, with its roles. */
function expectReadmitted(cluster: Cluster, run: NodeAddress, version: number): void {
  const entry = entryFor(cluster, run);
  expect(entry?.status).toBe('up');
  expect(entry?.version).toBe(version);
  expect(entry?.address.incarnation).toBe(run.incarnation);
  expect(entry === undefined ? [] : [...entry.roles]).toEqual([ROLE]);
  expect(upWithRole(cluster)).toBe(1);
}

/** The tombstone a removal left: `removed`, and stamped with the age the prune reads. */
function tombstoneOf(cluster: Cluster, run: NodeAddress): Member {
  const entry = entryFor(cluster, run);
  expect(entry?.status).toBe('removed');
  expect(entry?.removedAt).toBeNumber();
  return entry!;
}

describe('the routes that write a tombstone refuse the same run until the prune (#1477)', () => {
  test('down(): the same run is refused while the tombstone lives, and readmitted with its old roles after the prune', async () => {
    const { cluster } = await startNode('refusal-down', 9_471, {
      tombstoneTtlMs: SHORT_TOMBSTONE_TTL_MS,
      tombstoneMinRetentionMs: 1,
    });
    const run = peerRun('refusal-down', 9_571, 'run-1');
    const version = Date.now();
    announce(cluster, run, version);
    expectReadmitted(cluster, run, version);

    expect(cluster.down(run)).toBe(true);
    const tombstone = tombstoneOf(cluster, run);
    sameRunKeepsTalking(cluster, run, version);
    expectRefused(cluster, run, tombstone);

    // The prune is the end of the refusal, not a side note to it: once the
    // entry is gone there is nothing left to compare the old record against.
    await awaitCondition(() => {
      internals(cluster).tombstonePruneTick();
      return entryFor(cluster, run) === undefined;
    }, { label: 'the prune dropped the tombstone once its time-to-live had passed' });
    expect(upWithRole(cluster)).toBe(0);

    announce(cluster, run, version);
    expectReadmitted(cluster, run, version);
  });

  test('a resolver decision: the same run is refused', async () => {
    const { cluster } = await startNode('refusal-resolver', 9_472, { downing: DOWNS_EVERY_UNREACHABLE });
    const run = peerRun('refusal-resolver', 9_572, 'run-1');
    const version = Date.now();
    announce(cluster, run, version);

    lastHeardFrom(cluster, run, SILENT_PAST_DOWN_MS);
    tick(cluster);
    // The detector only parks it — the removal is the resolver's.
    expect(entryFor(cluster, run)?.status).toBe('unreachable');
    // A tick per poll: the provider is asked once the view has held still for
    // the 1 ms window, which is wall-clock and not a tick count.  Waits for the
    // park to end rather than for a tombstone, so a decision that deleted the
    // entry fails on what it left behind instead of on the wait.
    await awaitCondition(() => {
      tick(cluster);
      return entryFor(cluster, run)?.status !== 'unreachable';
    }, { label: 'the resolver decided about the silent peer' });

    const tombstone = tombstoneOf(cluster, run);
    sameRunKeepsTalking(cluster, run, version);
    expectRefused(cluster, run, tombstone);
  });

  test("the peer's own leave: the same run is refused", async () => {
    const { cluster } = await startNode('refusal-leave', 9_473);
    const run = peerRun('refusal-leave', 9_573, 'run-1');
    const version = Date.now();
    announce(cluster, run, version);

    leave(cluster, run);
    const tombstone = tombstoneOf(cluster, run);
    sameRunKeepsTalking(cluster, run, version);
    expectRefused(cluster, run, tombstone);
  });

  test('the window is the larger of time-to-live and min-retention: a day at the defaults', async () => {
    const { cluster } = await startNode('refusal-window-default', 9_474);
    const run = peerRun('refusal-window-default', 9_574, 'run-1');
    const version = Date.now();
    announce(cluster, run, version);
    expect(cluster.down(run)).toBe(true);
    const tombstone = tombstoneOf(cluster, run);

    const { tombstoneTtlMs, tombstoneMinRetentionMs } = internals(cluster);
    expect(Math.max(tombstoneTtlMs, tombstoneMinRetentionMs)).toBe(DEFAULT_REFUSAL_WINDOW_MS);

    internals(cluster).tombstonePruneTick();
    sameRunKeepsTalking(cluster, run, version);
    expectRefused(cluster, run, tombstone);
  });

  test('min-retention is a floor: a time-to-live shorter than it does not end the refusal', async () => {
    const { cluster } = await startNode('refusal-window-floor', 9_475, {
      tombstoneTtlMs: SHORT_TOMBSTONE_TTL_MS,
      tombstoneMinRetentionMs: 60_000,
    });
    const run = peerRun('refusal-window-floor', 9_575, 'run-1');
    const version = Date.now();
    announce(cluster, run, version);
    expect(cluster.down(run)).toBe(true);
    const tombstone = tombstoneOf(cluster, run);

    // The elapsed time is the subject, so it is what the wait watches.
    const removedAt = tombstone.removedAt!;
    await awaitCondition(() => Date.now() - removedAt > 2 * SHORT_TOMBSTONE_TTL_MS, {
      label: 'twice the time-to-live has passed since the removal',
    });
    internals(cluster).tombstonePruneTick();

    sameRunKeepsTalking(cluster, run, version);
    expectRefused(cluster, run, tombstone);
  });
});

describe("the failure detector's route — the one with no refusal (#1477, #1426)", () => {
  test('auto-down = on deletes the entry, and the same run is readmitted on its next frame', async () => {
    const { cluster } = await startNode('refusal-auto-down', 9_476, { autoDown: true });
    const run = peerRun('refusal-auto-down', 9_576, 'run-1');
    const version = Date.now();
    announce(cluster, run, version);

    const announced: string[] = [];
    cluster.subscribe((event) => {
      if (event instanceof MemberRemoved) announced.push(`removed ${event.member.address}`);
      else if (event instanceof MemberUp) announced.push(`up ${event.member.address}`);
    }, { replayMode: 'snapshot' });

    lastHeardFrom(cluster, run, SILENT_PAST_DOWN_MS);
    tick(cluster);
    // Deleted, not tombstoned: nothing is left to refuse the address with.
    expect(entryFor(cluster, run)).toBeUndefined();

    announce(cluster, run, version);
    expectReadmitted(cluster, run, version);
    // Announced gone, and then back — the same run, after everything that
    // acts on `MemberRemoved` has acted on it.
    expect(announced).toEqual([`removed ${run}`, `up ${run}`]);
  });

  test('under the default the peer is parked, never removed, and its next heartbeat brings it back', async () => {
    const { cluster } = await startNode('refusal-parked', 9_477);
    const run = peerRun('refusal-parked', 9_577, 'run-1');
    const version = Date.now();
    announce(cluster, run, version);

    const removed: string[] = [];
    cluster.subscribe((event) => {
      if (event instanceof MemberRemoved) removed.push(event.member.address.toString());
    }, { replayMode: 'snapshot' });

    lastHeardFrom(cluster, run, SILENT_PAST_DOWN_MS);
    tick(cluster, HELD_TICKS);
    // Parked: still the member it was, no tombstone and no delete.
    const parked = entryFor(cluster, run);
    expect(parked?.status).toBe('unreachable');
    expect(parked === undefined ? [] : [...parked.roles]).toEqual([ROLE]);
    expect(removed).toEqual([]);

    heartbeat(cluster, run);
    expect(entryFor(cluster, run)?.status).toBe('up');
    expect(upWithRole(cluster)).toBe(1);
    expect(removed).toEqual([]);
  });
});

describe('what the tombstone cannot tell apart — a version floor, not a ban (#823, #940)', () => {
  test('a restart — a new incarnation at a fresh version — is readmitted over the tombstone at once', async () => {
    const { cluster } = await startNode('refusal-restart', 9_478);
    const firstRun = peerRun('refusal-restart', 9_578, 'run-1');
    announce(cluster, firstRun, Date.now() - EARLIER_START_MS);
    expect(cluster.down(firstRun)).toBe(true);
    tombstoneOf(cluster, firstRun);

    const restart = peerRun('refusal-restart', 9_578, 'run-2');
    const restartVersion = Date.now();
    announce(cluster, restart, restartVersion);
    expectReadmitted(cluster, restart, restartVersion);
  });

  test('the same run restamping its version is readmitted exactly like a restart', async () => {
    // The limit, pinned so the docs cannot round it up: the tombstone compares
    // versions, a version is a number the peer writes, and the incarnation
    // that would tell this apart from the case above is carried but compared
    // nowhere.  A required incarnation is what moves this test (#823, #940).
    const { cluster } = await startNode('refusal-restamp', 9_479);
    const run = peerRun('refusal-restamp', 9_579, 'run-1');
    announce(cluster, run, Date.now() - EARLIER_START_MS);
    expect(cluster.down(run)).toBe(true);
    tombstoneOf(cluster, run);

    const restampedVersion = Date.now();
    announce(cluster, run, restampedVersion);
    expectReadmitted(cluster, run, restampedVersion);
  });

  test('a peer with standing can gossip a tombstone ahead of time and keep a restart out', async () => {
    // The same floor, used the other way round.  A version inside the skew
    // budget is believable, and a member with standing may assert records about
    // others, so a tombstone dated minutes ahead out-versions the fresh version
    // a legitimate restart starts from.  Also closed only by a required
    // incarnation (#823, #940).
    const { cluster } = await startNode('refusal-keep-out', 9_480);
    const standingPeer = new NodeAddress('refusal-keep-out', STANDING_PEER_HOST, 9_680, 'standing-run');
    gossip(cluster, standingPeer, [{ address: standingPeer.toJSON(), status: 'up', version: Date.now(), roles: [] }]);
    expect(entryFor(cluster, standingPeer)?.status).toBe('up');

    const absent = peerRun('refusal-keep-out', 9_580, 'run-1');
    gossip(cluster, standingPeer, [{
      address: absent.toJSON(),
      status: 'removed',
      version: Date.now() + INSIDE_VERSION_SKEW_MS,
      roles: [],
      removedAt: Date.now(),
    }]);
    const tombstone = tombstoneOf(cluster, absent);

    const restart = peerRun('refusal-keep-out', 9_580, 'run-2');
    announce(cluster, restart, Date.now());
    expectRefused(cluster, restart, tombstone);
  });
});
