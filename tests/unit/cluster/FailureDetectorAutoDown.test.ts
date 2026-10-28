/**
 * #1426 — `actor-ts.cluster.failure-detector.auto-down`: whether the failure
 * detector may remove an unreachable peer on its own word when no downing
 * provider is configured.  On by default.
 *
 * On, a peer the detector declares `down` is deleted and announced `MemberDown`
 * then `MemberRemoved`, logged at info, so a cluster keeps running down to its
 * last available node.  Off is the opt-out: the peer is parked at
 * `unreachable` — the hold a configured provider has had since #929 — and the
 * node says so once, at warn, naming the two keys and the ways out.  Both
 * detectors reach `down`, so the behavioural cases run on both.
 *
 * Driven ticks rather than timers, the seam `DowningHoldAnnouncement.test.ts`
 * uses: the detector's last sign of life is back-dated and
 * `failureDetectionTick` is called directly, so an absence is counted over a
 * known number of ticks instead of waited out.
 *
 * The switch and a provider are independent.  A configured provider decides
 * every removal and the detector only parks a peer for it, whatever the switch
 * says, so no strategy is refused because of auto-down — and none could be:
 * once `on` ships, the merged settings cannot tell the default from a
 * deliberate `on`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { MemberDown, MemberRemoved, MemberUnreachable } from '../../../src/cluster/ClusterEvents.js';
import { ClusterOptions, type ClusterOptionsBuilder } from '../../../src/cluster/ClusterOptions.js';
import type { DowningProvider } from '../../../src/cluster/downing/index.js';
import type {
  FailureDetectorImplementation,
  FailureDetectorLike,
} from '../../../src/cluster/FailureDetector.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger, type RecordedLog } from '../../util/RecordingLogger.js';

/** Self sorts below every peer, so the leader never moves and no `LeaderChanged` clouds the stream. */
const SELF_HOST = '10.0.142.1';
const PEER_HOST = '10.0.142.2';

const AUTO_DOWN_KEY = 'actor-ts.cluster.failure-detector.auto-down';
const ACTIVE_STRATEGY_KEY = 'actor-ts.cluster.split-brain-resolver.active-strategy';
const STABLE_AFTER_KEY = 'actor-ts.cluster.split-brain-resolver.stable-after';
const DOWN_ENDPOINT_KEY = 'actor-ts.management.enable-down-endpoint';

/**
 * Silence far past either detector's `down`: the simple one's `downAfterMs`
 * is 5 s here, and φ crosses its shipped down threshold a little over 4 s
 * after the last frame at the first-contact estimate pinned below.
 */
const SILENT_PAST_DOWN_MS = 60_000;

/**
 * How many `down` verdicts a parked peer is asked to survive — an absence
 * asserted over one tick says little, and this is the count a real partition
 * reaches within seconds at a test cadence.
 */
const HELD_TICKS = 40;

const IMPLEMENTATIONS: ReadonlyArray<FailureDetectorImplementation> = ['simple', 'phi'];

/** A provider that decides nothing — its presence is the subject. */
const NEVER_DECIDES: DowningProvider = { decide: () => new Set<string>() };

/** A provider that downs whatever is unreachable — so a removal under it is the provider's. */
const DOWNS_THE_UNREACHABLE: DowningProvider = { decide: (view) => new Set(view.unreachable) };

type NodeHandle = {
  readonly cluster: Cluster;
  readonly log: RecordingLogger;
};

type NodeSetup = {
  readonly implementation?: FailureDetectorImplementation;
  readonly autoDown?: boolean;
  readonly downing?: DowningProvider;
  readonly config?: Config;
  /**
   * Set the detector's thresholds, gossip and stats cadences in code — the
   * default.  `false` leaves them to the system's config, which is how the
   * HOCON-only case states that nothing about the cluster was configured in
   * code but its address and transport.
   */
  readonly cadenceInCode?: boolean;
  /** A stability window short enough for a provider to be consulted within a test. */
  readonly quickResolver?: boolean;
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

let systems: ActorSystem[] = [];
let clusters: Cluster[] = [];

afterEach(async () => {
  for (const cluster of clusters) {
    try { await cluster.leave(); } catch { /* teardown is best-effort */ }
  }
  for (const system of systems) {
    try { await system.terminate(); } catch { /* teardown is best-effort */ }
  }
  clusters = [];
  systems = [];
});

/** Options for a one-node cluster on an in-memory transport — nothing is ever dialled. */
function lonelyNode(systemName: string, port: number): ClusterOptionsBuilder {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  return ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address));
}

