import { describe, expect, test } from 'bun:test';
import { DefaultMetricsRegistry, type MetricSample } from '../../../src/metrics/Metrics.js';
import { counterTotal, handlerLatency } from '../../../src/devtools/internal/MetricsDigest.js';
import { NodeSampler } from '../../../src/devtools/internal/NodeSampler.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';

/** Real registry rather than hand-built samples — the shape stays honest. */
function snapshot(build: (registry: DefaultMetricsRegistry) => void): ReadonlyArray<MetricSample> {
  const registry = new DefaultMetricsRegistry();
  build(registry);
  return registry.collect();
}

describe('counterTotal', () => {
  test('is 0 for a family nobody has touched', () => {
    expect(counterTotal([], 'actor_messages_delivered_total')).toBe(0);
  });

  test('reads an unlabelled counter', () => {
    const samples = snapshot((registry) => {
      registry.counter('actor_messages_delivered_total').inc(7);
    });
    expect(counterTotal(samples, 'actor_messages_delivered_total')).toBe(7);
  });

  test('sums every series of a labelled family', () => {
    const samples = snapshot((registry) => {
      registry.counter('actor_mailbox_dropped_total', { path: '/user/a', reason: 'drop-new' }).inc(2);
      registry.counter('actor_mailbox_dropped_total', { path: '/user/b', reason: 'drop-head' }).inc(3);
      registry.counter('unrelated_total').inc(99);
    });
    expect(counterTotal(samples, 'actor_mailbox_dropped_total')).toBe(5);
  });
});

describe('handlerLatency', () => {
  test('is null before any observation — an unknown percentile is not 0 ms', () => {
    expect(handlerLatency([], 'actor_message_handler_seconds')).toBeNull();
    const empty = snapshot((registry) => { registry.histogram('actor_message_handler_seconds'); });
    expect(handlerLatency(empty, 'actor_message_handler_seconds')).toBeNull();
  });

  test('interpolates inside the bucket the quantile falls into', () => {
    // Bounds 0.01 / 0.02, four observations at 10 ms and one at 20 ms.
    const samples = snapshot((registry) => {
      const histogram = registry.histogram('h', {}, { buckets: [0.01, 0.02] });
      for (let i = 0; i < 4; i++) histogram.observe(0.01);
      histogram.observe(0.02);
    });
    const latency = handlerLatency(samples, 'h');
    expect(latency).not.toBeNull();
    expect(latency!.count).toBe(5);
    // p50 → target 2.5, inside the first bucket: 0 + 10ms * (2.5/4).
    expect(latency!.p50Ms).toBeCloseTo(6.25, 5);
    // p99 → target 4.95, into the second bucket: 10ms + 10ms * (0.95/1).
    expect(latency!.p99Ms).toBeCloseTo(19.5, 5);
  });

  test('never interpolates towards +Inf', () => {
    const samples = snapshot((registry) => {
      // Everything lands above the last finite bound, so both quantiles
      // resolve in the +Inf bucket.
      registry.histogram('h', {}, { buckets: [0.001] }).observe(5);
    });
    const latency = handlerLatency(samples, 'h');
    expect(latency!.p99Ms).toBe(1);
    expect(Number.isFinite(latency!.p50Ms)).toBe(true);
  });

  test('folds label series into one system-wide figure', () => {
    const samples = snapshot((registry) => {
      registry.histogram('h', { path: '/user/a' }, { buckets: [0.01] }).observe(0.005);
      registry.histogram('h', { path: '/user/b' }, { buckets: [0.01] }).observe(0.005);
    });
    expect(handlerLatency(samples, 'h')!.count).toBe(2);
  });
});

describe('NodeSampler — metrics ownership', () => {
  test('switches metrics on while sampling and hands them back on stop', () => {
    const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('sampler-metrics', options);
    const metrics = system.extension(MetricsExtensionId);
    expect(metrics.isEnabled()).toBe(false);

    const sampler = new NodeSampler(system);
    sampler.start();
    expect(metrics.isEnabled()).toBe(true);

    sampler.stop();
    expect(metrics.isEnabled()).toBe(false);
    void system.terminate();
  });

  test('leaves a registry the application enabled itself alone', () => {
    const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const system = ActorSystem.create('sampler-metrics-preowned', options);
    const metrics = system.extension(MetricsExtensionId);
    const registry = metrics.enable();

    const sampler = new NodeSampler(system);
    sampler.start();
    sampler.stop();

    expect(metrics.isEnabled()).toBe(true);
    expect(metrics.get()).toBe(registry);
    void system.terminate();
  });
});
