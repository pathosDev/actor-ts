/**
 * #1103 — the failure detector grew one entry per claimed connection identity.
 *
 * `handleWire` credited liveness for every frame before dispatching it, and the
 * heartbeat handler added a sample for every heartbeat frame.  Both create a
 * detector entry for an address the detector has never seen, and only a
 * member's removal ever forgets one.  Without mTLS the connection identity is
 * whatever the peer's `hello` said, so a single peer could mint entries at will
 * — 500 frames under 500 names left 502 entries beside a member map held at 3
 * by `maxMembers` (#138).
 *
 * Liveness now reaches the detector only for a peer this node watches: a live
 * member, or a configured seed.  The second half of the file is the acceptance
 * criterion the obvious fix put at risk: a node that is joining, or a seed that
 * answers late, must not read `unreachable` for want of the frames that came
 * before it was a member.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { MemberUnreachable, type ClusterEvent } from '../../../src/cluster/ClusterEvents.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { FailureDetectorImplementation, FailureDetectorLike } from '../../../src/cluster/FailureDetector.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { MemberData, WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

const HOST = '10.0.110.3';
const FLOOD = 500;

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

type NodeSettings = {
  readonly implementation?: FailureDetectorImplementation;
  readonly seeds?: ReadonlyArray<NodeAddress>;
  /** Timings for the join tests; the flood tests push every timer far out. */
  readonly live?: boolean;
  /**
   * Every timer far out, but a 400 ms `unreachableAfterMs` for a tick driven by
   * hand — and, for the φ detector, a 50 ms first-contact estimate with no
   * pause allowance, so that 400 ms of silence is a verdict there too.
   */
  readonly shortSilence?: boolean;
  readonly maxMembers?: number;
  /** A tombstone TTL (and retention floor) short enough to prune within a test. */
  readonly tombstoneTtlMs?: number;
};

/** The private surface these tests reach through — detector and wire entry, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
  failureDetectionTick(): void;
  tombstonePruneTick(): void;
  contactSeeds(): void;
  readonly failureDetector: FailureDetectorLike;
  readonly members: Map<string, Member>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/**
 * How many peers the detector holds state for.  The two shipped detectors keep
 * it under different private names; reading it is the point of the test, and
 * the contract has no count to offer.
 */
function detectorKeys(cluster: Cluster): Set<string> {
  const detector = internals(cluster).failureDetector as unknown as {
    readonly samples?: Map<string, unknown>;
    readonly peers?: Map<string, unknown>;
  };
  const entries = detector.samples ?? detector.peers;
  if (entries === undefined) throw new Error('detector keeps its entries under an unexpected name');
  return new Set(entries.keys());
}

function detectorEntries(cluster: Cluster): number {
  return detectorKeys(cluster).size;
}

/**
 * The detector holds an entry for every live member but this node, and beyond
 * them at most for a seed that is not a tombstone.  A live member missing from
 * it reads `healthy` for good; anything else in it is state nothing reads.
 */
function expectEntriesForWatchedPeersOnly(node: NodeHandle, seeds: ReadonlyArray<NodeAddress> = []): void {
  const members = internals(node.cluster).members;
  const liveMembers = [...members.values()]
    .filter((m) => m.status !== 'removed' && !m.address.equals(node.address))
    .map((m) => m.address.toString());
  const keys = detectorKeys(node.cluster);
  for (const member of liveMembers) expect(keys.has(member)).toBe(true);
  const watchedSeeds = seeds
    .filter((seed) => members.get(seed.toString())?.status !== 'removed')
    .map((seed) => seed.toString());
  const allowed = new Set([...liveMembers, ...watchedSeeds]);
  expect([...keys].filter((key) => !allowed.has(key))).toEqual([]);
}

let nodes: NodeHandle[] = [];

