import { afterEach, describe, expect, test } from 'bun:test';

import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { MemberConfigurationMismatch } from '../../../src/cluster/ClusterEvents.js';
import type { ClusterEvent } from '../../../src/cluster/ClusterEvents.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { GossipMessage, MemberData } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { RecordingLogger, type RecordedLog } from '../../util/RecordingLogger.js';

/**
 * #844 — two nodes that disagree about a setting the deployment asked to be
 * checked say so, once, naming the setting and both values.
 *
 * Every case here differs **only** through the builder, with both nodes on the
 * identical config layer.  That is not incidental: it is the case a check that
 * compared config *paths* would miss entirely, because precedence is
 * `explicit options > HOCON > built-in defaults` and builder-first is this
 * project's documented style.  Two nodes calling `.withMaxFrameBytes(…)` with
 * different numbers and no HOCON at all compare **equal** on
 * `actor-ts.remote.max-frame-bytes` as a config path, and unequal on the
 * effective value — which is the whole design decision, pinned here rather
 * than only written down.
 *
 * The nodes are real and gossip over `InMemoryTransport`, so the claim travels
 * the merge path a peer's frame actually takes: `handleWire` → `mergeMember` →
 * `Member.fromData`'s sanitiser → the agreement check.  A hand-injected frame
 * would skip the half that decides what a node *publishes*.
 */

const SYSTEM = 'configuration-compatibility';
const HOST = 'h';
const SIXTEEN_MEBIBYTES = 16 * 1024 * 1024;
const ONE_MEBIBYTE = 1024 * 1024;
const FRAME_CAP = 'actor-ts.remote.max-frame-bytes';

type Node = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly logger: RecordingLogger;
  readonly events: ClusterEvent[];
};

type NodeSpec = {
  readonly port: number;
  readonly seeds?: ReadonlyArray<string>;
  readonly maxFrameBytes?: number;
  readonly checkedPaths?: ReadonlyArray<string>;
  readonly enforce?: boolean;
};

const running: Node[] = [];

