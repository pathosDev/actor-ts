/**
 * #1262 — a gossip frame's sequence restamped inside the skew budget must not
 * pin the receiver's high-water mark against the real sender.
 *
 * The #112 guard admitted any sequence above the mark and no further ahead
 * than `now + maxVersionSkewMs`, then adopted it as the mark.  There is no MAC
 * on this wire, so an injector restamped a captured frame to `now + 4 min`:
 * the recording merged once, and every genuine frame after it — numbered from
 * the sender's own clock, around `now` — failed `sequence > mark` until the
 * wall clock caught up.  One frame bought minutes (once a day) of refusing
 * everything the sender said about itself.
 *
 * Design decision D-3 (#1821): the mark is held per (member, incarnation), and
 * once a sender has a mark the accepted upper bound derives from what that
 * sender has already shown — its established clock offset plus a short lead —
 * not from `now + maxVersionSkewMs`.  No MAC, no wire break.
 *
 * Wall-clock driven, because the sequence is a wall-clock stamp on both ends:
 * `setSystemTime` moves `Date.now()` for the sender's frames and the receiver's
 * bound alike.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import {
  GOSSIP_SEQUENCE_AHEAD_RESET_AFTER_MS,
  GOSSIP_SEQUENCE_AHEAD_RESET_MIN_FRAMES,
  GOSSIP_SEQUENCE_LEAD_MS,
  GOSSIP_SEQUENCE_OFFSET_DRIFT_PER_MS,
} from '../../../src/cluster/Constants.js';
import { DEFAULT_MAX_VERSION_SKEW_MS } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { GossipMessage, MemberData } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';

const MINUTE_MS = 60 * 1_000;
const HOST = '10.0.162.1';
const PEER_HOST = '10.0.162.2';
const SUBJECT_HOST = '10.0.162.3';

type NodeHandle = { readonly system: ActorSystem; readonly cluster: Cluster };

interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage): void;
  nextGossipSequence(): number;
  readonly members: Map<string, Member>;
  readonly acceptedGossipSequences: Map<string, number>;
}

const internals = (cluster: Cluster): ClusterInternals => cluster as unknown as ClusterInternals;

let nodes: NodeHandle[] = [];
/** The wall clock the case runs on; every frame and every bound reads it. */
let now = 0;

function setNow(at: number): void {
  now = at;
  setSystemTime(new Date(at));
}

