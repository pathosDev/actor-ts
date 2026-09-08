/**
 * #837 — three real nodes, one gate.
 *
 * The unit half (`tests/unit/cluster/MinimumMembersBeforeUpOptions.test.ts`)
 * pins the arithmetic over a hand-built member map. What only a running
 * cluster can show is the part that made this issue L rather than M: gating
 * the two promotion sites is not enough, because `leader()` is the first of
 * `upMembers()` with no fallback to a non-`up` member. Refuse the founder's
 * self-election and no leader ever comes into being, so nothing promotes
 * anyone, so the member count never rises — a deadlock that a test asserting
 * only "nobody is up while the threshold is unmet" passes with flying colours.
 *
 * Which is why every case below has a positive half. "Nobody reaches up" is
 * only worth asserting next to "and then they all do".
 *
 * There are **two** gated promotion sites, and a case only binds the one it
 * can reach. Every case that starts a cluster from cold reaches `selfElect`'s
 * gate first: the threshold is unmet from the founder's very first moment, so
 * that gate holds it `joining`, no `up` member exists, no leader exists, and
 * `promoteJoiningMembers` never gets past its own `isLeader()` line — deleting
 * the gate *inside* it changes nothing any of them observe. Reaching the second
 * site takes a cluster that formed first and then fell below its threshold,
 * which is what the regrow case at the bottom of this file is for.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

/** Fast enough to converge inside a test, slow enough to stay a real tick. */
const GOSSIP_INTERVAL_MS = 30;

/**
 * Long enough that several gossip and seed-retry rounds pass, which is what
 * makes "nobody reached up" mean "the gate held" rather than "we did not
 * wait".  The positive halves use `awaitCondition` instead and have no upper
 * bound of their own.
 */
const QUIET_WINDOW_MS = GOSSIP_INTERVAL_MS * 10;

/**
 * The per-test cap for the cases that chain two waits and a quiet window.
 *
 * Declared rather than left at bun's 5000 ms default because the sum of the
 * budgets inside one of these tests exceeds it, and a test that blows through
 * bun's cap reports "timed out after 5000ms" instead of the `awaitCondition`
 * label saying which of the waits it was — the difference between a diagnosis
 * and a shrug.  The cases converge in well under a second; this is headroom,
 * not an expectation.
 */
const TEST_TIMEOUT_MS = 20_000;

type NodeHandle = { readonly system: ActorSystem; readonly cluster: Cluster };

let nodes: NodeHandle[] = [];

afterEach(async () => {
  for (const node of nodes) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
  nodes = [];
});

type StartOptions = {
  readonly systemName: string;
  readonly port: number;
  readonly seeds: readonly string[];
  readonly minimumMembersBeforeUp?: number;
  readonly minimumMembersBeforeUpPerRole?: Readonly<Record<string, number>>;
  readonly roles?: readonly string[];
};

async function startNode(options: StartOptions): Promise<Cluster> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(options.systemName, systemOptions);
  const address = new NodeAddress(options.systemName, 'h', options.port);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(options.port)
    .withTransport(new InMemoryTransport(address))
    .withSeeds([...options.seeds])
    .withGossipIntervalMs(GOSSIP_INTERVAL_MS)
    .withSeedRetryIntervalMs(GOSSIP_INTERVAL_MS)
    .withFailureDetector({
      heartbeatIntervalMs: 60_000, unreachableAfterMs: 120_000, downAfterMs: 240_000,
    });
  if (options.roles !== undefined) clusterOptions.withRoles([...options.roles]);
  if (options.minimumMembersBeforeUp !== undefined) {
    clusterOptions.withMinimumMembersBeforeUp(options.minimumMembersBeforeUp);
  }
  if (options.minimumMembersBeforeUpPerRole !== undefined) {
    clusterOptions.withMinimumMembersBeforeUpPerRole(options.minimumMembersBeforeUpPerRole);
  }
  const cluster = await Cluster.join(system, clusterOptions);
  nodes.push({ system, cluster });
  return cluster;
}

/** How many members every node in the set considers `up`, lowest first. */
const upCounts = (clusters: readonly Cluster[]): number[] =>
  clusters.map((cluster) => cluster.upMembers().length);

