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
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { ClusterStatsPublished } from '../../../src/cluster/ClusterEvents.js';
import type { ClusterEvent } from '../../../src/cluster/ClusterEvents.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const INTERVAL_MS = 250;

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly scheduler: ManualScheduler;
  readonly seen: ClusterStatsPublished[];
};

/** Collects the event off `system.eventStream`, where a real subscriber sits. */
class StatsCollector extends Actor<ClusterStatsPublished> {
  constructor(private readonly seen: ClusterStatsPublished[]) { super(); }
  override onReceive(event: ClusterStatsPublished): void { this.seen.push(event); }
}

async function startNode(systemName: string, port: number, intervalMs: number): Promise<Harness> {
  const scheduler = new ManualScheduler();
  const system = ActorSystem.create(systemName, ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler));
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withTransport(new InMemoryTransport(new NodeAddress(systemName, 'h', port)))
    .withPublishStatsIntervalMs(intervalMs);
  const cluster = await Cluster.join(system, clusterOptions);
  const seen: ClusterStatsPublished[] = [];
  cluster.subscribe((event: ClusterEvent) => {
    if (event instanceof ClusterStatsPublished) seen.push(event);
  });
  return { system, cluster, scheduler, seen };
}

async function stop(harness: Harness): Promise<void> {
  try { await harness.cluster.leave(); } catch { /* teardown is best-effort */ }
  await harness.system.terminate();
}

describe('publish-stats-interval (#842)', () => {
  test('one sample per interval, on the cluster listener', async () => {
    const harness = await startNode('stats-cadence', 63_401, INTERVAL_MS);

    harness.scheduler.advance(INTERVAL_MS * 3);

    // Exactly three, not "at least one": a fixed-rate timer that re-armed
    // itself twice per tick, or one armed with a zero initial delay, would
    // both still satisfy a >= 1 assertion.
    expect(harness.seen.length).toBe(3);

    await stop(harness);
  });

  test('the first sample waits a whole interval', async () => {
    const harness = await startNode('stats-initial', 63_402, INTERVAL_MS);

    harness.scheduler.advance(INTERVAL_MS - 1);
    expect(harness.seen.length).toBe(0);
    harness.scheduler.advance(1);
    expect(harness.seen.length).toBe(1);

    await stop(harness);
  });

  test('0 arms no timer at all', async () => {
    const harness = await startNode('stats-off', 63_403, 0);

    // Far past any plausible cadence.  The shipped value is 0, so this is the
    // behaviour every node gets unless a deployment asks otherwise.
    harness.scheduler.advance(60 * 60_000);

    expect(harness.seen).toEqual([]);

    await stop(harness);
  });

  test('the sample carries the live membership counts', async () => {
    const harness = await startNode('stats-counts', 63_404, INTERVAL_MS);

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
    const harness = await startNode('stats-event-stream', 63_405, INTERVAL_MS);
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
    const harness = await startNode('stats-no-replay', 63_406, INTERVAL_MS);
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
});