/**
 * The cadences {@link startNode} sets in code, as a config file states them:
 * every periodic task past the test's lifetime, and the detector's two
 * thresholds at their shipped values.
 */
const CADENCE_HOCON = `
  actor-ts.cluster.gossip-interval = 60s
  actor-ts.cluster.publish-stats-interval = 60s
  actor-ts.cluster.tombstone.prune-interval = 60s
  actor-ts.cluster.failure-detector.heartbeat-interval = 60s
  actor-ts.cluster.failure-detector.unreachable-after = 2s
  actor-ts.cluster.failure-detector.down-after = 5s
  actor-ts.cluster.failure-detector.phi.expected-response-after = 500ms
`;

/**
 * A one-node cluster whose periodic tasks all sit past the test's lifetime,
 * so the only detection tick that runs is the one a test calls, with every
 * log line recorded.
 *
 * The φ estimate is pinned to 500 ms: under `auto` it would follow the
 * minute-long heartbeat interval that keeps the timers quiet, and a peer
 * would then need minutes of silence to look suspicious.
 */
async function startNode(systemName: string, port: number, setup: NodeSetup = {}): Promise<NodeHandle> {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withLogLevel(LogLevel.Debug);
  if (setup.config !== undefined) systemOptions.withConfig(setup.config);
  const system = ActorSystem.create(systemName, systemOptions);
  systems.push(system);
  const clusterOptions = lonelyNode(systemName, port);
  if (setup.cadenceInCode !== false) {
    clusterOptions
      .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 2_000, downAfterMs: 5_000 })
      .withPhiAccrual({ expectedResponseAfterMs: 500 })
      .withGossipIntervalMs(60_000)
      .withPublishStatsIntervalMs(60_000)
      .withTombstonePruneIntervalMs(60_000);
  }
  if (setup.implementation !== undefined) {
    clusterOptions.withFailureDetectorImplementation(setup.implementation);
  }
  if (setup.autoDown !== undefined) clusterOptions.withFailureDetectorAutoDown(setup.autoDown);
  if (setup.downing !== undefined) clusterOptions.withDowning(setup.downing);
  if (setup.quickResolver === true) clusterOptions.withSplitBrainResolver({ stableAfterMs: 1 });
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return { cluster, log };
}

const peerAddress = (systemName: string, port: number): NodeAddress =>
  new NodeAddress(systemName, PEER_HOST, port);

/** Merge a peer's own record, as its gossip would carry it — the claim `maySpeakFor` always admits. */
function gossipSelfRecord(cluster: Cluster, peer: NodeAddress, status: MemberStatus): void {
  internals(cluster).mergeMember(peer, 'up', {
    address: peer.toJSON(), status, version: Date.now(), roles: [],
  });
}

/** Pretend the last frame from `peer` arrived `agoMs` ago. */
function lastHeardFrom(cluster: Cluster, peer: NodeAddress, agoMs: number): void {
  internals(cluster).failureDetector.heardFrom(peer, Date.now() - agoMs);
}

function tick(cluster: Cluster, times = 1): void {
  for (let round = 0; round < times; round++) internals(cluster).failureDetectionTick();
}

const statusOf = (cluster: Cluster, peer: NodeAddress): MemberStatus | undefined =>
  internals(cluster).members.get(peer.toString())?.status;

/** What a subscriber is told about membership, by address, from the moment of attaching. */
type Announcements = {
  readonly unreachable: string[];
  readonly down: string[];
  readonly removed: string[];
};

function recordFrom(cluster: Cluster): Announcements {
  const announced: Announcements = { unreachable: [], down: [], removed: [] };
  cluster.subscribe((event) => {
    if (event instanceof MemberUnreachable) announced.unreachable.push(event.member.address.toString());
    else if (event instanceof MemberDown) announced.down.push(event.member.address.toString());
    else if (event instanceof MemberRemoved) announced.removed.push(event.member.address.toString());
  }, { replayMode: 'snapshot' });
  return announced;
}

/** The parking warnings `node` logged, in order. */
function parkingWarnings(log: RecordingLogger): ReadonlyArray<RecordedLog> {
  return log.records.filter(
    (record) => record.level === 'warn' && record.message.includes('parked at unreachable'),
  );
}

