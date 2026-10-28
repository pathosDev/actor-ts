/**
 * #1426 — a node that restarts on the same `host:port` ends its previous
 * incarnation on every node that still holds it.
 *
 * `system@host:port` names a slot, and a restarted process is a new incarnation
 * in the same slot (#940).  The new run's first record out-versions the old
 * one, so the merge replaces the entry — and it used to do that silently: the
 * survivor announced the new run joining and never the old run leaving, so
 * remote death watch, which reacts to `MemberDown` / `MemberRemoved` alone,
 * never told the watchers of the old run's actors that they were gone.  Under
 * the shipped `auto-down = on` that was the path of every restart faster than
 * `down-after`; under `auto-down = off` it was the path of every restart of a
 * parked peer, whose record nothing else would ever remove.  Now the old run is
 * announced down and removed first, and only then does the new run join.
 *
 * A reconnect of the *same* run is not a restart and announces nothing.  A
 * record that carries no incarnation — a peer from before the field existed, or
 * a relay of that version that stripped it — cannot be told from a reconnect,
 * so it keeps the silent replacement it always had.
 *
 * Two halves: two real nodes on the in-memory transport, crashed and restarted
 * in real time, for what a watcher on the survivor receives; and one node fed
 * frames through `handleWire`, for the merge path's exact announcements.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import type { ClusterEvent } from '../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { FailureDetectorLike } from '../../../src/cluster/FailureDetector.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, MemberStatus, WireMessage } from '../../../src/cluster/Protocol.js';
import { RemoteActorRef } from '../../../src/cluster/RemoteActorRef.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Terminated } from '../../../src/SystemMessages.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger } from '../../util/RecordingLogger.js';

/* ------------------------------ shared pieces ----------------------------- */

/** Lives on the restarting node; a watcher elsewhere has something to watch. */
class Subject extends Actor<'stop'> {
  override onReceive(): void { this.context.stopSelf(); }
}

type WatcherCommand = { kind: 'watch'; subject: ActorRef } | Terminated;

/** Records every `Terminated` it is handed. */
class Watcher extends Actor<WatcherCommand> {
  constructor(private readonly terminations: Terminated[]) { super(); }

  override onReceive(command: WatcherCommand): void {
    if (command instanceof Terminated) { this.terminations.push(command); return; }
    this.context.watch(command.subject);
  }
}

/** One membership announcement about the subject, as a subscriber reads it. */
type Announcement = {
  readonly event: string;
  readonly status: MemberStatus;
  readonly incarnation: string | undefined;
};

/** Every status event `cluster` announces about `subject`, from now on. */
function announcementsAbout(cluster: Cluster, subject: NodeAddress): Announcement[] {
  const seen: Announcement[] = [];
  cluster.subscribe((event: ClusterEvent) => {
    const member = (event as { member?: Member }).member;
    if (member === undefined || !member.address.equals(subject)) return;
    seen.push({
      event: event.constructor.name,
      status: member.status,
      incarnation: member.address.incarnation,
    });
  }, { replayMode: 'snapshot' });
  return seen;
}

/** The node-loss half of death watch, read where it is kept. */
function outboundWatchesOn(cluster: Cluster, peer: NodeAddress): number {
  const watcher = cluster._remoteWatcher as unknown as { outbound: Map<string, Map<string, unknown>> };
  return watcher.outbound.get(peer.toString())?.size ?? 0;
}

/* ---------------------- two real nodes, real time ---------------------- */

type LiveNode = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
  readonly transport: InMemoryTransport;
  readonly log: RecordingLogger;
};

type LiveSetup = {
  /** The detector's `down-after`; `unreachable-after` is 200 ms throughout. */
  readonly downAfterMs: number;
  /** `failure-detector.auto-down` in code; unset leaves the shipped `on`. */
  readonly autoDown?: boolean;
};

let live: LiveNode[] = [];

afterEach(async () => {
  for (const node of live) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  live = [];
});

