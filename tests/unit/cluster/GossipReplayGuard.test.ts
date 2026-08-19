/**
 * #112 — the mechanics of the per-sender gossip frame counter.
 *
 * The end-to-end exploit (replaying a downed member's own record to bring it
 * back) lives in `tests/multi-node/cluster-security.test.ts`.  What is pinned
 * here is everything a replay guard can get wrong on its own:
 *
 * - it must **refuse the whole frame**, and say so to an operator through the
 *   existing refusal counter rather than a new metric series (#131);
 * - a sequence too far ahead of the receiver's clock to be plausible must be
 *   **refused**, not merged.  It shipped the other way round — admitted, but
 *   never adopted as the mark — on the argument that a frame numbered
 *   `Number.MAX_SAFE_INTEGER` cannot be a recording of a real frame.  Only the
 *   *sequence* is fabricated in that attack: the `members` array is still the
 *   recording, so the same captured frame merged on every delivery, without
 *   limit, against a warm receiver with a live sender (#940);
 * - it must not become a **new denial of service** either.  Refusing an
 *   implausible frame leaves the mark where the last plausible frame put it, so
 *   the real node's next frame still lands — the exploit #114 closed on
 *   `version` must not reappear one field to the left;
 * - the mark must not **outlive its member**, or the address's next
 *   incarnation — whose counter starts from its own clock — would be refused.
 *
 * The last block pins the **boundary** instead: the guard holds for a sender
 * this receiver has heard a frame from, and a mark exists for nobody else.
 * Those two counterfactuals are what the standing texts got wrong — they name
 * eviction of the sender as the one disarming condition — and neither is
 * closable without a **required** incarnation identity on the wire (#940, #823).
 * `tests/unit/cluster/GossipReplayBoundDocumented.test.ts` holds the prose to
 * what they measure.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { GossipMessage, MemberData } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { MetricsExtensionId, metricsOf } from '../../../src/metrics/MetricsExtension.js';

const MINUTE_MS = 60 * 1_000;

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
};

type DetectorTiming = {
  readonly heartbeatIntervalMs: number;
  readonly unreachableAfterMs: number;
  readonly downAfterMs: number;
};

/** Far-out timers by default: the tests drive the merge by injecting frames. */
const IDLE_DETECTOR: DetectorTiming = {
  heartbeatIntervalMs: 60_000,
  unreachableAfterMs: 120_000,
  downAfterMs: 240_000,
};

async function startNode(
  systemName: string,
  port: number,
  detector: DetectorTiming = IDLE_DETECTOR,
): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, '10.0.112.1', port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector(detector)
    .withGossipIntervalMs(60_000);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address };
}

/** The private surface these tests reach through — merge internals, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage): void;
  readonly members: Map<string, Member>;
  readonly acceptedGossipSequences: Map<string, number>;
  readonly gossipSequence: number;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/** Deliver a gossip frame with an explicit sequence, as a peer would. */
function gossipFrom(
  cluster: Cluster, from: NodeAddress, sequence: number, members: MemberData[],
): void {
  internals(cluster).handleWire(from, {
    kind: 'gossip', from: from.toJSON(), sequence, members,
  });
}

/** A peer's self-announcement — the one claim `maySpeakFor` never refuses. */
function selfRecord(peer: NodeAddress): MemberData {
  return { address: peer.toJSON(), status: 'up', version: Date.now(), roles: [] };
}

