/**
 * #1351 — a cluster that can never converge has to say so.
 *
 * `joining → up` is the leader's decision, `leader()` is the first of
 * `upMembers()`, and the only way a node reaches `up` without a leader is
 * self-election. Give every node a non-empty seed list and the default
 * `selfElection: 'immediate'` — which self-elects only on an *empty* one — and
 * none of the three ever happens: no node is `up`, so no node is leader, so no
 * node is promoted. The member map is populated, gossip flows once a second,
 * and nothing converges.
 *
 * That configuration is documented (`cluster/joining-and-seeds`, "The
 * symmetric seed list does not cold-start"), but it used to be silent at
 * runtime. What an operator saw instead was `AskTimeoutError` from a singleton
 * proxy, several subsystems away from the cause, because
 * `ClusterSingletonManager` picks its host from `upMembers()` and there was
 * never one to pick.
 *
 * What is pinned here is that the node names the condition itself, that it
 * distinguishes the two ways of reaching it — nobody answering versus everyone
 * answering and nobody electing — and, just as importantly, the cases where it
 * stays quiet: a node whose promotion is somebody else's job, and one whose
 * own self-election has not yet come due.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import type { SelfElectionPolicy } from '../../../src/cluster/ClusterOptions.js';
import { COLD_START_STALL_AFTER_SEED_ROUNDS } from '../../../src/cluster/Constants.js';
import type { Member } from '../../../src/cluster/Member.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { GossipMessage, MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../src/Logger.js';
import { awaitCondition, sleep } from '../../util/AwaitCondition.js';

/**
 * Fast enough that the whole threshold passes inside a test, slow enough that
 * the rounds are still distinct scheduler ticks rather than one burst.
 */
const RETRY_INTERVAL_MS = 20;

/** Comfortably past the threshold, so "it stayed quiet" means it really did. */
const QUIET_WINDOW_MS = RETRY_INTERVAL_MS * (COLD_START_STALL_AFTER_SEED_ROUNDS + 6);

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
 * A node whose seeds point at addresses no transport is registered under, so
 * `InMemoryTransport.send` drops the contact silently and the retry loop keeps
 * running — which is exactly the state under test.
 */
async function startNode(
  systemName: string, port: number, seeds: string[], selfElection?: SelfElectionPolicy,
  minimumMembersBeforeUp?: number,
): Promise<NodeHandle> {
  const address = new NodeAddress(systemName, '10.0.151.1', port);
  const logger = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Debug);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withSeeds(seeds)
    .withSeedRetryIntervalMs(RETRY_INTERVAL_MS)
    .withFailureDetector({
      heartbeatIntervalMs: 60_000,
      unreachableAfterMs: 120_000,
      downAfterMs: 240_000,
    })
    .withGossipIntervalMs(60_000);
  if (selfElection !== undefined) clusterOptions.withSelfElection(selfElection);
  if (minimumMembersBeforeUp !== undefined) {
    clusterOptions.withMinimumMembersBeforeUp(minimumMembersBeforeUp);
  }
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

/**
 * Put one peer in the member map at `status`, the way gossip would.
 *
 * The frame announces only the peer itself, which is the one claim
 * `maySpeakFor` never refuses — so this reaches the map without depending on
 * any of the merge-path rules the other cluster suites pin.
 */
function introducePeer(node: NodeHandle, peer: NodeAddress, status: MemberStatus): void {
  const record: MemberData = {
    address: peer.toJSON(), status, version: Date.now(), roles: [],
  };
  internals(node.cluster).handleWire(peer, {
    kind: 'gossip', from: peer.toJSON(), sequence: Date.now(), members: [record],
  });
}

function stallWarnings(node: NodeHandle): string[] {
  return node.logger.records
    .filter((r) => r.level === 'warn' && r.message.includes('nothing can promote this node'))
    .map((r) => r.message);
}

/** The #837 counterpart — the cluster is short of members, not misconfigured. */
function thresholdWarnings(node: NodeHandle): string[] {
  return node.logger.records
    .filter((r) => r.level === 'warn' && r.message.includes('minimum-members-before-up'))
    .map((r) => r.message);
}

/** The line a founder logs when the threshold holds its self-election (#837). */
function heldSelfElectionLines(node: NodeHandle): string[] {
  return node.logger.records
    .filter((r) => r.message.includes('holding self-election'))
    .map((r) => r.message);
}

const awaitStall = (node: NodeHandle): Promise<void> => awaitCondition(
  () => stallWarnings(node).length > 0,
  { timeoutMs: 2_000, intervalMs: 5, label: 'the cold-start stall to be reported' },
);

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