async function startLiveNode(
  systemName: string, port: number, seeds: string[], setup: LiveSetup,
): Promise<LiveNode> {
  const address = new NodeAddress(systemName, 'h', port);
  const log = new RecordingLogger(LogLevel.Warn);
  const systemOptions = ActorSystemOptions.create().withLogger(log).withLogLevel(LogLevel.Warn);
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new InMemoryTransport(address);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds(seeds)
    .withTransport(transport)
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: setup.downAfterMs })
    .withGossipIntervalMs(40);
  if (setup.autoDown !== undefined) clusterOptions.withFailureDetectorAutoDown(setup.autoDown);
  const cluster = await Cluster.join(system, clusterOptions);
  const node: LiveNode = { system, cluster, address, transport, log };
  live.push(node);
  return node;
}

/**
 * A crash rather than a stop: the transport goes first, so not even the leave
 * frame of the system's own shutdown gets out.  The node is gone from the
 * teardown list — the test has already ended it.
 */
async function crash(node: LiveNode): Promise<void> {
  await node.transport.shutdown();
  await node.system.terminate();
  live = live.filter((candidate) => candidate !== node);
}

const statusIn = (viewer: LiveNode, subject: NodeAddress): MemberStatus | undefined =>
  viewer.cluster.getMembers().find((member) => member.address.equals(subject))?.status;

const incarnationIn = (viewer: LiveNode, subject: NodeAddress): string | undefined =>
  viewer.cluster.getMembers().find((member) => member.address.equals(subject))?.address.incarnation;

type WatchedRestart = {
  readonly survivor: LiveNode;
  readonly crashed: LiveNode;
  readonly terminations: Terminated[];
  readonly aboutCrashed: Announcement[];
};

/** Two nodes up, a watcher on the first watching an actor on the second. */
async function watchedPair(systemName: string, basePort: number, setup: LiveSetup): Promise<WatchedRestart> {
  const survivor = await startLiveNode(systemName, basePort, [], setup);
  const crashed = await startLiveNode(systemName, basePort + 1, [survivor.address.toString()], setup);
  await awaitCondition(
    () => survivor.cluster.upMembers().length === 2 && crashed.cluster.upMembers().length === 2,
    { timeoutMs: 4_000, label: 'both nodes up in both views' },
  );
  const subject = crashed.system.spawn(Subject, 'subject');
  const terminations: Terminated[] = [];
  const watcher = survivor.system.spawn(() => new Watcher(terminations), 'watcher');
  const remote = new RemoteActorRef<'stop'>(crashed.address, subject.path.toString(), survivor.cluster);
  watcher.tell({ kind: 'watch', subject: remote });
  await awaitCondition(() => outboundWatchesOn(survivor.cluster, crashed.address) === 1, {
    timeoutMs: 2_000, label: 'the survivor holds the watch on the actor across the node boundary',
  });
  const aboutCrashed = announcementsAbout(survivor.cluster, crashed.address);
  aboutCrashed.length = 0;
  return { survivor, crashed, terminations, aboutCrashed };
}

/**
 * What the survivor must say when the slot's new run arrives: the old run down
 * and removed — under its own incarnation — before the new run is joined.
 */
function expectOldRunEndedBeforeTheNewRunJoined(
  aboutCrashed: ReadonlyArray<Announcement>, oldRun: string, newRun: string,
): void {
  const indexOf = (event: string, incarnation: string): number =>
    aboutCrashed.findIndex((entry) => entry.event === event && entry.incarnation === incarnation);
  const down = indexOf('MemberDown', oldRun);
  const removed = indexOf('MemberRemoved', oldRun);
  const joined = indexOf('MemberJoined', newRun);
  expect(down, JSON.stringify(aboutCrashed)).toBeGreaterThanOrEqual(0);
  expect(removed, JSON.stringify(aboutCrashed)).toBeGreaterThan(down);
  expect(joined, JSON.stringify(aboutCrashed)).toBeGreaterThan(removed);
}

