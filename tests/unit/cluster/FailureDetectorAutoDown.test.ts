/**
 * #1426 — `actor-ts.cluster.failure-detector.auto-down`: whether the failure
 * detector may remove an unreachable peer on its own word when no downing
 * provider is configured.  Off by default.
 *
 * Off, a peer the detector declares `down` is parked at `unreachable` — the
 * hold a configured provider has had since #929 — and the node says so once,
 * at warn, naming the two keys and the ways out.  On, the detector removes the
 * peer as every release before #1426 did, now logged at info.  Both detectors
 * reach `down`, so the behavioural cases run on both.
 *
 * Driven ticks rather than timers, the seam `DowningHoldAnnouncement.test.ts`
 * uses: the detector's last sign of life is back-dated and
 * `failureDetectionTick` is called directly, so an absence is counted over a
 * known number of ticks instead of waited out.
 *
 * The switch and a provider are mutually exclusive.  Since #929 a configured
 * provider owns every removal and the detector only parks, so `auto-down = on`
 * beside one would be a switch that silently does nothing — while the operator
 * who wrote it meant the detector to remove.  `Cluster.join` refuses the pair,
 * whichever layer each half came from, before anything is bound.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
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
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { RecordingLogger, type RecordedLog } from '../../util/RecordingLogger.js';

/** Self sorts below every peer, so the leader never moves and no `LeaderChanged` clouds the stream. */
const SELF_HOST = '10.0.142.1';
const PEER_HOST = '10.0.142.2';

const AUTO_DOWN_KEY = 'actor-ts.cluster.failure-detector.auto-down';
const ACTIVE_STRATEGY_KEY = 'actor-ts.cluster.split-brain-resolver.active-strategy';
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

type NodeHandle = {
  readonly cluster: Cluster;
  readonly log: RecordingLogger;
};

type NodeSetup = {
  readonly implementation?: FailureDetectorImplementation;
  readonly autoDown?: boolean;
  readonly downing?: DowningProvider;
  readonly config?: Config;
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

function quietSystem(systemName: string, config?: Config): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config !== undefined) systemOptions.withConfig(config);
  const system = ActorSystem.create(systemName, systemOptions);
  systems.push(system);
  return system;
}

/** Options for a one-node cluster on an in-memory transport — nothing is ever dialled. */
function lonelyNode(systemName: string, port: number): ClusterOptionsBuilder {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  return ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address));
}

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
  const clusterOptions = lonelyNode(systemName, port)
    .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 2_000, downAfterMs: 5_000 })
    .withPhiAccrual({ expectedResponseAfterMs: 500 })
    .withGossipIntervalMs(60_000)
    .withPublishStatsIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  if (setup.implementation !== undefined) {
    clusterOptions.withFailureDetectorImplementation(setup.implementation);
  }
  if (setup.autoDown !== undefined) clusterOptions.withFailureDetectorAutoDown(setup.autoDown);
  if (setup.downing !== undefined) clusterOptions.withDowning(setup.downing);
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

/** The warnings the default's parking writes — one per parked peer is the claim. */
function parkingWarnings(log: RecordingLogger): ReadonlyArray<RecordedLog> {
  return log.records.filter(
    (record) => record.level === 'warn' && record.message.includes('parked at unreachable'),
  );
}