describe('a node nothing can promote names the reason', () => {
  test('peers known and none up: the seed list and the policy are named', async () => {
    const node = await startNode('stall-symmetric', 9_701, ['10.0.151.2:9790']);
    nodes.push(node);
    const peer = new NodeAddress('stall-symmetric', '10.0.151.2', 9_790);
    introducePeer(node, peer, 'joining');

    await awaitStall(node);

    const warning = stallWarnings(node)[0] ?? '';
    // The mechanism, so the reader does not have to know the promotion rule.
    expect(warning).toContain('no member is "up", so there is no leader');
    // And the way out, in both forms — the manual one and the one that stops
    // the operator having to pair `seeds` and `selfElection` by hand.
    expect(warning).toContain("selfElection: 'immediate'");
    expect(warning).toContain('seeds: []');
    expect(warning).toContain('stableObservation: true');
  });

  test('no peer at all: the unanswered seeds are named instead', async () => {
    // Same member map from the promotion rule's point of view, entirely
    // different fix — so the two must not share a message.
    const node = await startNode('stall-unanswered', 9_702, ['10.0.151.2:9790']);
    nodes.push(node);

    await awaitStall(node);

    const warning = stallWarnings(node)[0] ?? '';
    expect(warning).toContain('no seed has answered at all');
    expect(warning).toContain('stall-unanswered@10.0.151.2:9790');
    expect(warning).not.toContain('stableObservation');
  });

  test("selfElection: 'never' points at the elected node instead", async () => {
    const node = await startNode('stall-never', 9_703, ['10.0.151.2:9790'], 'never');
    nodes.push(node);
    introducePeer(node, new NodeAddress('stall-never', '10.0.151.2', 9_790), 'joining');

    await awaitStall(node);

    const warning = stallWarnings(node)[0] ?? '';
    expect(warning).toContain("selfElection: 'never'");
    expect(warning).toContain('the node elected to form the cluster has not reached "up"');
  });

  test('it is a verdict, not an event: one line however long the stall lasts', async () => {
    const node = await startNode('stall-once', 9_704, ['10.0.151.2:9790']);
    nodes.push(node);
    introducePeer(node, new NodeAddress('stall-once', '10.0.151.2', 9_790), 'joining');

    await awaitStall(node);
    // Absence assertion: the claim is that no *second* line follows, and only
    // letting several more retry rounds pass can show that.
    await sleep(QUIET_WINDOW_MS);

    expect(stallWarnings(node)).toHaveLength(1);
  });
});

describe('and stays quiet where the stall is not this node to report', () => {
  test('a leader exists, so promotion is its job and not a deadlock', async () => {
    // This node is still `joining` and may stay that way — but something in
    // the cluster *can* promote it, which is the difference between waiting
    // and being finished.  Claiming a deadlock here would be a false alarm on
    // every ordinary join.
    const node = await startNode('stall-has-leader', 9_705, ['10.0.151.2:9790']);
    nodes.push(node);
    introducePeer(node, new NodeAddress('stall-has-leader', '10.0.151.2', 9_790), 'up');

    // Absence assertion: nothing is ever going to arrive, so the only evidence
    // available is that the threshold passed and still nothing did.
    await sleep(QUIET_WINDOW_MS);

    expect(stallWarnings(node)).toEqual([]);
  });

  test('a deferred self-election has not come due yet', async () => {
    // The one policy that resolves this without help: its timer is pending, so
    // the node is on a clock rather than stuck, and reporting would be wrong
    // right up until the moment it stops being true.
    const node = await startNode(
      'stall-deferred', 9_706, ['10.0.151.2:9790'], QUIET_WINDOW_MS * 4,
    );
    nodes.push(node);
    introducePeer(node, new NodeAddress('stall-deferred', '10.0.151.2', 9_790), 'joining');

    // Absence assertion, and the elapsed time is half of it: the window has to
    // clear the round threshold while staying inside the election grace.
    await sleep(QUIET_WINDOW_MS);

    expect(stallWarnings(node)).toEqual([]);
    expect(internals(node.cluster).members.get(node.address.toString())?.status).toBe('joining');
  });

  test('a node that self-elects on an empty seed list never runs the check', async () => {
    // No seed list means no retry loop, and `'immediate'` has already made this
    // node `up` — the single-node development run, which must stay silent.
    const node = await startNode('stall-single', 9_707, []);
    nodes.push(node);

    // Absence assertion: there is no retry loop here at all, so there is no
    // state to poll — only the passage of the window it would have fired in.
    await sleep(QUIET_WINDOW_MS);

    expect(stallWarnings(node)).toEqual([]);
    expect(internals(node.cluster).members.get(node.address.toString())?.status).toBe('up');
  });
});