describe('a same-address restart ends the old incarnation on the survivor (#1426)', () => {
  test('under the shipped auto-down, a restart inside down-after: the old run\'s watchers get Terminated', async () => {
    // down-after far beyond the test, so the restart lands while the old run
    // is still only unreachable — the window in which the detector would have
    // removed it, given time.
    const { survivor, crashed, terminations, aboutCrashed } = await watchedPair('restart-inside', 47_301, {
      downAfterMs: 60_000,
    });
    const oldRun = crashed.cluster.selfAddress.incarnation!;

    await crash(crashed);
    await awaitCondition(() => statusIn(survivor, crashed.address) === 'unreachable', {
      timeoutMs: 2_000, label: 'the survivor saw the crashed node go unreachable',
    });
    expect(terminations).toEqual([]);

    const restarted = await startLiveNode('restart-inside', 47_302, [survivor.address.toString()], {
      downAfterMs: 60_000,
    });
    const newRun = restarted.cluster.selfAddress.incarnation!;
    expect(newRun).not.toBe(oldRun);

    await awaitCondition(() => terminations.length === 1, {
      timeoutMs: 3_000, label: 'the watcher of the old run was told it is gone',
    });
    expect(terminations[0]!.addressTerminated).toBe(true);
    await awaitCondition(
      () => statusIn(survivor, crashed.address) === 'up' && incarnationIn(survivor, crashed.address) === newRun,
      { timeoutMs: 3_000, label: 'the new run is up in the survivor\'s view' },
    );
    expectOldRunEndedBeforeTheNewRunJoined(aboutCrashed, oldRun, newRun);
  }, 15_000);

  test('under auto-down = off, a parked peer that restarts: the old run\'s watchers get Terminated', async () => {
    // The opt-out parks the crashed run for good; its restart is the one event
    // that can end it without an operator, so the restart must say so.
    const { survivor, crashed, terminations, aboutCrashed } = await watchedPair('restart-parked', 47_311, {
      downAfterMs: 400, autoDown: false,
    });
    const oldRun = crashed.cluster.selfAddress.incarnation!;

    await crash(crashed);
    await awaitCondition(
      () => survivor.log.records.some((record) =>
        record.level === 'warn' && record.message.includes('parked at unreachable')
        && record.message.includes(crashed.address.toString())),
      { timeoutMs: 3_000, label: 'the survivor parked the crashed node past down-after' },
    );
    expect(statusIn(survivor, crashed.address)).toBe('unreachable');
    expect(terminations).toEqual([]);
    expect(aboutCrashed.map((entry) => entry.event)).toEqual(['MemberUnreachable']);

    const restarted = await startLiveNode('restart-parked', 47_312, [survivor.address.toString()], {
      downAfterMs: 400, autoDown: false,
    });
    const newRun = restarted.cluster.selfAddress.incarnation!;

    await awaitCondition(() => terminations.length === 1, {
      timeoutMs: 3_000, label: 'the watcher of the parked run was told it is gone',
    });
    expect(terminations[0]!.addressTerminated).toBe(true);
    await awaitCondition(
      () => statusIn(survivor, crashed.address) === 'up' && incarnationIn(survivor, crashed.address) === newRun,
      { timeoutMs: 3_000, label: 'the new run is up in the survivor\'s view' },
    );
    expectOldRunEndedBeforeTheNewRunJoined(aboutCrashed, oldRun, newRun);
  }, 15_000);
});

/* ------------------- one node, frames through handleWire ------------------- */

const SELF_HOST = '10.0.149.1';
const PEER_HOST = '10.0.149.2';
const STANDING_PEER_HOST = '10.0.149.3';

/** Past the fixture's `unreachable-after` (2 s) and short of its `down-after` (60 s). */
const SILENT_BUT_NOT_DOWN_MS = 3_000;

/** The private surface these cases drive — the wire entry point and the detector tick, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
  failureDetectionTick(): void;
  readonly failureDetector: FailureDetectorLike;
  readonly members: Map<string, Member>;
}

const internals = (cluster: Cluster): ClusterInternals => cluster as unknown as ClusterInternals;

type FedNode = { readonly system: ActorSystem; readonly cluster: Cluster };

let fed: FedNode[] = [];

afterEach(async () => {
  for (const node of fed) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  fed = [];
});

/** A one-node cluster whose periodic tasks all sit past the test's lifetime. */
async function startFedNode(systemName: string, port: number): Promise<FedNode> {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  const systemOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 2_000, downAfterMs: 60_000 })
    .withGossipIntervalMs(60_000)
    .withPublishStatsIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  const cluster = await Cluster.join(system, clusterOptions);
  const node: FedNode = { system, cluster };
  fed.push(node);
  return node;
}