afterEach(async () => {
  setSystemTime();
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

async function startNode(systemName: string, port: number): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({ heartbeatIntervalMs: 600_000, unreachableAfterMs: 1_200_000, downAfterMs: 2_400_000 })
    .withFailureDetectorAutoDown(false)
    .withGossipIntervalMs(600_000);
  const cluster = await Cluster.join(system, clusterOptions);
  const node = { system, cluster };
  nodes.push(node);
  return node;
}

function gossipFrom(cluster: Cluster, from: NodeAddress, sequence: number, members: MemberData[]): void {
  internals(cluster).handleWire(from, { kind: 'gossip', from: from.toJSON(), sequence, members });
}

const selfRecord = (peer: NodeAddress, version: number): MemberData =>
  ({ address: peer.toJSON(), status: 'up', version, roles: [] });

const subjectRecord = (subject: NodeAddress, version: number): MemberData =>
  ({ address: subject.toJSON(), status: 'up', version, roles: ['payments'] });

const holds = (cluster: Cluster, address: NodeAddress): boolean =>
  internals(cluster).members.has(address.toString());

const markFor = (cluster: Cluster, address: NodeAddress): number | undefined =>
  internals(cluster).acceptedGossipSequences.get(address.toString());

describe('a restamped capture inside the skew budget cannot pin the mark (#1262)', () => {
  test('a frame minutes ahead of the sender\'s established clock is refused, and genuine frames keep merging', async () => {
    setNow(Date.parse('2026-11-14T10:00:00Z'));
    const node = await startNode('pin-minutes', 9_621);
    const peer = new NodeAddress('pin-minutes', PEER_HOST, 9_622, 'peer-run');
    const recorded = new NodeAddress('pin-minutes', SUBJECT_HOST, 9_623);
    const genuine = new NodeAddress('pin-minutes', SUBJECT_HOST, 9_624);

    gossipFrom(node.cluster, peer, now, [selfRecord(peer, now)]);
    setNow(now + 1_000);
    gossipFrom(node.cluster, peer, now, [selfRecord(peer, now - 1_000)]);
    const markBefore = markFor(node.cluster, peer);

    // Inside the 5-minute skew budget, far outside anything this sender has shown.
    gossipFrom(node.cluster, peer, now + 4 * MINUTE_MS, [subjectRecord(recorded, now)]);
    expect(holds(node.cluster, recorded)).toBe(false);
    expect(markFor(node.cluster, peer)).toBe(markBefore);

    setNow(now + 1_000);
    gossipFrom(node.cluster, peer, now, [subjectRecord(genuine, now)]);
    expect(holds(node.cluster, genuine)).toBe(true);
  });

  test('a frame just inside the lead pins for at most the lead', async () => {
    setNow(Date.parse('2026-11-14T11:00:00Z'));
    const node = await startNode('pin-lead', 9_631);
    const peer = new NodeAddress('pin-lead', PEER_HOST, 9_632, 'peer-run');
    const recorded = new NodeAddress('pin-lead', SUBJECT_HOST, 9_633);
    const genuine = new NodeAddress('pin-lead', SUBJECT_HOST, 9_634);

    gossipFrom(node.cluster, peer, now, [selfRecord(peer, now)]);
    const pinned = now + GOSSIP_SEQUENCE_LEAD_MS - 1;
    gossipFrom(node.cluster, peer, pinned, [subjectRecord(recorded, now)]);
    expect(markFor(node.cluster, peer)).toBe(pinned);

    // The real sender, stamping its own clock, is behind the forged mark — for
    // the length of the lead and no longer.
    setNow(now + GOSSIP_SEQUENCE_LEAD_MS);
    gossipFrom(node.cluster, peer, now, [subjectRecord(genuine, now)]);
    expect(holds(node.cluster, genuine)).toBe(true);
  });

  test('repeated injections at the bound do not walk the mark ahead of the clock', async () => {
    // Each admitted frame must not raise the bound the next one is held to by
    // the lead again, or a frame per second would accumulate an hour of lead in
    // an hour.
    setNow(Date.parse('2026-11-14T12:00:00Z'));
    const node = await startNode('pin-walk', 9_641);
    const peer = new NodeAddress('pin-walk', PEER_HOST, 9_642, 'peer-run');
    gossipFrom(node.cluster, peer, now, [selfRecord(peer, now)]);

    for (let injection = 0; injection < 120; injection++) {
      setNow(now + 1_000);
      // The highest sequence the receiver still takes, found by trying.
      let accepted = false;
      for (let lead = 4 * MINUTE_MS; lead >= 0 && !accepted; lead -= 500) {
        const before = markFor(node.cluster, peer);
        gossipFrom(node.cluster, peer, now + lead, [selfRecord(peer, now - 120_000)]);
        accepted = markFor(node.cluster, peer) !== before;
      }
    }
    expect(markFor(node.cluster, peer)! - now).toBeLessThanOrEqual(2 * GOSSIP_SEQUENCE_LEAD_MS);
  });

  test('a long silence banks no drift: the bound stays within one lead of the learned offset', async () => {
    // The learned offset may rise at 1 ms/s, but by no more than one lead in
    // all.  Without that cap a sender quiet for eight hours would have banked
    // 28.8 s of allowance, past the lead, and a capture restamped into it would
    // pin the mark for that long again.
    setNow(Date.parse('2026-11-14T16:00:00Z'));
    const node = await startNode('pin-silence', 9_681);
    const peer = new NodeAddress('pin-silence', PEER_HOST, 9_682, 'peer-run');
    const recorded = new NodeAddress('pin-silence', SUBJECT_HOST, 9_683);
    gossipFrom(node.cluster, peer, now, [selfRecord(peer, now)]);
    const markBefore = markFor(node.cluster, peer);

    setNow(now + 8 * 60 * MINUTE_MS);
    // Past offset + 2 × lead, inside the eight hours' worth of uncapped drift.
    gossipFrom(node.cluster, peer, now + 3 * GOSSIP_SEQUENCE_LEAD_MS, [subjectRecord(recorded, now)]);
    expect(holds(node.cluster, recorded)).toBe(false);
    expect(markFor(node.cluster, peer)).toBe(markBefore);
  });
});

describe('the mark is held per (member, incarnation) (#1262)', () => {
  test('a mark pinned against one run does not refuse the next run at the same address', async () => {
    setNow(Date.parse('2026-11-14T13:00:00Z'));
    const node = await startNode('pin-incarnation', 9_651);
    const firstRun = new NodeAddress('pin-incarnation', PEER_HOST, 9_652, 'run-1');
    const nextRun = new NodeAddress('pin-incarnation', PEER_HOST, 9_652, 'run-2');

    gossipFrom(node.cluster, firstRun, now, [selfRecord(firstRun, now)]);
    gossipFrom(node.cluster, firstRun, now + GOSSIP_SEQUENCE_LEAD_MS - 1, [selfRecord(firstRun, now)]);

    setNow(now + 1_000);
    gossipFrom(node.cluster, nextRun, now, [selfRecord(nextRun, now)]);
    expect(internals(node.cluster).members.get(nextRun.toString())?.address.incarnation).toBe('run-2');
  });
});

describe('a sender whose clock stepped forward is not silenced for good (#1262)', () => {
  test('frames consistently past the bound for long enough re-establish the sender\'s clock', async () => {
    setNow(Date.parse('2026-11-14T14:00:00Z'));
    const node = await startNode('pin-step', 9_661);
    const peer = new NodeAddress('pin-step', PEER_HOST, 9_662, 'peer-run');
    const later = new NodeAddress('pin-step', SUBJECT_HOST, 9_663);
    gossipFrom(node.cluster, peer, now, [selfRecord(peer, now)]);

    // An NTP step of two minutes on the sender: every frame from here on is
    // two minutes past what it has shown.
    const step = 2 * MINUTE_MS;
    const start = now;
    while (now - start <= GOSSIP_SEQUENCE_AHEAD_RESET_AFTER_MS + 5_000) {
      setNow(now + 5_000);
      gossipFrom(node.cluster, peer, now + step, [subjectRecord(later, now)]);
    }
    expect(holds(node.cluster, later)).toBe(true);
  });
});

describe('the forward-step reset lands on the frame that reaches both thresholds (#1262)', () => {
  // The case above sends one frame past the threshold before it looks, so it
  // cannot tell "the reset frame merged" from "the frame after it merged as a
  // first frame" — the second is what a reset that deletes the clocks but
  // refuses its own frame produces.  Nor does it look past that one frame, so
  // a reset that kept the stale clock — and refused the sender again from the
  // next frame on — passed it as well.  Here every frame names its own subject
  // and the outcome is read after each one.

  type SteppedFrame = { readonly sentAt: number; readonly merged: boolean };

  /** One frame every `spacingMs`, each two minutes past the sender's learned clock and naming a fresh subject. */
  async function sendSteppedFrames(systemName: string, port: number, spacingMs: number, frames: number): Promise<SteppedFrame[]> {
    setNow(Date.parse('2026-11-14T17:00:00Z'));
    const node = await startNode(systemName, port);
    const peer = new NodeAddress(systemName, PEER_HOST, port + 1, 'peer-run');
    gossipFrom(node.cluster, peer, now, [selfRecord(peer, now)]);
    const start = now;
    const step = 2 * MINUTE_MS;
    const outcomes: SteppedFrame[] = [];
    for (let frame = 1; frame <= frames; frame++) {
      setNow(now + spacingMs);
      const subject = new NodeAddress(systemName, SUBJECT_HOST, port + 1 + frame);
      gossipFrom(node.cluster, peer, now + step, [subjectRecord(subject, now)]);
      outcomes.push({ sentAt: now - start, merged: holds(node.cluster, subject) });
    }
    return outcomes;
  }

  test('frames 5 s apart: refused until the window has run, then every frame merges', async () => {
    const outcomes = await sendSteppedFrames('reset-window', 9_700, 5_000, 18);
    // The first refused frame (at +5 s) opens the window, so it completes at
    // +5 s + the window.  That frame merges, and so does every frame after it:
    // the clock learned from the reset frame is the stepped one.
    const resetAt = 5_000 + GOSSIP_SEQUENCE_AHEAD_RESET_AFTER_MS;
    expect(outcomes).toEqual(outcomes.map(({ sentAt }) => ({ sentAt, merged: sentAt >= resetAt })));
    // +65 s … +90 s: the reset frame and the five after it.
    expect(outcomes.filter(({ merged }) => merged).length).toBe(6);
  });

  test('frames spaced so the minimum frame count is reached exactly as the window runs out', async () => {
    // 30 s apart: the refused frames land at +30 s, +60 s, +90 s — the third is
    // both the minimum count and exactly the window after the first.
    expect(GOSSIP_SEQUENCE_AHEAD_RESET_MIN_FRAMES).toBe(3);
    const spacing = GOSSIP_SEQUENCE_AHEAD_RESET_AFTER_MS / (GOSSIP_SEQUENCE_AHEAD_RESET_MIN_FRAMES - 1);
    const outcomes = await sendSteppedFrames('reset-count', 9_730, spacing, 5);
    expect(outcomes.map(({ merged }) => merged)).toEqual([false, false, true, true, true]);
  });
});

describe('the gossip-sequence bounds are inclusive (#1262)', () => {
  test('a first frame exactly at now + maxVersionSkewMs is admitted', async () => {
    setNow(Date.parse('2026-11-14T18:00:00Z'));
    const node = await startNode('bound-skew', 9_760);
    const peer = new NodeAddress('bound-skew', PEER_HOST, 9_761, 'peer-run');
    // A first frame has no standing to speak for a third party, so what it
    // can carry is the sender's own record.
    gossipFrom(node.cluster, peer, now + DEFAULT_MAX_VERSION_SKEW_MS, [selfRecord(peer, now)]);
    expect(holds(node.cluster, peer)).toBe(true);
  });

  test('a frame exactly one lead past the learned clock is admitted', async () => {
    setNow(Date.parse('2026-11-14T18:10:00Z'));
    const node = await startNode('bound-lead', 9_770);
    const peer = new NodeAddress('bound-lead', PEER_HOST, 9_771, 'peer-run');
    const subject = new NodeAddress('bound-lead', SUBJECT_HOST, 9_772);
    gossipFrom(node.cluster, peer, now, [selfRecord(peer, now)]);
    gossipFrom(node.cluster, peer, now + GOSSIP_SEQUENCE_LEAD_MS, [subjectRecord(subject, now)]);
    expect(holds(node.cluster, subject)).toBe(true);
  });

  test('a frame exactly at the capped allowance keeps the drift banked before it', async () => {
    // A long silence banks more drift than one lead, and the allowance is
    // capped at offset + lead.  A frame landing exactly on that cap moves the
    // offset up to it, but the drift line the allowance was cut from is still
    // the one the next frame is measured against — so a frame a second later,
    // a little past the new offset + lead, still fits the drifted allowance.
    setNow(Date.parse('2026-11-14T19:00:00Z'));
    const node = await startNode('bound-allowance', 9_780);
    const peer = new NodeAddress('bound-allowance', PEER_HOST, 9_781, 'peer-run');
    const subject = new NodeAddress('bound-allowance', SUBJECT_HOST, 9_782);
    gossipFrom(node.cluster, peer, now, [selfRecord(peer, now)]);
    const start = now;

    const silenceMs = 3 * 60 * MINUTE_MS;
    expect(silenceMs * GOSSIP_SEQUENCE_OFFSET_DRIFT_PER_MS).toBeGreaterThan(GOSSIP_SEQUENCE_LEAD_MS);
    setNow(start + silenceMs);
    gossipFrom(node.cluster, peer, now + GOSSIP_SEQUENCE_LEAD_MS, [selfRecord(peer, now)]);
    expect(markFor(node.cluster, peer)).toBe(now + GOSSIP_SEQUENCE_LEAD_MS);

    setNow(now + 1_000);
    const drifted = (now - start) * GOSSIP_SEQUENCE_OFFSET_DRIFT_PER_MS;
    // Past the new offset (one lead) plus a second's fresh drift, inside the banked drift.
    const ahead = GOSSIP_SEQUENCE_LEAD_MS + 500;
    expect(ahead).toBeLessThan(drifted);
    gossipFrom(node.cluster, peer, now + ahead + GOSSIP_SEQUENCE_LEAD_MS, [subjectRecord(subject, now)]);
    expect(holds(node.cluster, subject)).toBe(true);
  });
});

describe('this node stamps its frames from its own clock (#1262)', () => {
  test('the counter never falls behind the wall clock', async () => {
    setNow(Date.parse('2026-11-14T15:00:00Z'));
    const node = await startNode('pin-stamp', 9_671);
    setNow(now + 30_000);
    expect(internals(node.cluster).nextGossipSequence()).toBeGreaterThanOrEqual(now);
    const next = internals(node.cluster).nextGossipSequence();
    expect(internals(node.cluster).nextGossipSequence()).toBeGreaterThan(next);
  });
});
