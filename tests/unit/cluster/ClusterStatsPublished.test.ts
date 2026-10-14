/**
 * #842 — `actor-ts.cluster.publish-stats-interval` and the
 * `ClusterStatsPublished` event it paces.
 *
 * Driven by a {@link ManualScheduler} rather than by wall-clock sleeps: the
 * whole claim is "one sample per interval, and none at all when the interval
 * is 0", which a real timer can only ever be asked about approximately.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions, type ClusterOptionsBuilder } from '../../../src/cluster/ClusterOptions.js';
import { ClusterStatsPublished } from '../../../src/cluster/ClusterEvents.js';
import type { ClusterEvent } from '../../../src/cluster/ClusterEvents.js';
import type { FailureDetectorOptionsType } from '../../../src/cluster/FailureDetectorOptions.js';
import type { Member } from '../../../src/cluster/Member.js';
import type { MemberStatus, WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { Config } from '../../../src/config/Config.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const INTERVAL_MS = 250;

/** What a case configures; each one names only the inputs it is about. */
type NodeSpec = {
  /** Passed to `withPublishStatsIntervalMs`; absent leaves the builder field unset. */
  readonly intervalMs?: number;
  /** Layered over `reference.conf` through `ActorSystemOptions.withConfig`. */
  readonly hocon?: string;
  /** Detector thresholds, for the case that needs a member to fall silent. */
  readonly failureDetector?: Partial<FailureDetectorOptionsType>;
};

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly scheduler: ManualScheduler;
  readonly seen: ClusterStatsPublished[];
};

/** The private surface the mixed-membership case drives: the entry point a peer's frame takes, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
  readonly members: Map<string, Member>;
}

function internals(cluster: Cluster): ClusterInternals {
  return cluster as unknown as ClusterInternals;
}

/** Collects the event off `system.eventStream`, where a real subscriber sits. */
class StatsCollector extends Actor<ClusterStatsPublished> {
  constructor(private readonly seen: ClusterStatsPublished[]) { super(); }
  override onReceive(event: ClusterStatsPublished): void { this.seen.push(event); }
}

function createSystem(systemName: string, scheduler: ManualScheduler, hocon?: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler);
  if (hocon !== undefined) systemOptions.withConfig(Config.parseString(hocon));
  return ActorSystem.create(systemName, systemOptions);
}

function clusterOptionsFor(systemName: string, port: number, spec: NodeSpec): ClusterOptionsBuilder {
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)));
  if (spec.intervalMs !== undefined) clusterOptions.withPublishStatsIntervalMs(spec.intervalMs);
  if (spec.failureDetector !== undefined) clusterOptions.withFailureDetector(spec.failureDetector);
  return clusterOptions;
}

async function startNode(systemName: string, port: number, spec: NodeSpec): Promise<Harness> {
  const scheduler = new ManualScheduler();
  const system = createSystem(systemName, scheduler, spec.hocon);
  const clusterOptions = clusterOptionsFor(systemName, port, spec);
  const cluster = await Cluster.join(system, clusterOptions);
  const seen: ClusterStatsPublished[] = [];
  cluster.subscribe((event: ClusterEvent) => {
    if (event instanceof ClusterStatsPublished) seen.push(event);
  });
  return { system, cluster, scheduler, seen };
}

/** A peer of the node under test: same system and host, its own port. */
function peerOf(harness: Harness, port: number): NodeAddress {
  return new NodeAddress(harness.system.name, 'h', port);
}

/**
 * The peer's own gossip frame, announcing itself at `status` (the one claim
 * `maySpeakFor` never refuses), handed in where the transport hands a frame
 * over.  So it takes the real merge path, and the detector hears from the
 * peer at the scheduler's current instant.
 */
function gossipFrom(harness: Harness, peer: NodeAddress, status: MemberStatus): void {
  const stamp = Date.now();
  internals(harness.cluster).handleWire(peer, {
    kind: 'gossip',
    from: peer.toJSON(),
    sequence: stamp,
    members: [{ address: peer.toJSON(), status, version: stamp, roles: [] }],
  });
}