/** One run of the peer: the same `system@host:port`, told apart only by its incarnation. */
const peerRun = (systemName: string, port: number, incarnation?: string): NodeAddress =>
  new NodeAddress(systemName, PEER_HOST, port, incarnation);

/** One counter for every simulated author, so each frame out-numbers the last (#112). */
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

/** `run` gossips its own record. */
function announce(cluster: Cluster, run: NodeAddress, status: MemberStatus, version: number): void {
  gossip(cluster, run, [{ address: run.toJSON(), status, version, roles: [] }]);
}

/** A watcher on this node, watching an actor on `run`; resolves once the watch is held. */
async function watchActorOn(node: FedNode, run: NodeAddress, name: string): Promise<Terminated[]> {
  const terminations: Terminated[] = [];
  const watcher = node.system.spawn(() => new Watcher(terminations), name);
  const remote = new RemoteActorRef<'stop'>(run, `actor-ts://${run.systemName}/user/subject`, node.cluster);
  watcher.tell({ kind: 'watch', subject: remote });
  await awaitCondition(() => outboundWatchesOn(node.cluster, run) === 1, {
    timeoutMs: 2_000, label: 'the watch on the peer\'s actor is held',
  });
  return terminations;
}

describe('what the merge announces when a record replaces one of the same address (#1426)', () => {
  test('a new incarnation over a live record: the old run down and removed, then the new run joined', async () => {
    const node = await startFedNode('replace-live', 9_611);
    const firstRun = peerRun('replace-live', 9_711, 'run-1');
    const secondRun = peerRun('replace-live', 9_711, 'run-2');
    const version = Date.now() - 60_000;
    announce(node.cluster, firstRun, 'up', version);
    const terminations = await watchActorOn(node, firstRun, 'watcher-live');
    const about = announcementsAbout(node.cluster, firstRun);
    about.length = 0;

    announce(node.cluster, secondRun, 'joining', Date.now());

    // This node leads its cluster of one, so the frame's tail promotes the new
    // run at once — after it has joined, which is the order that matters.
    expect(about).toEqual([
      { event: 'MemberDown', status: 'down', incarnation: 'run-1' },
      { event: 'MemberRemoved', status: 'removed', incarnation: 'run-1' },
      { event: 'MemberJoined', status: 'joining', incarnation: 'run-2' },
      { event: 'MemberUp', status: 'up', incarnation: 'run-2' },
    ]);
    const entry = internals(node.cluster).members.get(secondRun.toString());
    expect(entry?.status).toBe('up');
    expect(entry?.address.incarnation).toBe('run-2');
    await awaitCondition(() => terminations.length === 1, {
      timeoutMs: 2_000, label: 'the watcher of the old run was told it is gone',
    });
    expect(terminations[0]!.addressTerminated).toBe(true);
  });

  test('a reconnect of the same incarnation announces nothing and terminates no watcher', async () => {
    const node = await startFedNode('replace-reconnect', 9_612);
    const run = peerRun('replace-reconnect', 9_712, 'run-1');
    const nextRun = peerRun('replace-reconnect', 9_712, 'run-2');
    announce(node.cluster, run, 'up', Date.now() - 60_000);
    const terminations = await watchActorOn(node, run, 'watcher-reconnect');

    // A blip: the detector holds the run unreachable for a while.
    internals(node.cluster).failureDetector.heardFrom(run, Date.now() - SILENT_BUT_NOT_DOWN_MS);
    internals(node.cluster).failureDetectionTick();
    expect(internals(node.cluster).members.get(run.toString())?.status).toBe('unreachable');
    const about = announcementsAbout(node.cluster, run);
    about.length = 0;

    // The same run speaks again, with its record restamped — what its gossip
    // carries once it is heard from after the blip.
    announce(node.cluster, run, 'up', Date.now());

    expect(about.map((entry) => entry.event)).toEqual(['MemberUp']);
    expect(about.every((entry) => entry.incarnation === 'run-1')).toBe(true);
    // An absence by ordering rather than by a wait: a restart behind the
    // reconnect produces exactly one `Terminated`, so any the reconnect had
    // caused would be in front of it.
    announce(node.cluster, nextRun, 'joining', Date.now() + 1_000);
    await awaitCondition(() => terminations.length >= 1, {
      timeoutMs: 2_000, label: 'the restart behind the reconnect terminated the watcher',
    });
    expect(terminations).toHaveLength(1);
  });

  test('a new incarnation learnt from a third party is announced the same way', async () => {
    // Gossip is epidemic, so most survivors hear of a restart from a peer that
    // heard of it first; the old run's watchers there are owed the same news.
    const node = await startFedNode('replace-relayed', 9_613);
    const standing = new NodeAddress('replace-relayed', STANDING_PEER_HOST, 9_813, 'standing');
    announce(node.cluster, standing, 'up', Date.now() - 60_000);
    const firstRun = peerRun('replace-relayed', 9_713, 'run-1');
    const secondRun = peerRun('replace-relayed', 9_713, 'run-2');
    announce(node.cluster, firstRun, 'up', Date.now() - 60_000);
    const about = announcementsAbout(node.cluster, firstRun);
    about.length = 0;

    gossip(node.cluster, standing, [{ address: secondRun.toJSON(), status: 'up', version: Date.now(), roles: [] }]);

    expect(about.map((entry) => `${entry.event}:${entry.incarnation}`)).toEqual([
      'MemberDown:run-1', 'MemberRemoved:run-1', 'MemberJoined:run-2', 'MemberUp:run-2',
    ]);
  });

  test('records without an incarnation keep the silent replacement — an older peer cannot be told from a reconnect', async () => {
    const node = await startFedNode('replace-no-incarnation', 9_614);
    const bare = peerRun('replace-no-incarnation', 9_714);
    announce(node.cluster, bare, 'up', Date.now() - 60_000);
    const terminations = await watchActorOn(node, bare, 'watcher-bare');
    const about = announcementsAbout(node.cluster, bare);
    about.length = 0;

    // What a restart of a peer from before the field looks like — a fresh
    // `joining` record at a fresh version — and equally what a relay of such
    // a peer's own reconnect can look like.
    announce(node.cluster, bare, 'joining', Date.now());

    expect(about.map((entry) => entry.event)).not.toContain('MemberDown');
    expect(about.map((entry) => entry.event)).not.toContain('MemberRemoved');
    // Ordered against a removal that does terminate the watcher: an operator's
    // down, after which exactly one `Terminated` exists.
    expect(node.cluster.down(bare)).toBe(true);
    await awaitCondition(() => terminations.length >= 1, {
      timeoutMs: 2_000, label: 'the operator\'s down terminated the watcher',
    });
    expect(terminations).toHaveLength(1);
  });

  test('a record whose incarnation a relay stripped keeps the silent replacement too', async () => {
    // The stored record names run-1, the incoming one names nothing: an older
    // relay dropped the field, so whether it is run-1 again or a restart is not
    // in the frame.  Ending run-1 on that guess would terminate live watches.
    const node = await startFedNode('replace-stripped', 9_615);
    const standing = new NodeAddress('replace-stripped', STANDING_PEER_HOST, 9_815, 'standing');
    announce(node.cluster, standing, 'up', Date.now() - 60_000);
    const run = peerRun('replace-stripped', 9_715, 'run-1');
    announce(node.cluster, run, 'up', Date.now() - 60_000);
    const about = announcementsAbout(node.cluster, run);
    about.length = 0;

    const stripped = peerRun('replace-stripped', 9_715);
    gossip(node.cluster, standing, [{ address: stripped.toJSON(), status: 'up', version: Date.now(), roles: [] }]);

    expect(about.map((entry) => entry.event)).toEqual([]);
    expect(internals(node.cluster).members.get(run.toString())?.status).toBe('up');
  });
});