describe('no provider, auto-down off — the default parks the peer (#1426)', () => {
  IMPLEMENTATIONS.forEach((implementation, index) => {
    test(`${implementation}: a peer past down-after stays a member at unreachable, announced unreachable only`, async () => {
      const node = await startNode(`park-${implementation}`, 9_431 + index, { implementation });
      const peer = peerAddress(`park-${implementation}`, 9_531 + index);
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

  test('one warning per parked peer, naming it, both keys and the ways out', async () => {
    const node = await startNode('park-warning', 9_441);
    const first = peerAddress('park-warning', 9_541);
    const second = peerAddress('park-warning', 9_542);
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

  test('a peer heard from again and silent a second time is reported a second time', async () => {
    const node = await startNode('park-warning-again', 9_442);
    const peer = peerAddress('park-warning-again', 9_543);
    gossipSelfRecord(node.cluster, peer, 'up');

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    tick(node.cluster, 3);
    lastHeardFrom(node.cluster, peer, 0);
    tick(node.cluster);
    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    tick(node.cluster, 3);

    expect(parkingWarnings(node.log)).toHaveLength(2);
  });

  test('with a provider configured the hold warns about nothing — the provider decides', async () => {
    const node = await startNode('park-provider', 9_443, { downing: NEVER_DECIDES });
    const peer = peerAddress('park-provider', 9_544);
    gossipSelfRecord(node.cluster, peer, 'up');

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    tick(node.cluster, HELD_TICKS);

    expect(statusOf(node.cluster, peer)).toBe('unreachable');
    expect(parkingWarnings(node.log)).toEqual([]);
  });
});

describe('auto-down on — the opt-in route removes the peer (#1426)', () => {
  IMPLEMENTATIONS.forEach((implementation, index) => {
    test(`${implementation}: announced down, deleted, MemberRemoved — and logged at info`, async () => {
      const node = await startNode(`auto-down-${implementation}`, 9_451 + index, {
        implementation,
        autoDown: true,
      });
      const peer = peerAddress(`auto-down-${implementation}`, 9_551 + index);
      gossipSelfRecord(node.cluster, peer, 'up');
      const announced = recordFrom(node.cluster);

      lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
      tick(node.cluster);

      expect(internals(node.cluster).members.has(peer.toString())).toBe(false);
      expect(announced.down).toEqual([peer.toString()]);
      expect(announced.removed).toEqual([peer.toString()]);
      // A membership change nobody ordered, so it is the line an operator
      // reads afterwards — and it is not the parking warning.
      const eviction = node.log.records.filter(
        (record) => record.message.includes(peer.toString()) && record.message.includes('auto-down removes'),
      );
      expect(eviction.map((record) => record.level)).toEqual(['info']);
      expect(parkingWarnings(node.log)).toEqual([]);
    });
  });

  test('auto-down = on in HOCON alone reaches the arm', async () => {
    // No builder call: the reader, the merge in `Cluster.join` and the
    // constructor's resolution all have to carry the file's value.
    const node = await startNode('auto-down-hocon', 9_461, {
      config: Config.parseString(`${AUTO_DOWN_KEY} = on`),
    });
    const peer = peerAddress('auto-down-hocon', 9_561);
    gossipSelfRecord(node.cluster, peer, 'up');
    const announced = recordFrom(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    tick(node.cluster);

    expect(internals(node.cluster).members.has(peer.toString())).toBe(false);
    expect(announced.removed).toEqual([peer.toString()]);
  });
});

/** The error `Cluster.join` threw, or `undefined` when it started a cluster. */
async function joinError(system: ActorSystem, options: ClusterOptionsBuilder): Promise<unknown> {
  try {
    clusters.push(await Cluster.join(system, options));
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectRefusalNamingBoth(error: unknown): void {
  expect(error).toBeInstanceOf(OptionsError);
  const refusal = error as OptionsError;
  expect(refusal.field).toBe('failureDetectorAutoDown');
  // Both halves, by every name an operator may have used for them: the two
  // fields a caller sets in code and the two keys a config file sets.
  expect(refusal.message).toContain('failureDetectorAutoDown');
  expect(refusal.message).toContain('downing');
  expect(refusal.message).toContain(AUTO_DOWN_KEY);
  expect(refusal.message).toContain(ACTIVE_STRATEGY_KEY);
}

describe('auto-down beside a downing provider is refused at Cluster.join (#1426)', () => {
  test('in code: a provider and auto-down on', async () => {
    const system = quietSystem('auto-down-refused-code');
    const clusterOptions = lonelyNode('auto-down-refused-code', 9_421)
      .withDowning(NEVER_DECIDES)
      .withFailureDetectorAutoDown(true);

    expectRefusalNamingBoth(await joinError(system, clusterOptions));
  });

  test('in HOCON: a named strategy and auto-down = on', async () => {
    // Both halves from the file, which is where an operator meets them: the
    // validator sees the merged settings, so the strategy `readDowningFromConfig`
    // built counts as a configured provider exactly like `withDowning`.
    const config = Config.parseString(`
      ${ACTIVE_STRATEGY_KEY} = keep-majority
      ${AUTO_DOWN_KEY} = on
    `);
    const system = quietSystem('auto-down-refused-hocon', config);
    const clusterOptions = lonelyNode('auto-down-refused-hocon', 9_422);

    expectRefusalNamingBoth(await joinError(system, clusterOptions));
  });

  test('either half alone is accepted', async () => {
    // The refusal is about the pair: auto-down without a provider is the
    // documented opt-in, and a provider with auto-down off is the default.
    const withoutProvider = quietSystem('auto-down-alone');
    const autoDownOptions = lonelyNode('auto-down-alone', 9_423).withFailureDetectorAutoDown(true);
    expect(await joinError(withoutProvider, autoDownOptions)).toBeUndefined();

    const withProvider = quietSystem('auto-down-provider-alone');
    const providerOptions = lonelyNode('auto-down-provider-alone', 9_424)
      .withDowning(NEVER_DECIDES)
      .withFailureDetectorAutoDown(false);
    expect(await joinError(withProvider, providerOptions)).toBeUndefined();
  });
});