/** The peer's own `leave` frame, which leaves a `removed` tombstone in the member map. */
function leaveFrom(harness: Harness, peer: NodeAddress): void {
  internals(harness.cluster).handleWire(peer, { kind: 'leave', node: peer.toJSON() });
}

async function stop(harness: Harness): Promise<void> {
  try { await harness.cluster.leave(); } catch { /* teardown is best-effort */ }
  await harness.system.terminate();
}

describe('publish-stats-interval (#842)', () => {
  test('one sample per interval, on the cluster listener', async () => {
    const harness = await startNode('stats-cadence', 63_401, { intervalMs: INTERVAL_MS });

    harness.scheduler.advance(INTERVAL_MS * 3);

    // Exactly three, not "at least one": a fixed-rate timer that re-armed
    // itself twice per tick, or one armed with a zero initial delay, would
    // both still satisfy a >= 1 assertion.
    expect(harness.seen.length).toBe(3);

    await stop(harness);
  });

  test('the first sample waits a whole interval', async () => {
    const harness = await startNode('stats-initial', 63_402, { intervalMs: INTERVAL_MS });

    harness.scheduler.advance(INTERVAL_MS - 1);
    expect(harness.seen.length).toBe(0);
    harness.scheduler.advance(1);
    expect(harness.seen.length).toBe(1);

    await stop(harness);
  });

  test('0 arms no timer at all', async () => {
    const harness = await startNode('stats-off', 63_403, { intervalMs: 0 });

    // Far past any plausible cadence.  The shipped value is 0, so this is the
    // behaviour every node gets unless a deployment asks otherwise.
    harness.scheduler.advance(60 * 60_000);

    expect(harness.seen).toEqual([]);

    await stop(harness);
  });

  test('the sample carries the live membership counts', async () => {
    const harness = await startNode('stats-counts', 63_404, { intervalMs: INTERVAL_MS });

    harness.scheduler.advance(INTERVAL_MS);

    const sample = harness.seen[0]!;
    expect(sample.members).toBe(harness.cluster.getMembers().length);
    expect(sample.up).toBe(harness.cluster.upMembers().length);
    expect(sample.unreachable).toBe(0);
    expect(sample.selfAddress).toBe(harness.cluster.selfAddress);
    expect(sample.leader.fold(() => null as string | null, (m) => m.address.toString()))
      .toBe(harness.cluster.leader().fold(() => null as string | null, (m) => m.address.toString()));
    // A single node counts itself, so the assertions above are about a real
    // membership rather than about three zeros agreeing with three zeros.
    expect(sample.members).toBe(1);

    await stop(harness);
  });

  test('it reaches system.eventStream, not only cluster.subscribe', async () => {
    // The two channels are why `Cluster.emit` exists: a plain actor that never
    // heard of `Cluster` can subscribe to the class and receive samples.
    const harness = await startNode('stats-event-stream', 63_405, { intervalMs: INTERVAL_MS });
    const fromStream: ClusterStatsPublished[] = [];
    const collector = harness.system.spawnAnonymous(() => new StatsCollector(fromStream));
    harness.system.eventStream.subscribe(collector, ClusterStatsPublished);

    harness.scheduler.advance(INTERVAL_MS);

    await awaitCondition(() => fromStream.length === 1, {
      label: 'the periodic sample reached a system.eventStream subscriber',
    });
    expect(fromStream[0]!.members).toBe(1);

    await stop(harness);
  });

  test('a sample is never replayed to a later subscriber', async () => {
    // Every other member of the union states a change, so replaying it
    // reconstructs a subscriber's starting point.  This one states a
    // measurement, and a replayed measurement is just stale.
    const harness = await startNode('stats-no-replay', 63_406, { intervalMs: INTERVAL_MS });
    harness.scheduler.advance(INTERVAL_MS * 2);
    expect(harness.seen.length).toBe(2);

    for (const replayMode of ['events', 'snapshot'] as const) {
      const replayed: ClusterEvent[] = [];
      harness.cluster.subscribe((event) => { replayed.push(event); }, { replayMode });
      expect(replayed.some((event) => event instanceof ClusterStatsPublished)).toBe(false);
      // Not vacuous: the replay did deliver something, it simply never
      // includes the sample.
      expect(replayed.length).toBeGreaterThan(0);
    }

    await stop(harness);
  });

  test('the HOCON leaf alone arms the timer', async () => {
    // Every case above sets the interval through the builder, so the reader
    // was pinned to its output and nothing showed that output reaching the
    // timer.  No builder call here: the leaf is the only source.
    const harness = await startNode('stats-hocon-only', 63_407, {
      hocon: `actor-ts.cluster.publish-stats-interval = ${INTERVAL_MS}ms`,
    });

    harness.scheduler.advance(INTERVAL_MS * 3);

    expect(harness.seen.length).toBe(3);

    await stop(harness);
  });

  test('a negative interval is refused when the cluster starts, naming the field', async () => {
    // `0` is the off switch, so a negative value has no meaning at all.
    // Unchecked it would arm nothing, which reads exactly like `0`: a typo
    // that silently turns the samples off.
    const scheduler = new ManualScheduler();
    const system = createSystem('stats-negative', scheduler);
    const clusterOptions = clusterOptionsFor('stats-negative', 63_408, { intervalMs: -5 });
    let cluster: Cluster | null = null;
    let refusal: unknown = null;
    try {
      cluster = await Cluster.join(system, clusterOptions);
    } catch (error) {
      refusal = error;
    }

    try {
      expect(refusal).toBeInstanceOf(OptionsError);
      expect((refusal as OptionsError).message).toContain('publishStatsIntervalMs');
    } finally {
      // Only reached with a cluster when the refusal is missing, which is the
      // failure this case exists to report.
      if (cluster !== null) await cluster.leave();
      await system.terminate();
    }
  });

  test('leave() stops the samples', async () => {
    const harness = await startNode('stats-leave', 63_409, { intervalMs: INTERVAL_MS });
    harness.scheduler.advance(INTERVAL_MS * 2);
    expect(harness.seen.length).toBe(2);

    await harness.cluster.leave();
    // Many intervals on.  A timer that outlived the membership would go on
    // describing a cluster this node is no longer part of.
    harness.scheduler.advance(INTERVAL_MS * 20);

    expect(harness.seen.length).toBe(2);

    await harness.system.terminate();
  });

  test('members, up and unreachable are counted apart', async () => {
    // A single node samples 1 / 1 / 0, which a sample hard-coding
    // `up = members` and `unreachable = 0` reproduces exactly.  This member
    // map makes the three counts differ, and every entry gets there the way a
    // real one does: through its own gossip frame, the detector's tick, or its
    // own leave.
    const harness = await startNode('stats-mixed', 63_410, {
      intervalMs: 2_500,
      failureDetector: { heartbeatIntervalMs: 1_000, unreachableAfterMs: 2_000, downAfterMs: 600_000 },
    });
    const silent = peerOf(harness, 63_412);
    gossipFrom(harness, silent, 'up');
    // Heard from once, at 0, so the detector's tick at 2 s marks it unreachable.
    harness.scheduler.advance(2_000);

    const live = peerOf(harness, 63_411);
    const leaving = peerOf(harness, 63_413);
    const departed = peerOf(harness, 63_414);
    gossipFrom(harness, live, 'up');
    gossipFrom(harness, leaving, 'leaving');
    gossipFrom(harness, departed, 'up');
    leaveFrom(harness, departed);

    // The fixture, asserted rather than assumed, including the tombstone that
    // `getMembers()` leaves out and a count over the raw map would not.
    expect(harness.cluster.getMembers().map((member) => member.status).sort())
      .toEqual(['leaving', 'unreachable', 'up', 'up']);
    expect(internals(harness.cluster).members.get(departed.toString())?.status).toBe('removed');

    harness.scheduler.advance(500);

    expect(harness.seen.length).toBe(1);
    const sample = harness.seen[0]!;
    expect({ members: sample.members, up: sample.up, unreachable: sample.unreachable })
      .toEqual({ members: 4, up: 2, unreachable: 1 });
    // Self has the lowest address of the two `up` members, so it leads.
    expect(sample.leader.fold(() => null as string | null, (m) => m.address.toString()))
      .toBe(harness.cluster.selfAddress.toString());

    await stop(harness);
  });
});
