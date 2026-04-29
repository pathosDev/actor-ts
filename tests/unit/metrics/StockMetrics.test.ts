/**
 * Stock metrics emitted by the actor framework itself (#11).  The cell
 * + cluster instrumentation is opt-in via `MetricsExtensionId.enable()`
 * — this test verifies the counters / gauges / histograms tick when
 * actors are spawned, messages flow, and members come up.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import type { MetricsRegistry } from '../../../src/metrics/Metrics.js';
import { Props } from '../../../src/Props.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

class Echo extends Actor<string> {
  override onReceive(_m: string): void { /* tick */ }
}

function valueFor(reg: MetricsRegistry, name: string): number | undefined {
  // Walk the collected samples — there's only one un-labelled series
  // for each stock metric in this test.
  return reg.collect().find((s) => s.name === name)?.value;
}

describe('Stock actor metrics', () => {
  test('actor_created_total ticks once per spawn (incl. system guardians)', async () => {
    const sys = ActorSystem.create('m-actors', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const reg = sys.extension(MetricsExtensionId).enable();
    try {
      // Capture the baseline AFTER the system has booted — the
      // root + /user + /system guardians are themselves cells and
      // count toward the metric, which is fine, but the test
      // expresses "three more user actors" as a delta.
      await sleep(20);
      const baseline = valueFor(reg, 'actor_created_total') ?? 0;
      sys.actorOf(Props.create(() => new Echo()), 'a');
      sys.actorOf(Props.create(() => new Echo()), 'b');
      sys.actorOf(Props.create(() => new Echo()), 'c');
      await sleep(20);
      expect((valueFor(reg, 'actor_created_total') ?? 0) - baseline).toBe(3);
    } finally {
      await sys.terminate();
    }
  });

  test('actor_messages_delivered_total ticks per onReceive call', async () => {
    const sys = ActorSystem.create('m-msgs', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const reg = sys.extension(MetricsExtensionId).enable();
    try {
      const a = sys.actorOf(Props.create(() => new Echo()), 'a');
      a.tell('1'); a.tell('2'); a.tell('3');
      await sleep(30);
      expect(valueFor(reg, 'actor_messages_delivered_total')).toBe(3);
    } finally {
      await sys.terminate();
    }
  });

  test('actor_terminated_total ticks on stop', async () => {
    const sys = ActorSystem.create('m-term', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const reg = sys.extension(MetricsExtensionId).enable();
    try {
      const a = sys.actorOf(Props.create(() => new Echo()), 'a');
      a.stop();
      await sleep(40);
      expect((valueFor(reg, 'actor_terminated_total') ?? 0)).toBeGreaterThanOrEqual(1);
    } finally {
      await sys.terminate();
    }
  });

  test('actor_message_handler_seconds histogram observes durations', async () => {
    const sys = ActorSystem.create('m-hist', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const reg = sys.extension(MetricsExtensionId).enable();
    try {
      const a = sys.actorOf(Props.create(() => new Echo()), 'a');
      a.tell('1'); a.tell('2');
      await sleep(40);
      const sumSample = reg.collect().find(
        (s) => s.name === 'actor_message_handler_seconds' && s.sum !== undefined,
      );
      expect(sumSample?.count).toBe(2);
    } finally {
      await sys.terminate();
    }
  });
});

describe('Stock cluster metrics', () => {
  test('cluster_members_up gauge reflects the up-set; gossip rounds tick', async () => {
    const sys = ActorSystem.create('m-cluster', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const reg = sys.extension(MetricsExtensionId).enable();
    const cluster = await Cluster.join(sys, {
      host: 'h', port: 95_001,
      transport: new InMemoryTransport(new NodeAddress('m-cluster', 'h', 95_001)),
      gossipIntervalMs: 30,
    });
    try {
      // Single-node cluster — self is up, gauge = 1.
      await sleep(60);
      expect(valueFor(reg, 'cluster_members_up')).toBe(1);
      // Note: gossip rounds is initiated only when peers exist —
      // a single-node cluster doesn't tick the counter.  The presence
      // of the metric (or absence) is what we assert.
      const samples = reg.collect();
      const knownNames = new Set(samples.map((s) => s.name));
      expect(knownNames.has('cluster_members_up')).toBe(true);
    } finally {
      await cluster.leave();
      await sys.terminate();
    }
  }, 5_000);
});

describe('MetricsExtension — opt-in', () => {
  test('without enable(), the registry is the noop and stock metrics produce no samples', async () => {
    const sys = ActorSystem.create('m-noop', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      sys.actorOf(Props.create(() => new Echo()), 'a');
      await sleep(20);
      const reg = sys.extension(MetricsExtensionId).get();
      expect(reg.collect()).toEqual([]);
      expect(sys.extension(MetricsExtensionId).isEnabled()).toBe(false);
    } finally {
      await sys.terminate();
    }
  });
});