function markFor(cluster: Cluster, address: NodeAddress): number | undefined {
  return internals(cluster).acceptedGossipSequences.get(address.toString());
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('the frame a peer already sent is refused whole', () => {
  test('a repeated sequence drops every record in the frame', async () => {
    const node = await startNode('replay-whole', 9_401);
    nodes.push(node);
    const peer = new NodeAddress('replay-whole', '10.0.112.2', 9_490);
    const subject = new NodeAddress('replay-whole', '10.0.112.3', 9_491);

    const sequence = Date.now();
    gossipFrom(node.cluster, peer, sequence, [selfRecord(peer)]);
    expect(markFor(node.cluster, peer)).toBe(sequence);

    // Same number, different payload: the frame is refused before a single
    // record is looked at, so the subject never appears.
    gossipFrom(node.cluster, peer, sequence, [
      { address: subject.toJSON(), status: 'up', version: Date.now(), roles: ['payments'] },
    ]);

    expect(internals(node.cluster).members.has(subject.toString())).toBe(false);
  });

  test('an increasing sequence from the same peer merges every time', async () => {
    // The regression side: the guard refuses a repeat, not the peer.
    const node = await startNode('replay-progress', 9_402);
    nodes.push(node);
    const peer = new NodeAddress('replay-progress', '10.0.112.2', 9_490);
    const subject = new NodeAddress('replay-progress', '10.0.112.3', 9_491);

    const base = Date.now();
    gossipFrom(node.cluster, peer, base, [selfRecord(peer)]);
    gossipFrom(node.cluster, peer, base + 1, [
      { address: subject.toJSON(), status: 'joining', version: base, roles: ['worker'] },
    ]);
    // The version has to clear the +1 the leader's promotion loop already
    // added on top of the merged record — unrelated to the replay guard.
    gossipFrom(node.cluster, peer, base + 2, [
      { address: subject.toJSON(), status: 'leaving', version: base + 100, roles: ['worker'] },
    ]);

    expect(internals(node.cluster).members.get(subject.toString())?.status).toBe('leaving');
    expect(markFor(node.cluster, peer)).toBe(base + 2);
  });

  test('refusals are counted on the existing metric, under a fourth reason', async () => {
    // A fourth label value on `cluster_gossip_records_refused_total`, not a new
    // series: the label set is closed for cardinality (#131), and an operator
    // alerting on "records are being refused at all" should not have to know
    // which guard fired.
    const node = await startNode('replay-metric', 9_403);
    nodes.push(node);
    node.system.extension(MetricsExtensionId).enable();
    const peer = new NodeAddress('replay-metric', '10.0.112.2', 9_490);

    const sequence = Date.now();
    gossipFrom(node.cluster, peer, sequence, [selfRecord(peer)]);
    const records: MemberData[] = [];
    for (let i = 0; i < 5; i++) {
      const address = new NodeAddress('replay-metric', '10.0.112.9', 40_000 + i);
      records.push({ address: address.toJSON(), status: 'up', version: Date.now(), roles: [] });
    }
    gossipFrom(node.cluster, peer, sequence, records);

    const refused = metricsOf(node.system)
      .counter('cluster_gossip_records_refused_total', { reason: 'replayed-frame' });
    expect(refused.value).toBe(5);
  });
});

describe('a sequence no clock could have produced is refused, not merged', () => {
  test('exploit: a captured frame restamped past the mark replays without limit', async () => {
    // What shipped: `admitsGossipSequence` admitted any number above the mark,
    // and `rememberGossipSequence` then refused to *adopt* an implausible one.
    // So a frame stamped `Number.MAX_SAFE_INTEGER` merged and left the mark
    // untouched — which means the identical frame merged again, and again,
    // against a **warm** receiver with a **live** sender.  That is the one
    // configuration #112's guard was claimed to hold in.  Only the sequence is
    // forged; `members` is still the recording, and nothing on this wire binds
    // the two together (#940).
    const node = await startNode('replay-restamp', 9_404);
    nodes.push(node);
    node.system.extension(MetricsExtensionId).enable();
    const peer = new NodeAddress('replay-restamp', '10.0.112.2', 9_490);
    const subject = new NodeAddress('replay-restamp', '10.0.112.3', 9_491);

    const base = Date.now();
    gossipFrom(node.cluster, peer, base, [selfRecord(peer)]);
    expect(markFor(node.cluster, peer)).toBe(base);

    const captured: MemberData[] = [
      { address: subject.toJSON(), status: 'up', version: base, roles: ['payments'] },
    ];
    for (let delivery = 0; delivery < 3; delivery++) {
      gossipFrom(node.cluster, peer, Number.MAX_SAFE_INTEGER, captured);
      expect(internals(node.cluster).members.has(subject.toString())).toBe(false);
    }
    expect(node.cluster.upMembersWithRole('payments')).toHaveLength(0);

    // Refused through the existing counter, once per record per delivery — the
    // label set stays closed at four values (#131).
    const refused = metricsOf(node.system)
      .counter('cluster_gossip_records_refused_total', { reason: 'replayed-frame' });
    expect(refused.value).toBe(3);
  });

  test('refusing it does not pin the peer: the mark stays where the real node left it', async () => {
    // The shape of #114 one field to the left, and the reason the fix is a
    // refusal rather than a rejection of the *mark*: if an absurd number could
    // become the high-water mark it would refuse everything the real node says
    // afterwards, and `MAX_SAFE_INTEGER + 1` rounds back to itself, so not even
    // a restart would escape.
    const node = await startNode('replay-pin', 9_408);
    nodes.push(node);
    const peer = new NodeAddress('replay-pin', '10.0.112.2', 9_490);
    const subject = new NodeAddress('replay-pin', '10.0.112.3', 9_491);

    const base = Date.now();
    gossipFrom(node.cluster, peer, base, [selfRecord(peer)]);
    gossipFrom(node.cluster, peer, Number.MAX_SAFE_INTEGER, [selfRecord(peer)]);

    expect(markFor(node.cluster, peer)).toBe(base);

    // …so the peer's next ordinary frame — one above the old mark, not above
    // the forged one — is still merged.
    gossipFrom(node.cluster, peer, base + 1, [
      { address: subject.toJSON(), status: 'up', version: base, roles: ['worker'] },
    ]);
    expect(internals(node.cluster).members.get(subject.toString())?.status).toBe('up');
  });

  test('the plausibility bound is the same clock-skew budget versions get', async () => {
    // Just inside `maxVersionSkewMs` is admitted and adopted, so a skewed peer
    // is never silenced by its own clock.  Beyond it the frame is dropped whole
    // — the record it carries does not land — and the mark is left alone.
    const node = await startNode('replay-budget', 9_405);
    nodes.push(node);
    const peer = new NodeAddress('replay-budget', '10.0.112.2', 9_490);
    const skewed = new NodeAddress('replay-budget', '10.0.112.3', 9_491);
    const beyond = new NodeAddress('replay-budget', '10.0.112.4', 9_492);

    // Standing first: a third-party record needs a sender the receiver already
    // considers active, and `senderStatus` is snapshotted before the merge, so
    // it cannot be earned by the same frame that uses it (#562).
    gossipFrom(node.cluster, peer, Date.now(), [selfRecord(peer)]);

    const withinBudget = Date.now() + 4 * MINUTE_MS;
    gossipFrom(node.cluster, peer, withinBudget, [
      { address: skewed.toJSON(), status: 'up', version: Date.now(), roles: [] },
    ]);
    expect(markFor(node.cluster, peer)).toBe(withinBudget);
    expect(internals(node.cluster).members.has(skewed.toString())).toBe(true);

    const beyondBudget = Date.now() + 60 * MINUTE_MS;
    gossipFrom(node.cluster, peer, beyondBudget, [
      { address: beyond.toJSON(), status: 'up', version: Date.now(), roles: [] },
    ]);
    expect(markFor(node.cluster, peer)).toBe(withinBudget);
    expect(internals(node.cluster).members.has(beyond.toString())).toBe(false);
  });

  test('a NaN sequence is refused rather than adopted as an unbeatable mark', async () => {
    // Hardening local to the decision that depends on it.  `wireFrameProblem`
    // refuses a non-finite `sequence` at the decode boundary, so this shape does
    // not reach a node over TCP — but `NaN` loses every `>` comparison, so an
    // unchecked one sails past both the mark and the budget, and on a *cold*
    // receiver it became the mark: every later frame from that peer then failed
    // `sequence > NaN` and the real node was silenced permanently.
    const node = await startNode('replay-nan', 9_409);
    nodes.push(node);
    const peer = new NodeAddress('replay-nan', '10.0.112.2', 9_490);
    const subject = new NodeAddress('replay-nan', '10.0.112.3', 9_491);

    gossipFrom(node.cluster, peer, Number.NaN, [selfRecord(peer)]);
    expect(markFor(node.cluster, peer)).toBeUndefined();
    expect(internals(node.cluster).members.has(peer.toString())).toBe(false);

    // …and the peer is still able to speak.
    const base = Date.now();
    gossipFrom(node.cluster, peer, base, [selfRecord(peer)]);
    gossipFrom(node.cluster, peer, base + 1, [
      { address: subject.toJSON(), status: 'up', version: base, roles: [] },
    ]);
    expect(markFor(node.cluster, peer)).toBe(base + 1);
    expect(internals(node.cluster).members.get(subject.toString())?.status).toBe('up');
  });
});

describe('a mark does not outlive its member', () => {
  test('the failure detector deleting a peer clears its mark', async () => {
    // The address's next incarnation seeds its counter from its own clock, not
    // from where the previous one left off — a mark left behind would refuse
    // its first frames.  The FD-down path is the one that *deletes* rather than
    // tombstoning, so it is the one that has to clean up.
    const node = await startNode('replay-eviction', 9_406, {
      heartbeatIntervalMs: 40, unreachableAfterMs: 120, downAfterMs: 240,
    });
    nodes.push(node);
    const peer = new NodeAddress('replay-eviction', '10.0.112.2', 9_490);

    const sequence = Date.now();
    gossipFrom(node.cluster, peer, sequence, [selfRecord(peer)]);
    expect(markFor(node.cluster, peer)).toBe(sequence);

    await waitFor(() => !internals(node.cluster).members.has(peer.toString()));
    expect(markFor(node.cluster, peer)).toBeUndefined();

    // And the peer comes back on a *lower* number, exactly as a restarted
    // process on a rewound clock would.
    gossipFrom(node.cluster, peer, sequence - 5_000, [selfRecord(peer)]);
    expect(internals(node.cluster).members.get(peer.toString())?.status).toBe('up');
  }, 15_000);

  test('this node seeds its own counter above its previous incarnation', async () => {
    // Peers hold a mark per sender, so a fresh process has to start above every
    // frame the previous one at that address ever sent.  Seeding from the wall
    // clock does it: a counter advances by one per gossip frame, and no node
    // gossips a thousand times a second.
    const node = await startNode('replay-epoch', 9_407);
    nodes.push(node);

    const seeded = internals(node.cluster).gossipSequence;
    expect(seeded).toBeGreaterThan(Date.now() - MINUTE_MS);
    expect(seeded).toBeLessThanOrEqual(Date.now());
  });
});

describe('what the guard leaves open: a mark exists only where a frame arrived (#823)', () => {
  /**
   * The two counterfactuals that fix #112's real bound, and the reason the
   * shipped texts overstated it.
   *
   * `acceptedGossipSequences.set` has exactly one caller — `onGossip`, through
   * `rememberGossipSequence` — so a mark exists only for a peer that has
   * gossiped to **this** receiver directly.  A missing mark admits everything,
   * and eviction of the sender is only one of three ways to be missing one:
   * a fresh process starts with the map empty, and a member learned
   * *third-party* (which is how epidemic gossip works at all) never had one.
   *
   * Both are asserted rather than left implicit, for the reason the forgery
   * counterfactual in `tests/multi-node/ClusterSecurity.test.ts` is: a boundary
   * nobody wrote down is a boundary that gets claimed away.  Neither closes
   * without a **required** incarnation on `NodeAddress`, because the only thing
   * separating a recording from a live frame is which process emitted it, and
   * the wire carries no field that says so — the optional one #940 added is
   * bypassed by stripping it, and requiring it breaks every address-bearing
   * frame field at once (#823).  Both invert when that lands.
   */
  test('exploit: a sender learned third-party has no mark, so its recording lands', async () => {
    const node = await startNode('replay-third-party', 9_410);
    nodes.push(node);
    node.system.extension(MetricsExtensionId).enable();
    const gossiper = new NodeAddress('replay-third-party', '10.0.112.2', 9_490);
    const sender = new NodeAddress('replay-third-party', '10.0.112.3', 9_491);
    const victim = new NodeAddress('replay-third-party', '10.0.112.4', 9_492);

    // `gossiper` earns standing the ordinary way, so the receiver holds a mark
    // for *it* — the configuration the guard is claimed to hold in.
    const gossiperSequence = Date.now();
    gossipFrom(node.cluster, gossiper, gossiperSequence, [selfRecord(gossiper)]);
    expect(markFor(node.cluster, gossiper)).toBe(gossiperSequence);

    // …and then reports `sender` as a third party, which is what epidemic
    // gossip is: the receiver files an `up` member whose frames it has never
    // seen, and therefore holds no mark for.
    gossipFrom(node.cluster, gossiper, gossiperSequence + 1, [
      { address: sender.toJSON(), status: 'up', version: Date.now(), roles: [] },
    ]);
    expect(internals(node.cluster).members.get(sender.toString())?.status).toBe('up');
    expect(markFor(node.cluster, sender)).toBeUndefined();

    // The recording: one frame `sender` really emitted, captured off its link
    // to some other peer while `victim` was still up.  Its number is far below
    // everything `sender` has sent since, and the receiver cannot tell.
    const captured: MemberData[] = [
      { address: victim.toJSON(), status: 'up', version: Date.now() - MINUTE_MS, roles: ['payments'] },
    ];
    const capturedSequence = gossiperSequence - 5 * MINUTE_MS;
    gossipFrom(node.cluster, sender, capturedSequence, captured);

    // Admitted whole: the victim is back `up`, carrying the roles shard
    // placement, singleton hosting and downing quorums are computed from —
    // with the sender a full member throughout, and nothing evicted anywhere.
    expect(internals(node.cluster).members.get(victim.toString())?.status).toBe('up');
    expect(node.cluster.upMembersWithRole('payments')).toHaveLength(1);

    // The guard arms only *after* the damage, off the recording's own number:
    // the identical frame delivered a second time is refused.
    expect(markFor(node.cluster, sender)).toBe(capturedSequence);
    gossipFrom(node.cluster, sender, capturedSequence, captured);
    const refused = metricsOf(node.system)
      .counter('cluster_gossip_records_refused_total', { reason: 'replayed-frame' });
    expect(refused.value).toBe(1);
  });

  test('exploit: a receiver that never met the sender replays it in capture order', async () => {
    // The disarming condition the standing texts name is "once the **sender**
    // has itself been evicted".  Nothing is evicted here, and nothing was ever
    // downed: the receiver has simply never held a mark for this address, which
    // is the state every process starts in and returns to on restart.
    //
    // Two frames, because a sender with no standing cannot speak for a third
    // party yet (#562) — `senderStatus` is snapshotted before the merge, so the
    // recording's first frame buys the standing and installs the mark, and its
    // second frame out-numbers the mark its own predecessor just set.
    const node = await startNode('replay-cold-start', 9_411);
    nodes.push(node);
    const sender = new NodeAddress('replay-cold-start', '10.0.112.2', 9_490);
    const victim = new NodeAddress('replay-cold-start', '10.0.112.3', 9_491);

    const recordedAt = Date.now() - 10 * MINUTE_MS;
    gossipFrom(node.cluster, sender, recordedAt, [
      { address: sender.toJSON(), status: 'up', version: recordedAt, roles: [] },
    ]);
    expect(internals(node.cluster).members.get(sender.toString())?.status).toBe('up');
    expect(markFor(node.cluster, sender)).toBe(recordedAt);

    gossipFrom(node.cluster, sender, recordedAt + 1, [
      { address: victim.toJSON(), status: 'up', version: recordedAt, roles: ['payments'] },
    ]);

    expect(internals(node.cluster).members.get(victim.toString())?.status).toBe('up');
    expect(node.cluster.upMembersWithRole('payments')).toHaveLength(1);
  });
});