async function startNode(systemName: string, port: number, settings: NodeSettings = {}): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetectorImplementation(settings.implementation ?? 'simple')
    .withSeeds((settings.seeds ?? []).map((seed) => seed.toString()));
  if (settings.live === true) {
    clusterOptions
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 400, downAfterMs: 5_000 })
      .withGossipIntervalMs(50);
  } else {
    const unreachableAfterMs = settings.shortSilence === true ? 400 : 120_000;
    clusterOptions
      .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs, downAfterMs: 240_000 })
      .withGossipIntervalMs(60_000)
      .withTombstonePruneIntervalMs(60_000);
    if (settings.shortSilence === true) {
      clusterOptions.withPhiAccrual({ expectedResponseAfterMs: 50, acceptableHeartbeatPauseMs: 0, minStdDeviationMs: 10 });
    }
  }
  if (settings.maxMembers !== undefined) clusterOptions.withMaxMembers(settings.maxMembers);
  if (settings.tombstoneTtlMs !== undefined) {
    clusterOptions
      .withTombstoneTtlMs(settings.tombstoneTtlMs)
      .withTombstoneMinRetentionMs(settings.tombstoneTtlMs);
  }
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster, address };
  nodes.push(node);
  return node;
}

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

/** A connection identity nobody configured, as a `hello` would claim it. */
function stranger(systemName: string, index: number): NodeAddress {
  return new NodeAddress(systemName, '10.0.110.99', 30_000 + index);
}

/**
 * Strictly increasing, unlike `Date.now()`: a second frame from the same peer
 * within one millisecond would otherwise be refused as a replay (#112).
 */
let gossipSequence = Date.now();

function gossipFrame(from: NodeAddress, members: ReadonlyArray<MemberData> = []): WireMessage {
  gossipSequence += 1;
  return { kind: 'gossip', from: from.toJSON(), sequence: gossipSequence, members: [...members] };
}

function heartbeatFrame(from: NodeAddress, seq: number): WireMessage {
  return { kind: 'heartbeat', from: from.toJSON(), seq, ts: Date.now() };
}

/** A record `peer` states about itself — the only claim a non-member may make. */
function selfRecord(peer: NodeAddress, status: MemberData['status'], version: number): MemberData {
  const record: MemberData = { address: peer.toJSON(), status, version, roles: [] };
  return status === 'removed' ? { ...record, removedAt: Date.now() } : record;
}

/** Every `MemberUnreachable` `observer` announces about `about`. */
function unreachableAnnouncements(observer: Cluster, about: NodeAddress): ClusterEvent[] {
  const seen: ClusterEvent[] = [];
  observer.subscribe((event) => {
    if (event instanceof MemberUnreachable && event.member.address.equals(about)) seen.push(event);
  });
  return seen;
}

function isUpAt(observer: Cluster, peer: NodeAddress): boolean {
  return observer.getMembers().some((m) => m.address.equals(peer) && m.status === 'up');
}

for (const implementation of ['simple', 'phi'] as const) {
  describe(`the detector holds entries only for watched peers — ${implementation} (#1103)`, () => {
    test('a gossip frame under each of 500 claimed names adds entries only for the members it admits', async () => {
      // A gossip frame admits its sender — capped by `maxMembers`, which is
      // #138's bound, not this one's.  What this file holds is that the
      // detector follows that map: an entry for each member admitted, none for
      // the 490 names the cap turned away.  Before the fix every name got one;
      // with only the crediting gated, the admitted members got none and read
      // `healthy` for good.
      const name = `fd-bound-gossip-${implementation}`;
      const node = await startNode(name, 9_831, { implementation, maxMembers: 10 });

      for (let i = 0; i < FLOOD; i++) {
        internals(node.cluster).handleWire(stranger(name, i), gossipFrame(stranger(name, i)));
      }

      expect(detectorEntries(node.cluster)).toBe(9);
      expectEntriesForWatchedPeersOnly(node);
      expect(internals(node.cluster).failureDetector.lastSeen(stranger(name, FLOOD - 1)).isNone()).toBe(true);
    });

    test('a heartbeat frame under each of 500 claimed names adds no entry and no sample', async () => {
      const name = `fd-bound-heartbeat-${implementation}`;
      const node = await startNode(name, 9_832, { implementation });
      const before = detectorEntries(node.cluster);

      for (let i = 0; i < FLOOD; i++) {
        internals(node.cluster).handleWire(stranger(name, i), heartbeatFrame(stranger(name, i), i));
      }

      expect(detectorEntries(node.cluster)).toBe(before);
      expect(internals(node.cluster).failureDetector.lastSeen(stranger(name, FLOOD - 1)).isNone()).toBe(true);
    });

    test('a member is still watched, and a tombstone is not', async () => {
      const name = `fd-bound-tombstone-${implementation}`;
      const node = await startNode(name, 9_833, { implementation });
      const peer = new NodeAddress(name, '10.0.110.4', 9_834);
      const detector = internals(node.cluster).failureDetector;

      // A self-announcement is how every joiner arrives; it admits the peer.
      const joining: MemberData = { address: peer.toJSON(), status: 'joining', version: Date.now(), roles: [] };
      internals(node.cluster).handleWire(peer, gossipFrame(peer, [joining]));
      expect(internals(node.cluster).members.has(peer.toString())).toBe(true);

      // A member's frames refresh it — the half the fix must keep.  Registered
      // at admission, but never heard from as far as the φ detector is
      // concerned until a frame arrives, so `lastSeen` is what moves.
      internals(node.cluster).handleWire(peer, heartbeatFrame(peer, 1));
      expect(detector.lastSeen(peer).isSome()).toBe(true);

      expect(node.cluster.down(peer)).toBe(true);
      expect(internals(node.cluster).members.get(peer.toString())?.status).toBe('removed');
      expect(detector.lastSeen(peer).isNone()).toBe(true);

      internals(node.cluster).handleWire(peer, heartbeatFrame(peer, 2));
      internals(node.cluster).handleWire(peer, gossipFrame(peer));
      expect(detector.lastSeen(peer).isNone()).toBe(true);
      expectEntriesForWatchedPeersOnly(node);
    });
  });
}