describe('Cluster — minimumMembersBeforeUp (#837)', () => {
  test('two of three nodes: nobody reaches up, and the third opens the gate', async () => {
    const a = await startNode({ systemName: 'mmbu', port: 56_001, seeds: [],
      minimumMembersBeforeUp: 3 });
    const b = await startNode({ systemName: 'mmbu', port: 56_002, seeds: ['mmbu@h:56001'],
      minimumMembersBeforeUp: 3 });

    // Both nodes know each other — the seed contact landed — and neither is
    // up.  Without the first half, the second proves nothing: a cluster that
    // never exchanged a frame also has nobody up.
    await awaitCondition(() => a.getMembers().length === 2 && b.getMembers().length === 2, {
      timeoutMs: 4_000, intervalMs: 10, label: 'A and B to know about each other',
    });
    // Absence assertion: nothing will ever arrive to make this true, so the
    // elapsed gossip rounds are the whole of the evidence.
    await sleep(QUIET_WINDOW_MS);
    expect(upCounts([a, b])).toEqual([0, 0]);

    // The third member is the whole fix: A's held self-election runs, A
    // becomes leader, and the leader promotes everyone it can see.
    const c = await startNode({ systemName: 'mmbu', port: 56_003, seeds: ['mmbu@h:56001'],
      minimumMembersBeforeUp: 3 });

    await awaitCondition(
      () => upCounts([a, b, c]).every((count) => count === 3),
      { timeoutMs: 4_000, intervalMs: 10, label: 'all three nodes to reach up' },
    );
    expect(upCounts([a, b, c])).toEqual([3, 3, 3]);
  }, TEST_TIMEOUT_MS);

  test('a per-role threshold holds while the global one is already met', async () => {
    // Three members satisfy `minimumMembersBeforeUp: 3` from the first
    // moment — the gate that is closed is the role one, which is the
    // composition this asserts.  Two frontends and one backend, needing two.
    const a = await startNode({ systemName: 'mmbu-role', port: 56_011, seeds: [],
      roles: ['frontend'], minimumMembersBeforeUp: 3,
      minimumMembersBeforeUpPerRole: { backend: 2 } });
    const b = await startNode({ systemName: 'mmbu-role', port: 56_012, seeds: ['mmbu-role@h:56011'],
      roles: ['frontend'], minimumMembersBeforeUp: 3,
      minimumMembersBeforeUpPerRole: { backend: 2 } });
    const c = await startNode({ systemName: 'mmbu-role', port: 56_013, seeds: ['mmbu-role@h:56011'],
      roles: ['backend'], minimumMembersBeforeUp: 3,
      minimumMembersBeforeUpPerRole: { backend: 2 } });

    await awaitCondition(() => a.getMembers().length === 3, {
      timeoutMs: 4_000, intervalMs: 10, label: 'A to know all three members',
    });
    // Absence assertion again: the gate stays closed on its own, so only the
    // elapsed rounds separate "held" from "not yet looked".
    await sleep(QUIET_WINDOW_MS);
    // The global threshold is met and the role one is not, so this is the
    // assertion that the two compose as an AND rather than an OR.
    expect(upCounts([a, b, c])).toEqual([0, 0, 0]);

    const d = await startNode({ systemName: 'mmbu-role', port: 56_014, seeds: ['mmbu-role@h:56011'],
      roles: ['backend'], minimumMembersBeforeUp: 3,
      minimumMembersBeforeUpPerRole: { backend: 2 } });

    await awaitCondition(
      () => upCounts([a, b, c, d]).every((count) => count === 4),
      { timeoutMs: 4_000, intervalMs: 10, label: 'all four nodes to reach up' },
    );
    expect(upCounts([a, b, c, d])).toEqual([4, 4, 4, 4]);
  }, TEST_TIMEOUT_MS);

  test('the default leaves single-node self-election working unchanged', async () => {
    // The compatibility case.  It is also the one that fails loudest if the
    // gate is ever written as "hold unless someone else is here": with the
    // shipped `1`, self alone satisfies it.
    const a = await startNode({ systemName: 'mmbu-solo', port: 56_021, seeds: [] });

    await awaitCondition(() => a.upMembers().length === 1, {
      timeoutMs: 4_000, intervalMs: 10, label: 'the lone node to self-elect',
    });
    expect(a.selfElected).toBe(true);
  });

  test('a member that leaves does not demote the ones already up', async () => {
    // Evaluated per promotion, never in reverse: there is no up → joining
    // transition, so a cluster that drops below its threshold keeps what it
    // promoted.  The alternative reading of "hold Up transitions" would have
    // this cluster tear itself down when one node stops.
    const a = await startNode({ systemName: 'mmbu-shrink', port: 56_031, seeds: [],
      minimumMembersBeforeUp: 2 });
    const b = await startNode({ systemName: 'mmbu-shrink', port: 56_032,
      seeds: ['mmbu-shrink@h:56031'], minimumMembersBeforeUp: 2 });

    await awaitCondition(() => a.upMembers().length === 2 && b.upMembers().length === 2, {
      timeoutMs: 4_000, intervalMs: 10, label: 'both nodes to reach up' },
    );

    await b.leave();
    await awaitCondition(() => a.upMembers().length === 1, {
      timeoutMs: 4_000, intervalMs: 10, label: "B's departure to reach A",
    });

    // Absence assertion, and the point of the case: A is below its own
    // threshold now, and several gossip rounds have to pass with nothing
    // demoting it for "never evaluated in reverse" to mean anything.
    await sleep(QUIET_WINDOW_MS);
    expect(a.upMembers().length).toBe(1);
    expect(a.upMembers()[0]?.address.port).toBe(56_031);
  }, TEST_TIMEOUT_MS);

  test('a leader that is already up still holds a new joiner below the threshold', async () => {
    // The *second* gated promotion site — `promoteJoiningMembers` — and the
    // only case in this file that reaches it.  See the file header: from a
    // cold start the founder's own gate holds everything, so there is never a
    // leader in a position to promote and the leader's gate is unobserved.
    //
    // Here the cluster forms, shrinks below its threshold, and keeps the `up`
    // it already granted (the case above).  So a leader is sitting there with
    // the authority to promote and a member map of two — and the only thing
    // between the joiner and `up` is the gate at the top of that method.
    const a = await startNode({ systemName: 'mmbu-regrow', port: 56_041, seeds: [],
      minimumMembersBeforeUp: 3 });
    const b = await startNode({ systemName: 'mmbu-regrow', port: 56_042,
      seeds: ['mmbu-regrow@h:56041'], minimumMembersBeforeUp: 3 });
    const c = await startNode({ systemName: 'mmbu-regrow', port: 56_043,
      seeds: ['mmbu-regrow@h:56041'], minimumMembersBeforeUp: 3 });

    // Every node's own view, not just A's: `leave` announces itself to the
    // peers the *leaver* knows about, so a B that has not yet heard back from
    // the seed sends its farewell to nobody and stays `up` in A's map for
    // good.
    await awaitCondition(
      () => upCounts([a, b, c]).every((count) => count === 3),
      { timeoutMs: 4_000, intervalMs: 10, label: 'the initial three nodes to reach up' },
    );

    await b.leave();
    await c.leave();
    await awaitCondition(() => a.getMembers().length === 1, {
      timeoutMs: 4_000, intervalMs: 10, label: 'both departures to reach A',
    });
    // A is `up`, is the leader, and is the only member the threshold counts —
    // the preconditions the assertion below rests on, stated rather than
    // assumed, because every one of them is what makes the gate the only
    // remaining explanation for D staying `joining`.
    expect(a.upMembers().length).toBe(1);
    expect(a.isLeader()).toBe(true);

    const d = await startNode({ systemName: 'mmbu-regrow', port: 56_044,
      seeds: ['mmbu-regrow@h:56041'], minimumMembersBeforeUp: 3 });

    // The leader has seen D — so it has had the chance to promote it — and the
    // count is 2 of 3.  Without this first half the second proves nothing: a
    // joiner whose frame never landed is also a joiner nobody promoted.
    await awaitCondition(() => a.getMembers().length === 2, {
      timeoutMs: 4_000, intervalMs: 10, label: "D to appear in the leader's member map",
    });
    // Absence assertion: nothing will arrive to make this true, so the elapsed
    // gossip rounds are the whole of the evidence.
    await sleep(QUIET_WINDOW_MS);
    // The leader's own view first — it is the node whose gate is under test —
    // and then D's, which is what an operator would look at.
    expect(a.getMembers().find((member) => member.address.port === 56_044)?.status)
      .toBe('joining');
    expect(d.selfMember()?.status).toBe('joining');
    expect(a.upMembers().length).toBe(1);

    // The positive half: a third counted member opens the gate and the leader
    // promotes everything it was holding, in one pass.
    const e = await startNode({ systemName: 'mmbu-regrow', port: 56_045,
      seeds: ['mmbu-regrow@h:56041'], minimumMembersBeforeUp: 3 });

    await awaitCondition(
      () => upCounts([a, d, e]).every((count) => count === 3),
      { timeoutMs: 4_000, intervalMs: 10, label: 'A, D and E to reach up' },
    );
    expect(upCounts([a, d, e])).toEqual([3, 3, 3]);
  }, TEST_TIMEOUT_MS);
});