/** The detector's own removal line for `peer` — the one auto-down logs at info. */
function evictionLines(log: RecordingLogger, peer: NodeAddress): ReadonlyArray<RecordedLog> {
  return log.records.filter(
    (record) => record.message.includes(peer.toString()) && record.message.includes('auto-down removes'),
  );
}

describe('nothing configured — the shipped default removes the peer (#1426)', () => {
  // No auto-down key in any file, no `withFailureDetectorAutoDown`, no
  // provider: what a deployment gets that never heard of the switch.  An
  // n-node cluster has to keep running with one node left, so the survivor
  // removes the crashed peer and takes over what it hosted.
  IMPLEMENTATIONS.forEach((implementation, index) => {
    test(`${implementation}, configured in code: past down-after the peer is announced down, deleted, and logged at info`, async () => {
      const node = await startNode(`default-${implementation}`, 9_431 + index, { implementation });
      const peer = peerAddress(`default-${implementation}`, 9_531 + index);
      gossipSelfRecord(node.cluster, peer, 'up');
      const announced = recordFrom(node.cluster);

      lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
      tick(node.cluster);

      expect(node.cluster.getMembers().some((member) => member.address.equals(peer))).toBe(false);
      expect(internals(node.cluster).members.has(peer.toString())).toBe(false);
      expect(announced.down).toEqual([peer.toString()]);
      expect(announced.removed).toEqual([peer.toString()]);
      // A membership change nobody ordered, so it is the line an operator
      // reads afterwards — and it is not the parking warning.
      expect(evictionLines(node.log, peer).map((record) => record.level)).toEqual(['info']);
      expect(parkingWarnings(node.log)).toEqual([]);
    });
  });

  test('configured in HOCON: the cadences from the file and no auto-down key — the peer is removed', async () => {
    // Everything the cluster is tuned with comes from the config layers; code
    // names only the address and the in-memory transport, which no file can.
    const node = await startNode('default-hocon', 9_433, {
      config: Config.parseString(CADENCE_HOCON),
      cadenceInCode: false,
    });
    const peer = peerAddress('default-hocon', 9_533);
    gossipSelfRecord(node.cluster, peer, 'up');
    const announced = recordFrom(node.cluster);

    // Non-vacuity: the detector the file configured is the one deciding — a
    // minute of silence is `down` under its 5 s, and would be nothing under a
    // default the file failed to reach.
    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    expect(internals(node.cluster).failureDetector.decide(peer)).toBe('down');
    tick(node.cluster);

    expect(internals(node.cluster).members.has(peer.toString())).toBe(false);
    expect(announced.down).toEqual([peer.toString()]);
    expect(announced.removed).toEqual([peer.toString()]);
    expect(parkingWarnings(node.log)).toEqual([]);
  });
});