/**
 * #837 — the same silence, a different cause, and the verdict above would be
 * false about it.
 *
 * `minimumMembersBeforeUp` holds every promotion including this node's own
 * self-election, so the member map looks exactly like a cold-start stall: no
 * member `up`, no leader, nothing pending. It is not one. The cluster is short
 * of members and the missing node fixes it, where a real stall is fixed by
 * changing the configuration — so telling an operator "no node will ever form
 * the cluster" here would send them to rewrite a config that is correct.
 */
describe('a cluster waiting for its membership threshold says so instead', () => {
  test('the threshold and the current count replace the stall verdict', async () => {
    const node = await startNode('threshold-wait', 9_711, ['10.0.151.2:9790'], undefined, 3);
    nodes.push(node);
    introducePeer(node, new NodeAddress('threshold-wait', '10.0.151.2', 9_790), 'joining');

    await awaitCondition(() => thresholdWarnings(node).length > 0, {
      timeoutMs: 2_000, intervalMs: 5, label: 'the membership-threshold wait to be reported',
    });

    const warning = thresholdWarnings(node)[0] ?? '';
    // The key, so the operator can find the value they set.
    expect(warning).toContain('actor-ts.cluster.minimum-members-before-up');
    // The arithmetic, so they can tell "still rolling out" from "set above the
    // size of the deployment" — the only two states this can be.
    expect(warning).toContain('2 of 3 member(s) present');
    // And, load-bearing: NOT the other diagnosis. The two conditions are
    // indistinguishable in the member map, so the wrong one shipping is a
    // silent regression rather than a failing assertion anywhere else.
    expect(stallWarnings(node)).toEqual([]);
  });

  test('it is a verdict on a wait, not an event: one line however long it lasts', async () => {
    const node = await startNode('threshold-once', 9_712, ['10.0.151.2:9790'], undefined, 3);
    nodes.push(node);
    introducePeer(node, new NodeAddress('threshold-once', '10.0.151.2', 9_790), 'joining');

    await awaitCondition(() => thresholdWarnings(node).length > 0, {
      timeoutMs: 2_000, intervalMs: 5, label: 'the membership-threshold wait to be reported',
    });
    // Absence assertion: several more retry rounds have to pass for "no second
    // line" to mean anything.
    await sleep(QUIET_WINDOW_MS);

    expect(thresholdWarnings(node)).toHaveLength(1);
  });

  test('a founder with no seeds names the threshold that is holding it', async () => {
    // The gap the seed-retry loop cannot cover: an empty seed list arms no
    // retry timer at all, so `reportColdStartStall` never runs — and a founder
    // held by the threshold is the exact node an operator will be looking at
    // when the cluster does not come up.
    const node = await startNode('threshold-founder', 9_713, [], undefined, 2);
    nodes.push(node);

    await awaitCondition(() => heldSelfElectionLines(node).length > 0, {
      timeoutMs: 2_000, intervalMs: 5, label: 'the held self-election to be reported',
    });

    const line = heldSelfElectionLines(node)[0] ?? '';
    expect(line).toContain('actor-ts.cluster.minimum-members-before-up');
    expect(line).toContain('1 of 2 member(s) present');
    // Held, not abandoned — and held at `joining`, which is the state the
    // whole mechanism exists to keep it in.
    expect(internals(node.cluster).members.get(node.address.toString())?.status).toBe('joining');

    // Once, however many gossip ticks pass: `leaderActionsTick` re-enters
    // `selfElect` on every one of them, and a line per tick would bury it.
    await sleep(QUIET_WINDOW_MS);
    expect(heldSelfElectionLines(node)).toHaveLength(1);
  });

  test('the default threshold changes nothing about the founder', async () => {
    // The compatibility half, asserted here because this is where the founder
    // path is instrumented: an unset threshold must leave the single-node run
    // exactly as it was, with no held election and no line about one.
    const node = await startNode('threshold-default', 9_714, []);
    nodes.push(node);

    // Absence assertion: nothing is ever going to arrive, so the only evidence
    // available is that the window it would have arrived in went by.
    await sleep(QUIET_WINDOW_MS);

    expect(heldSelfElectionLines(node)).toEqual([]);
    expect(thresholdWarnings(node)).toEqual([]);
    expect(internals(node.cluster).members.get(node.address.toString())?.status).toBe('up');
  });
});
