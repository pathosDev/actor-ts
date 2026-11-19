/**
 * #994 — the membership transitions an operator needs are logged at `info`,
 * the shipped level, and each exactly once per edge.
 *
 * They were all `debug`, so a stock deployment recorded nothing when a peer
 * went unreachable, was parked for the downing provider, left, or when the
 * leader moved — the one class of event someone reads during a partition.
 * Turning on `debug` instead also turns on per-round gossip and per-tick
 * detector chatter, so these lines must also not repeat per tick: a peer that
 * stays silent for forty ticks is one `unreachable` line, not forty.
 *
 * Driven ticks rather than timers, the seam `FailureDetectorAutoDown.test.ts`
 * uses: the last sign of life is back-dated and `failureDetectionTick` is
 * called directly.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { DowningProvider } from '../../../src/cluster/downing/index.js';
import type { FailureDetectorLike } from '../../../src/cluster/FailureDetector.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { LeaveMessage, MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { RecordingLogger, type RecordedLog } from '../../util/RecordingLogger.js';

const SELF_HOST = '10.0.195.5';
/** Sorts above self, so a peer on it never takes the leadership. */
const PEER_HOST = '10.0.195.9';
/** Sorts below self, so a peer on it becomes the leader once `up`. */
const LOWER_PEER_HOST = '10.0.195.1';

const SILENT_PAST_UNREACHABLE_MS = 3_000;
const SILENT_PAST_DOWN_MS = 60_000;
const HELD_TICKS = 40;

const NEVER_DECIDES: DowningProvider = { decide: () => new Set<string>() };

interface ClusterInternals {
  mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void;
  failureDetectionTick(): void;
  onLeave(from: NodeAddress, message: LeaveMessage): void;
  readonly failureDetector: FailureDetectorLike;
}

const internals = (cluster: Cluster): ClusterInternals => cluster as unknown as ClusterInternals;

type NodeHandle = { readonly system: ActorSystem; readonly cluster: Cluster; readonly log: RecordingLogger };

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

async function startNode(systemName: string, port: number, downing?: DowningProvider): Promise<NodeHandle> {
  const log = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(log)
    .withLogLevel(LogLevel.Debug);
  const system = ActorSystem.create(systemName, systemOptions);
  const address = new NodeAddress(systemName, SELF_HOST, port);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 2_000, downAfterMs: 5_000 })
    .withGossipIntervalMs(60_000)
    .withPublishStatsIntervalMs(60_000)
    .withTombstonePruneIntervalMs(60_000);
  if (downing !== undefined) clusterOptions.withDowning(downing);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, log };
  nodes.push(node);
  return node;
}

function gossipSelfRecord(cluster: Cluster, peer: NodeAddress, status: MemberStatus): void {
  internals(cluster).mergeMember(peer, 'up', { address: peer.toJSON(), status, version: Date.now(), roles: [] });
}

function lastHeardFrom(cluster: Cluster, peer: NodeAddress, agoMs: number): void {
  internals(cluster).failureDetector.heardFrom(peer, Date.now() - agoMs);
}

function tick(cluster: Cluster, times = 1): void {
  for (let round = 0; round < times; round++) internals(cluster).failureDetectionTick();
}

function linesAbout(log: RecordingLogger, peer: NodeAddress, phrase: string): ReadonlyArray<RecordedLog> {
  return log.records.filter((record) => record.message.includes(peer.toString()) && record.message.includes(phrase));
}

describe('membership transitions are logged at info, once per edge (#994)', () => {
  test('a peer going unreachable, and coming back, is one info line each', async () => {
    const node = await startNode('transition-unreachable', 19_501);
    const peer = new NodeAddress('transition-unreachable', PEER_HOST, 19_502);
    gossipSelfRecord(node.cluster, peer, 'up');
    lastHeardFrom(node.cluster, peer, 0);
    tick(node.cluster);

    lastHeardFrom(node.cluster, peer, SILENT_PAST_UNREACHABLE_MS);
    tick(node.cluster, HELD_TICKS);
    expect(linesAbout(node.log, peer, 'marked unreachable').map((record) => record.level)).toEqual(['info']);
    expect(linesAbout(node.log, peer, 'marked unreachable')[0]!.message).toContain('failure detector');

    lastHeardFrom(node.cluster, peer, 0);
    tick(node.cluster, HELD_TICKS);
    expect(linesAbout(node.log, peer, 'marked reachable').map((record) => record.level)).toEqual(['info']);
  });

  test('a peer parked for the downing provider is one info line, however long it stays parked', async () => {
    const node = await startNode('transition-held', 19_511, NEVER_DECIDES);
    const peer = new NodeAddress('transition-held', PEER_HOST, 19_512);
    gossipSelfRecord(node.cluster, peer, 'up');

    lastHeardFrom(node.cluster, peer, SILENT_PAST_DOWN_MS);
    tick(node.cluster, HELD_TICKS);
    expect(linesAbout(node.log, peer, 'parked at unreachable').map((record) => record.level)).toEqual(['info']);
    expect(linesAbout(node.log, peer, 'parked at unreachable')[0]!.message).toContain('downing provider');
  });

  test('a peer\'s graceful leave is an info line', async () => {
    const node = await startNode('transition-leave', 19_521);
    const peer = new NodeAddress('transition-leave', PEER_HOST, 19_522);
    gossipSelfRecord(node.cluster, peer, 'up');

    internals(node.cluster).onLeave(peer, { kind: 'leave', node: peer.toJSON() });
    expect(linesAbout(node.log, peer, 'left the cluster').map((record) => record.level)).toEqual(['info']);
  });

  test('a leader change is an info line naming both leaders', async () => {
    const node = await startNode('transition-leader', 19_531);
    const peer = new NodeAddress('transition-leader', LOWER_PEER_HOST, 19_532);
    gossipSelfRecord(node.cluster, peer, 'up');

    const changes = node.log.records.filter((record) => record.message.includes('leader changed'));
    expect(changes.length).toBeGreaterThan(0);
    const last = changes[changes.length - 1]!;
    expect(last.level).toBe('info');
    expect(last.message).toContain(node.cluster.selfAddress.toString());
    expect(last.message).toContain(peer.toString());
  });

  test('per-round gossip receipt stays at debug', async () => {
    // The tier that must stay below the transitions, or raising them would
    // bring nothing: at debug they drown in exactly this.
    const node = await startNode('transition-gossip', 19_541);
    const peer = new NodeAddress('transition-gossip', PEER_HOST, 19_542);
    const handleWire = (node.cluster as unknown as {
      handleWire(from: NodeAddress, message: unknown): void;
    }).handleWire.bind(node.cluster);
    handleWire(peer, {
      kind: 'gossip', from: peer.toJSON(), sequence: Date.now(),
      members: [{ address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] }],
    });
    const receipts = node.log.records.filter((record) => record.message.startsWith(`gossip from ${peer}`));
    expect(receipts.map((record) => record.level)).toEqual(['debug']);
  });
});