describe('auto-down = off — the opt-out parks the peer (#1426)', () => {
  IMPLEMENTATIONS.forEach((implementation, index) => {
    test(`${implementation}, withFailureDetectorAutoDown(false): a peer past down-after stays a member at unreachable, announced unreachable only`, async () => {
      const node = await startNode(`park-${implementation}`, 9_441 + index, { implementation, autoDown: false });
      const peer = peerAddress(`park-${implementation}`, 9_541 + index);
      gossipSelfRecord(node.cluster, peer, 'up');
      const announced = recordFrom(node.cluster);

      lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
      tick(node.cluster, HELD_TICKS);

      // Non-vacuity first: every one of those ticks had a `down` verdict in
      // hand, so the absences below are the hold's doing, not a detector that
      // never got there.
      expect(internals(node.cluster).failureDetector.decide(peer)).toBe('down');
      expect(statusOf(node.cluster, peer)).toBe('unreachable');
      expect(announced.unreachable).toEqual([peer.toString()]);
      expect(announced.down).toEqual([]);
      expect(announced.removed).toEqual([]);
    });
  });

  test('auto-down = off in HOCON alone parks the peer', async () => {
    // No builder call: the reader, the merge in `Cluster.join` and the
    // constructor's resolution all have to carry the file's value — against
    // the shipped `on`, so a value lost on the way removes the peer.
    const node = await startNode('park-hocon', 9_443, {
      config: Config.parseString(`${AUTO_DOWN_KEY} = off`),
    });
    const peer = peerAddress('park-hocon', 9_543);
    gossipSelfRecord(node.cluster, peer, 'up');
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    tick(node.cluster, HELD_TICKS);

    expect(statusOf(node.cluster, peer)).toBe('unreachable');
    expect(announced.down).toEqual([]);
    expect(announced.removed).toEqual([]);
    expect(parkingWarnings(node.log)).toHaveLength(1);
  });

  test('an explicit withFailureDetectorAutoDown(true) beats auto-down = off in the file', async () => {
    // The precedence an operator relies on when code has to override a
    // shared file: explicit options win over HOCON.
    const node = await startNode('park-overridden', 9_444, {
      config: Config.parseString(`${AUTO_DOWN_KEY} = off`),
      autoDown: true,
    });
    const peer = peerAddress('park-overridden', 9_544);
    gossipSelfRecord(node.cluster, peer, 'up');
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    tick(node.cluster);

    expect(internals(node.cluster).members.has(peer.toString())).toBe(false);
    expect(announced.removed).toEqual([peer.toString()]);
  });

  test('one warning per parked peer, naming it, both keys and the ways out', async () => {
    const node = await startNode('park-warning', 9_445, { autoDown: false });
    const first = peerAddress('park-warning', 9_545);
    const second = peerAddress('park-warning', 9_546);
    gossipSelfRecord(node.cluster, first, 'up');
    gossipSelfRecord(node.cluster, second, 'leaving');

    lastHeardFrom(node.cluster, first, SILENT_PAST_DOWN_MS);
    lastHeardFrom(node.cluster, second, SILENT_PAST_DOWN_MS);
    tick(node.cluster, HELD_TICKS);

    // Exactly one each over forty `down` verdicts — the second peer arrives
    // unmarked (`leaving`), so it is the re-mark path that has to report it.
    const warnings = parkingWarnings(node.log);
    const peersNamed = warnings.map((warning) => [first, second]
      .filter((peer) => warning.message.includes(peer.toString()))
      .map((peer) => peer.toString()));
    expect(peersNamed).toEqual([[first.toString()], [second.toString()]]);
    for (const warning of warnings) {
      expect(warning.message).toContain(AUTO_DOWN_KEY);
      expect(warning.message).toContain(ACTIVE_STRATEGY_KEY);
      expect(warning.message).toContain('Cluster.down');
      expect(warning.message).toContain('POST /cluster/down');
      expect(warning.message).toContain(DOWN_ENDPOINT_KEY);
    }
  });

  test('a parked run that restarts and falls silent again is reported again — the warning leaves with the old run\'s entry', async () => {
    // The restart replaces the parked run's entry (#940): the old one is
    // deleted and the new one admitted.  No detection tick runs in between,
    // so nothing but the delete itself can forget that the slot was reported —
    // and a slot remembered as reported would let the new run's own parking go
    // unsaid.
    const node = await startNode('park-warning-restart', 9_447, { autoDown: false });
    const firstRun = new NodeAddress('park-warning-restart', PEER_HOST, 9_548, 'run-1');
    const secondRun = new NodeAddress('park-warning-restart', PEER_HOST, 9_548, 'run-2');
    gossipSelfRecord(node.cluster, firstRun, 'up');
    lastHeardFrom(node.cluster, firstRun, SILENT_PAST_DOWN_MS);
    tick(node.cluster);
    expect(parkingWarnings(node.log)).toHaveLength(1);

    internals(node.cluster).mergeMember(secondRun, 'unreachable', {
      address: secondRun.toJSON(), status: 'joining', version: Date.now() + 1_000, roles: [],
    });
    expect(internals(node.cluster).members.get(secondRun.toString())?.address.incarnation).toBe('run-2');
    lastHeardFrom(node.cluster, secondRun, SILENT_PAST_DOWN_MS);
    tick(node.cluster);

    expect(parkingWarnings(node.log)).toHaveLength(2);
  });

  test('a peer heard from again and silent a second time is reported a second time', async () => {
    const node = await startNode('park-warning-again', 9_446, { autoDown: false });
    const peer = peerAddress('park-warning-again', 9_547);
    gossipSelfRecord(node.cluster, peer, 'up');

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    tick(node.cluster, 3);
    lastHeardFrom(node.cluster, peer, 0);
    tick(node.cluster);
    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    tick(node.cluster, 3);

    expect(parkingWarnings(node.log)).toHaveLength(2);
  });
});

