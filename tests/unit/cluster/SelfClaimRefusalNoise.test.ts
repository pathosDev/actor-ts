/**
 * #1352 — the merge path's self-claim branch is a guard, not an event source.
 *
 * Rule 1 of #562 says this node is the author of its own status: a gossiped
 * record about `selfAddress` is refused unless it is the leader promoting us.
 * That rule is not what these tests are about — it is unchanged, and the
 * refusal still happens in every case below.  What is pinned here is *what an
 * operator hears* while it happens.
 *
 * A gossip frame carries the sender's whole member map, so our own record
 * comes back to us on every round.  Logging each refusal put one WARN per
 * gossip interval per peer into the log of a perfectly healthy cluster, and
 * during a two-node bring-up that line was the loudest thing present and read
 * as the cause of a failure that lay elsewhere entirely.
 *
 * So the branch splits by whether the record would have changed anything:
 *
 * - an **echo** of the status we already hold is the ordinary content of a
 *   round and is refused in silence;
 * - a **contradiction** is the #562 case and still surfaces, but through
 *   `refusalCounts` like every other guard on this path — one line and one
 *   counter increment per *frame*, not per record, which is the property #131
 *   established and the self-claim branch was bypassing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { SelfElectionPolicy } from '../../../src/cluster/ClusterOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { GossipMessage, MemberData } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';
import { MetricsExtensionId, metricsOf } from '../../../src/metrics/MetricsExtension.js';

type LogRecord = { readonly level: string; readonly message: string };

/** Collects everything the system logger was told, including via `withSource`. */
class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }

  private record(level: string, message: string): void {
    this.sink.records.push({ level, message });
  }

  debug(message: string): void { this.record('debug', message); }
  info(message: string): void { this.record('info', message); }
  warn(message: string): void { this.record('warn', message); }
  error(message: string): void { this.record('error', message); }

  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

type NodeHandle = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
  readonly logger: RecordingLogger;
};

/**
 * A node with its timers parked far out: every frame these tests care about is
 * injected by hand, so a gossip or heartbeat tick would only add noise to the
 * very log this file makes assertions about.
 *
 * `'never'` is how a node is held in `joining`: an empty seed list would
 * self-elect it to `up` on the spot, and a non-empty one would start a retry
 * loop dialling addresses nothing answers on.
 */
async function startNode(
  systemName: string, port: number, selfElection?: SelfElectionPolicy,
): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, '10.0.135.1', port);
  const logger = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Debug);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({
      heartbeatIntervalMs: 60_000,
      unreachableAfterMs: 120_000,
      downAfterMs: 240_000,
    })
    .withGossipIntervalMs(60_000);
  if (selfElection !== undefined) clusterOptions.withSelfElection(selfElection);
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, cluster, address, logger };
}

/** The private surface these tests reach through — merge internals, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage): void;
  readonly members: Map<string, Member>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

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

/**
 * A record about `subject`, versioned well clear of whatever the receiver
 * holds — so that nothing but `maySpeakFor` can be what refuses it.
 */
function claimAbout(subject: NodeAddress, status: MemberData['status']): MemberData {
  return { address: subject.toJSON(), status, version: Date.now() + 60_000, roles: [] };
}

function statusOf(node: NodeHandle): string | undefined {
  return internals(node.cluster).members.get(node.address.toString())?.status;
}

/**
 * Every WARN the node has emitted so far — deliberately unfiltered.
 *
 * The tests below assert on the *delta* across a set of injected frames rather
 * than on lines matching a pattern.  A filter would have to name the wording it
 * expects to be absent, which is precisely the wording this change removes: a
 * test keyed on the new `reportRefusals` phrasing passes against the old
 * per-record line too, and so proves nothing about the silence it claims to
 * pin.
 */
function warningsOf(node: NodeHandle): string[] {
  return node.logger.records.filter((r) => r.level === 'warn').map((r) => r.message);
}