describe('a legitimate join is not judged on frames it sent before it was a member (#1103)', () => {
  test('a joining node and its seed watch each other without a false unreachable', async () => {
    const seed = await startNode('fd-bound-join', 9_841, { live: true });
    const joiner = await startNode('fd-bound-join', 9_842, { live: true, seeds: [seed.address] });
    const atSeed = unreachableAnnouncements(seed.cluster, joiner.address);
    const atJoiner = unreachableAnnouncements(joiner.cluster, seed.address);

    await awaitCondition(
      () => isUpAt(seed.cluster, joiner.address) && isUpAt(joiner.cluster, seed.address),
      { label: 'both nodes up at both nodes', timeoutMs: 5_000 },
    );
    // The elapsed time IS the assertion: a full `unreachableAfterMs` (400 ms)
    // and then some, at a 50 ms heartbeat.  This guards the steady-state pair —
    // two members heartbeating each other stay reachable under the gated
    // crediting.  It does not tell the fix from a rule that credits members
    // only: a live seed's next frame arrives within microseconds of the one
    // that admits it and refreshes the entry either way.  The first tick after
    // a late admission is the hand-driven test below.
    await sleep(600);

    expect(atSeed).toEqual([]);
    expect(atJoiner).toEqual([]);
  }, 10_000);

  test('a seed that answers after unreachableAfterMs is not unreachable the moment it is admitted', async () => {
    // Driven by hand rather than over a live pair: a live seed sends a second
    // frame within microseconds of the first, and that frame — from a member by
    // then — refreshes the entry whatever the rule for non-members is.  What is
    // under test is the instant between the admitting frame and the next one,
    // which on the shipped 1 s cadence is a detection tick wide.
    const seedAddress = new NodeAddress('fd-bound-late-seed', HOST, 9_851);
    const joiner = await startNode('fd-bound-late-seed', 9_852, { seeds: [seedAddress], shortSilence: true });
    const atJoiner = unreachableAnnouncements(joiner.cluster, seedAddress);
    // The elapsed time IS the precondition: the seed was registered when the
    // joiner first dialled it, and has to stay silent past `unreachableAfterMs`
    // (400 ms), so that a detector ignoring its first frame finds it stale.
    await sleep(600);

    const seedRecord: MemberData = { address: seedAddress.toJSON(), status: 'up', version: Date.now(), roles: [] };
    internals(joiner.cluster).handleWire(seedAddress, gossipFrame(seedAddress, [seedRecord]));
    expect(isUpAt(joiner.cluster, seedAddress)).toBe(true);
    internals(joiner.cluster).failureDetectionTick();

    expect(isUpAt(joiner.cluster, seedAddress)).toBe(true);
    expect(atJoiner).toEqual([]);
  });
});