afterEach(async () => {
  for (const node of running.splice(0)) {
    try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await node.system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

function addressOf(port: number): string {
  return `${SYSTEM}@${HOST}:${port}`;
}

async function startNode(spec: NodeSpec): Promise<Node> {
  const logger = new RecordingLogger();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Debug);
  const system = ActorSystem.create(SYSTEM, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(HOST)
    .withPort(spec.port)
    .withTransport(new InMemoryTransport(new NodeAddress(SYSTEM, HOST, spec.port)))
    .withSeeds([...(spec.seeds ?? [])])
    .withGossipIntervalMs(30)
    .withSeedRetryIntervalMs(30);
  if (spec.maxFrameBytes !== undefined) clusterOptions.withMaxFrameBytes(spec.maxFrameBytes);
  if (spec.checkedPaths !== undefined) {
    clusterOptions.withConfigurationCompatibilityCheckedPaths([...spec.checkedPaths]);
  }
  if (spec.enforce !== undefined) {
    clusterOptions.withConfigurationCompatibilityEnforce(spec.enforce);
  }
  const cluster = await Cluster.join(system, clusterOptions);
  const events: ClusterEvent[] = [];
  cluster.subscribe((event) => { events.push(event); });
  const node: Node = { system, cluster, logger, events };
  running.push(node);
  return node;
}

async function awaitBothUp(node: Node, label: string): Promise<void> {
  await awaitCondition(() => node.cluster.upMembers().length === 2, {
    timeoutMs: 4_000, intervalMs: 20, label,
  });
}

function mismatchesOf(node: Node): MemberConfigurationMismatch[] {
  return node.events.filter(
    (event): event is MemberConfigurationMismatch => event instanceof MemberConfigurationMismatch,
  );
}

/**
 * Every line, at any level, that is the configuration-agreement diagnostic.
 *
 * The shared {@link RecordingLogger} records through `withSource` children,
 * which is the only way the cluster's own line arrives — `Cluster` logs
 * through a source-bound child.
 */
function agreementLines(node: Node): RecordedLog[] {
  return node.logger.records.filter((record) => record.message.includes(`configuration: ${FRAME_CAP}`));
}

/** The merge internals the latch cases drive, so a round is a call and not a wait. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: GossipMessage): void;
}

/**
 * One gossip frame carrying `peer`'s own record — the claim `maySpeakFor`
 * never refuses — with the frame cap it says it is running.
 */
function gossipSelfClaim(
  node: Node, peer: NodeAddress, version: number, frameCap: string,
): void {
  const members: MemberData[] = [{
    address: peer.toJSON(),
    status: 'up',
    version,
    roles: [],
    configurationFacts: { [FRAME_CAP]: frameCap },
  }];
  (node.cluster as unknown as ClusterInternals).handleWire(peer, {
    kind: 'gossip', from: peer.toJSON(), sequence: version, members,
  });
}

describe('a divergent effective value is reported once, naming both sides', () => {
  test('two nodes differing only through the builder each say so exactly once', async () => {
    const first = await startNode({ port: 58_801, maxFrameBytes: SIXTEEN_MEBIBYTES });
    const second = await startNode({
      port: 58_802, seeds: [addressOf(58_801)], maxFrameBytes: ONE_MEBIBYTE,
    });
    await awaitBothUp(second, 'the joining node saw both members up');
    await awaitCondition(() => mismatchesOf(first).length > 0 && mismatchesOf(second).length > 0, {
      timeoutMs: 4_000, intervalMs: 20, label: 'both nodes reported the divergence',
    });

    // Both directions: each node compares what the other gossips against what
    // it resolved for itself, so the pair is reported on both, with the values
    // the right way round on each.
    const [onFirst] = mismatchesOf(first);
    expect(onFirst?.fact).toBe(FRAME_CAP);
    expect(onFirst?.localValue).toBe(String(SIXTEEN_MEBIBYTES));
    expect(onFirst?.remoteValue).toBe(String(ONE_MEBIBYTE));
    expect(onFirst?.member.address.toString()).toBe(addressOf(58_802));
    expect(onFirst?.enforced).toBe(false);

    const [onSecond] = mismatchesOf(second);
    expect(onSecond?.localValue).toBe(String(ONE_MEBIBYTE));
    expect(onSecond?.remoteValue).toBe(String(SIXTEEN_MEBIBYTES));

    // The log line carries both values too — a bare "diverged" sends the
    // operator back to the two config files the message is meant to save them.
    const lines = agreementLines(first);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.message).toContain(String(SIXTEEN_MEBIBYTES));
    expect(lines[0]?.message).toContain(String(ONE_MEBIBYTE));
    expect(lines[0]?.message).toContain(addressOf(58_802));
  });

  test('the report does not repeat, however many rounds carry the claim', async () => {
    // The latch is what makes this actionable rather than a page per round:
    // gossip carries the whole member map every interval, and the check runs on
    // every merge that advances a record.  Driven by injecting the peer's
    // self-announcement twenty times with a rising version — deterministic, and
    // each one is a merge that genuinely reaches the agreement check, which a
    // wall-clock wait over live gossip could only hope for.
    const node = await startNode({ port: 58_811, maxFrameBytes: SIXTEEN_MEBIBYTES });
    const peer = new NodeAddress(SYSTEM, HOST, 58_812);

    for (let round = 0; round < 20; round++) {
      gossipSelfClaim(node, peer, Date.now() + round, String(ONE_MEBIBYTE));
    }

    expect(mismatchesOf(node)).toHaveLength(1);
    expect(agreementLines(node)).toHaveLength(1);
  });

  test('a second diverging peer is its own report — the latch is per pair', async () => {
    // Deliberately not #1358's per-field latch.  "The wire cap disagrees" with
    // no address in it cannot be acted on when the second and third peers are
    // the misconfigured ones, and the peer that reported first is usually the
    // one that is right.
    const node = await startNode({ port: 58_815, maxFrameBytes: SIXTEEN_MEBIBYTES });

    gossipSelfClaim(node, new NodeAddress(SYSTEM, HOST, 58_816), Date.now(), String(ONE_MEBIBYTE));
    gossipSelfClaim(node, new NodeAddress(SYSTEM, HOST, 58_817), Date.now(), String(ONE_MEBIBYTE));

    const reported = mismatchesOf(node).map((event) => event.member.address.toString()).sort();
    expect(reported).toEqual([addressOf(58_816), addressOf(58_817)]);
  });
});

describe('agreement and absence are both silent', () => {
  test('two nodes configured alike say nothing — the control', async () => {
    // Without this case, "no warning" is satisfied by a check that never runs
    // at all, which is what a mis-wired publish step produces.
    const first = await startNode({ port: 58_821, maxFrameBytes: SIXTEEN_MEBIBYTES });
    const second = await startNode({
      port: 58_822, seeds: [addressOf(58_821)], maxFrameBytes: SIXTEEN_MEBIBYTES,
    });
    await awaitBothUp(second, 'the joining node saw both members up');

    expect(mismatchesOf(first)).toHaveLength(0);
    expect(mismatchesOf(second)).toHaveLength(0);
    expect(agreementLines(first)).toHaveLength(0);
    // …and the check did run: the peer's claim is on the member record, which
    // is what separates "agreed" from "never compared".
    const peer = first.cluster.upMembers()
      .find((member) => member.address.toString() === addressOf(58_822));
    expect(peer?.configurationFacts?.[FRAME_CAP]).toBe(String(SIXTEEN_MEBIBYTES));
  });

  test('a peer that publishes nothing is not a divergence', async () => {
    // The mixed-version and partially-configured case: an empty `checked-paths`
    // publishes no facts at all, and absence on either side has to stay silent
    // or every rolling upgrade reports one.
    const first = await startNode({ port: 58_831, maxFrameBytes: SIXTEEN_MEBIBYTES });
    const second = await startNode({
      port: 58_832,
      seeds: [addressOf(58_831)],
      maxFrameBytes: ONE_MEBIBYTE,
      checkedPaths: [],
    });
    await awaitBothUp(second, 'the joining node saw both members up');

    const peer = first.cluster.upMembers()
      .find((member) => member.address.toString() === addressOf(58_832));
    expect(peer?.configurationFacts).toBeUndefined();
    expect(mismatchesOf(first)).toHaveLength(0);
    expect(mismatchesOf(second)).toHaveLength(0);
  });

  test('a peer that publishes OTHER facts, but not this one, is not a divergence', async () => {
    // The case the empty-`checked-paths` test above cannot reach: there the
    // claims record is absent and the check returns at its first line, so a
    // comparison that read a missing entry as "different" would still pass.
    // Here the peer publishes a record that simply does not contain the fact
    // this node checks, which is the shape a rolling deploy produces while the
    // two halves have different lists.
    const first = await startNode({
      port: 58_881, maxFrameBytes: SIXTEEN_MEBIBYTES, checkedPaths: [FRAME_CAP],
    });
    const second = await startNode({
      port: 58_882,
      seeds: [addressOf(58_881)],
      maxFrameBytes: ONE_MEBIBYTE,
      checkedPaths: ['actor-ts.cluster.tombstone.time-to-live'],
    });
    await awaitBothUp(second, 'the joining node saw both members up');

    const peer = first.cluster.upMembers()
      .find((member) => member.address.toString() === addressOf(58_882));
    expect(peer?.configurationFacts).toBeDefined();
    expect(peer?.configurationFacts?.[FRAME_CAP]).toBeUndefined();
    expect(mismatchesOf(first)).toHaveLength(0);
    expect(mismatchesOf(second)).toHaveLength(0);
  });

  test('a fact named like an Object.prototype member is read off the peer, not the prototype', async () => {
    // `claims` is a plain object and the pattern that admits a fact name admits
    // `constructor`, so a read that is not `hasOwn`-guarded answers with
    // `Object.prototype.constructor` — never `undefined`, never equal to ours,
    // and therefore a permanent false divergence on every peer that does not
    // publish that name.
    const node = await startNode({
      port: 58_891, maxFrameBytes: SIXTEEN_MEBIBYTES, checkedPaths: [FRAME_CAP, 'constructor'],
    });
    node.cluster.publishConfigurationFact('constructor', 'ours');
    const peer = new NodeAddress(SYSTEM, HOST, 58_892);

    gossipSelfClaim(node, peer, Date.now(), String(SIXTEEN_MEBIBYTES));

    expect(node.cluster.upMembers()
      .find((member) => member.address.equals(peer))?.configurationFacts?.[FRAME_CAP])
      .toBe(String(SIXTEEN_MEBIBYTES));
    expect(mismatchesOf(node)).toHaveLength(0);
  });

  test('a fact outside checked-paths never leaves the node', async () => {
    // `checked-paths` is an allow-list of what is PUBLISHED, which is why there
    // is no second list of paths to redact: a path absent from it is not on the
    // wire to redact.
    const first = await startNode({
      port: 58_841,
      maxFrameBytes: SIXTEEN_MEBIBYTES,
      checkedPaths: ['actor-ts.cluster.tombstone.time-to-live'],
    });
    const second = await startNode({
      port: 58_842,
      seeds: [addressOf(58_841)],
      maxFrameBytes: ONE_MEBIBYTE,
      checkedPaths: ['actor-ts.cluster.tombstone.time-to-live'],
    });
    await awaitBothUp(second, 'the joining node saw both members up');

    const peer = first.cluster.upMembers()
      .find((member) => member.address.toString() === addressOf(58_842));
    expect(peer?.configurationFacts?.[FRAME_CAP]).toBeUndefined();
    expect(peer?.configurationFacts?.['actor-ts.cluster.tombstone.time-to-live']).toBeDefined();
    expect(mismatchesOf(first)).toHaveLength(0);
  });
});

describe('what enforcement changes, and what it deliberately does not', () => {
  test('with enforce off a diverging peer is still a placement candidate', async () => {
    const first = await startNode({ port: 58_851, maxFrameBytes: SIXTEEN_MEBIBYTES });
    const second = await startNode({
      port: 58_852, seeds: [addressOf(58_851)], maxFrameBytes: ONE_MEBIBYTE,
    });
    await awaitBothUp(second, 'the joining node saw both members up');
    await awaitCondition(() => mismatchesOf(first).length > 0, {
      timeoutMs: 4_000, intervalMs: 20, label: 'the divergence was reported',
    });

    expect(first.cluster.placementCandidates().map((member) => member.address.toString()).sort())
      .toEqual([addressOf(58_851), addressOf(58_852)]);
  });

  test('with enforce on the diverging peer is barred, and the line is an error', async () => {
    const first = await startNode({
      port: 58_861, maxFrameBytes: SIXTEEN_MEBIBYTES, enforce: true,
    });
    const second = await startNode({
      port: 58_862, seeds: [addressOf(58_861)], maxFrameBytes: ONE_MEBIBYTE,
    });
    await awaitBothUp(second, 'the joining node saw both members up');
    await awaitCondition(() => mismatchesOf(first).length > 0, {
      timeoutMs: 4_000, intervalMs: 20, label: 'the divergence was reported',
    });

    // The whole of what enforcement does: this node stops placing work on that
    // peer.  It is never downed — a misconfigured majority would otherwise
    // evict a correctly-configured minority, turning a warning into an outage.
    expect(first.cluster.placementCandidates().map((member) => member.address.toString()))
      .toEqual([addressOf(58_861)]);
    expect(first.cluster.upMembers()).toHaveLength(2);
    expect(second.cluster.upMembers()).toHaveLength(2);

    const lines = agreementLines(first);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('error');
    expect(mismatchesOf(first)[0]?.enforced).toBe(true);

    // The peer, which is not enforcing, keeps placing work on this node: the
    // candidacy view is per-node and asymmetric by construction, which is
    // exactly why nothing *elected* is allowed to read it.
    expect(second.cluster.placementCandidates()).toHaveLength(2);
  });

  test('an agreeing peer is a candidate even while enforcement is on', async () => {
    // The control for the case above — without it, "barred" is satisfied by an
    // enforcement flag that bars every peer.
    const first = await startNode({
      port: 58_871, maxFrameBytes: SIXTEEN_MEBIBYTES, enforce: true,
    });
    const second = await startNode({
      port: 58_872, seeds: [addressOf(58_871)], maxFrameBytes: SIXTEEN_MEBIBYTES,
    });
    await awaitBothUp(second, 'the joining node saw both members up');

    expect(first.cluster.placementCandidates().map((member) => member.address.toString()).sort())
      .toEqual([addressOf(58_871), addressOf(58_872)]);
  });
});