describe('a downing provider decides, whatever auto-down says (#1426)', () => {
  /**
   * Tick until `done` holds — a provider is consulted only once the view has
   * held still for `stableAfterMs`, which is wall-clock, so the ticks need
   * time between them; `awaitCondition`'s poll interval is that time.
   */
  const tickUntil = (cluster: Cluster, done: () => boolean, label: string): Promise<void> =>
    awaitCondition(() => { tick(cluster); return done(); }, { timeoutMs: 2_000, label });

  test('in code: beside auto-down on a provider starts, and one that never decides holds the crashed peer at unreachable', async () => {
    let consultedAboutPeer = 0;
    const counting: DowningProvider = {
      decide(view) {
        if (view.unreachable.size > 0) consultedAboutPeer++;
        return new Set<string>();
      },
    };
    const node = await startNode('provider-beside-on', 9_451, {
      downing: counting, autoDown: true, quickResolver: true,
    });
    const peer = peerAddress('provider-beside-on', 9_551);
    gossipSelfRecord(node.cluster, peer, 'up');
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    await tickUntil(node.cluster, () => consultedAboutPeer >= 2, 'the provider was asked about the silent peer twice');
    tick(node.cluster, HELD_TICKS);

    // The detector's `down` verdict was in hand on every one of those ticks,
    // and auto-down was on: the peer is still a member because the provider
    // owns the removal and has not ordered one.
    expect(internals(node.cluster).failureDetector.decide(peer)).toBe('down');
    expect(statusOf(node.cluster, peer)).toBe('unreachable');
    expect(announced.down).toEqual([]);
    expect(announced.removed).toEqual([]);
    expect(evictionLines(node.log, peer)).toEqual([]);
    // The parking warning is the no-provider opt-out's; a provider is deciding.
    expect(parkingWarnings(node.log)).toEqual([]);
  });

  test('under the shipped default a provider in code decides, and the removal is its tombstone, not the detector\'s delete', async () => {
    const node = await startNode('provider-default', 9_452, {
      downing: DOWNS_THE_UNREACHABLE, quickResolver: true,
    });
    const peer = peerAddress('provider-default', 9_552);
    gossipSelfRecord(node.cluster, peer, 'up');
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    await tickUntil(node.cluster, () => statusOf(node.cluster, peer) === 'removed', 'the provider downed the silent peer');

    // A provider's decision tombstones; the detector's own route deletes the
    // entry outright.  A present `removed` record is therefore the provider's
    // removal, and an absent one would have been auto-down acting beside it.
    expect(statusOf(node.cluster, peer)).toBe('removed');
    expect(announced.down).toEqual([peer.toString()]);
    expect(announced.removed).toEqual([peer.toString()]);
    expect(evictionLines(node.log, peer)).toEqual([]);
  });

  test('in HOCON: a named strategy beside auto-down = on starts and decides', async () => {
    // The pair a config file meets most often — and the one that used to be
    // refused at `Cluster.join`.  Three members, so keep-majority has a
    // majority to keep: self and a peer that keeps talking, and one that falls
    // silent.
    const config = Config.parseString(`
      ${ACTIVE_STRATEGY_KEY} = keep-majority
      ${AUTO_DOWN_KEY} = on
      ${STABLE_AFTER_KEY} = 1ms
    `);
    const node = await startNode('strategy-beside-on', 9_453, { config });
    const talking = peerAddress('strategy-beside-on', 9_553);
    const silent = peerAddress('strategy-beside-on', 9_554);
    gossipSelfRecord(node.cluster, talking, 'up');
    gossipSelfRecord(node.cluster, silent, 'up');
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, silent, SILENT_PAST_DOWN_MS);
    await tickUntil(node.cluster, () => {
      lastHeardFrom(node.cluster, talking, 0);
      return statusOf(node.cluster, silent) === 'removed';
    }, 'keep-majority downed the silent peer');

    expect(statusOf(node.cluster, talking)).toBe('up');
    expect(announced.removed).toEqual([silent.toString()]);
    expect(evictionLines(node.log, silent)).toEqual([]);
  });

  test('with a provider configured the hold warns about nothing — the provider decides', async () => {
    const node = await startNode('park-provider', 9_454, { downing: NEVER_DECIDES });
    const peer = peerAddress('park-provider', 9_555);
    gossipSelfRecord(node.cluster, peer, 'up');

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    tick(node.cluster, HELD_TICKS);

    expect(statusOf(node.cluster, peer)).toBe('unreachable');
    expect(parkingWarnings(node.log)).toEqual([]);
  });
});