function selfClaimsRefused(node: NodeHandle): number {
  return metricsOf(node.system)
    .counter('cluster_gossip_records_refused_total', { reason: 'self-claim' }).value;
}

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('a peer echoing the status we already hold is refused in silence', () => {
  test('an up node hearing itself called up says nothing', async () => {
    const node = await startNode('echo-up', 9_601);
    nodes.push(node);
    node.system.extension(MetricsExtensionId).enable();
    expect(statusOf(node)).toBe('up');
    const peer = new NodeAddress('echo-up', '10.0.135.2', 9_690);

    const base = Date.now();
    gossipFrom(node.cluster, peer, base, [selfRecord(peer)]);
    const before = warningsOf(node).length;
    gossipFrom(node.cluster, peer, base + 1, [
      selfRecord(peer), claimAbout(node.address, 'up'),
    ]);

    expect(warningsOf(node).slice(before)).toEqual([]);
    expect(selfClaimsRefused(node)).toBe(0);
    expect(statusOf(node)).toBe('up');
  });

  test('a joining node hearing itself called joining says nothing', async () => {
    // The shape that produced this issue: two nodes seeded at each other,
    // neither self-electing, each truthfully reporting the other as `joining`
    // once per second — and each refusing its own truth, out loud.
    const node = await startNode('echo-joining', 9_602, 'never');
    nodes.push(node);
    node.system.extension(MetricsExtensionId).enable();
    expect(statusOf(node)).toBe('joining');
    const peer = new NodeAddress('echo-joining', '10.0.135.2', 9_690);

    const base = Date.now();
    gossipFrom(node.cluster, peer, base, [selfRecord(peer)]);
    const before = warningsOf(node).length;
    for (let round = 1; round <= 5; round++) {
      gossipFrom(node.cluster, peer, base + round, [
        selfRecord(peer), claimAbout(node.address, 'joining'),
      ]);
    }

    expect(warningsOf(node).slice(before)).toEqual([]);
    expect(selfClaimsRefused(node)).toBe(0);
    expect(statusOf(node)).toBe('joining');
  });
});

describe('a peer contradicting us still surfaces, folded per frame', () => {
  test('a downgrade is refused, counted and reported once', async () => {
    const node = await startNode('contradiction', 9_603);
    nodes.push(node);
    node.system.extension(MetricsExtensionId).enable();
    const peer = new NodeAddress('contradiction', '10.0.135.2', 9_690);

    const base = Date.now();
    gossipFrom(node.cluster, peer, base, [selfRecord(peer)]);
    const before = warningsOf(node).length;
    gossipFrom(node.cluster, peer, base + 1, [claimAbout(node.address, 'removed')]);

    const warnings = warningsOf(node).slice(before);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('author of its own status');
    expect(selfClaimsRefused(node)).toBe(1);
    // The rule itself is untouched: the exploit #562 closed set this record to
    // `removed`, and it still does not land.
    expect(statusOf(node)).toBe('up');
  });

  test('several contradictions in one frame are one line, not one each', async () => {
    // The property #131 established for every other guard on this path, and
    // the one the self-claim branch was bypassing by logging per record.
    const node = await startNode('fold-per-frame', 9_604);
    nodes.push(node);
    node.system.extension(MetricsExtensionId).enable();
    const peer = new NodeAddress('fold-per-frame', '10.0.135.2', 9_690);

    const base = Date.now();
    gossipFrom(node.cluster, peer, base, [selfRecord(peer)]);
    const before = warningsOf(node).length;
    gossipFrom(node.cluster, peer, base + 1, [
      claimAbout(node.address, 'removed'),
      claimAbout(node.address, 'leaving'),
      claimAbout(node.address, 'down'),
    ]);

    expect(warningsOf(node).slice(before)).toHaveLength(1);
    expect(selfClaimsRefused(node)).toBe(3);
    expect(statusOf(node)).toBe('up');
  });
});

describe('the one claim about self that is not a refusal', () => {
  test('the promotion to up still lands, and is not counted', async () => {
    const node = await startNode('promotion', 9_605, 'never');
    nodes.push(node);
    node.system.extension(MetricsExtensionId).enable();
    expect(statusOf(node)).toBe('joining');
    const peer = new NodeAddress('promotion', '10.0.135.2', 9_690);

    const base = Date.now();
    gossipFrom(node.cluster, peer, base, [selfRecord(peer)]);
    const before = warningsOf(node).length;
    gossipFrom(node.cluster, peer, base + 1, [claimAbout(node.address, 'up')]);

    expect(statusOf(node)).toBe('up');
    expect(warningsOf(node).slice(before)).toEqual([]);
    expect(selfClaimsRefused(node)).toBe(0);
  });
});
