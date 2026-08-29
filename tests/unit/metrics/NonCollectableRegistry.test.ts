/**
 * A registry whose `collect()` is not a source of truth, and what the
 * framework's own readers do with one (#744).
 *
 * The failure this pins down is not a crash but a plausible answer: a
 * write-through bridge collects to an empty list, and both readers used to
 * render that as a *quiet system* — `exportPrometheus` as a zero-byte 0.0.4
 * body (a valid empty scrape: `up=1`, every series simply gone, so threshold
 * alerts over them stop firing), and the DevTools overview as `0` messages
 * and `0` mailbox drops on a busy node.  Nothing distinguished it from an
 * idle one, and `actor_mailbox_dropped_total` is the framework's own
 * overload signal, so the reading was most reassuring exactly when it was
 * most wrong.
 */
import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { HttpExtensionId } from '../../../src/http/HttpExtension.js';
import { managementRoutes } from '../../../src/management/index.js';
import { MetricsExtensionId } from '../../../src/metrics/MetricsExtension.js';
import {
  DefaultMetricsRegistry,
  NoopMetricsRegistry,
  isCollectable,
  type Counter,
  type CounterOptions,
  type Gauge,
  type GaugeOptions,
  type Histogram,
  type HistogramOptions,
  type Labels,
  type MetricSample,
  type MetricsRegistry,
} from '../../../src/metrics/Metrics.js';
import { exportPrometheus } from '../../../src/metrics/PrometheusExporter.js';
import { NodeSampler } from '../../../src/devtools/internal/NodeSampler.js';
import { StatsTap } from '../../../src/devtools/taps/StatsTap.js';
import type { StatsSamplePayload } from '../../../src/devtools/protocol/index.js';

const MESSAGES_DELIVERED = 'actor_messages_delivered_total';

/**
 * A registry shaped like the `promClientRegistry` bridge: every mutation
 * lands in a collector this interface cannot read back, so `collect()` is
 * empty and `collectable` declares why.
 *
 * Hand-rolled rather than the real bridge on purpose — the readers under
 * test have to work for *any* registry that opts out, including one written
 * outside this repository, and dragging prom-client's structural shape in
 * here would test the bridge instead of them.  What keeps the two tied
 * together is `tests/unit/metrics/PromClientAdapter.test.ts`, which pins the
 * real bridge to exactly this shape.
 *
 * The foreign side is a real `DefaultMetricsRegistry` so a test can show the
 * values genuinely exist somewhere while the local snapshot stays empty —
 * the whole distinction between "nothing happened" and "not readable here".
 */
class WriteThroughRegistry implements MetricsRegistry {
  readonly collectable = false;
  readonly foreign = new DefaultMetricsRegistry();

  counter(name: string, labels?: Labels, options?: CounterOptions): Counter {
    return this.foreign.counter(name, labels, options);
  }
  gauge(name: string, labels?: Labels, options?: GaugeOptions): Gauge {
    return this.foreign.gauge(name, labels, options);
  }
  histogram(name: string, labels?: Labels, options?: HistogramOptions): Histogram {
    return this.foreign.histogram(name, labels, options);
  }
  collect(): ReadonlyArray<MetricSample> { return []; }
  remove(name: string, labels?: Labels): boolean { return this.foreign.remove(name, labels); }
  clear(): void { this.foreign.clear(); }
}

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, options);
}

describe('isCollectable', () => {
  test('a registry that says nothing is collectable — absent means yes', () => {
    expect(isCollectable(new DefaultMetricsRegistry())).toBe(true);
  });

  test('the noop registry is collectable: its empty snapshot is honest', () => {
    // The distinction the whole flag rests on.  A noop collects to nothing
    // because nothing was recorded, which is a true answer and one
    // `MetricsExtension.isEnabled()` already reports separately.  A
    // write-through bridge collects to nothing while the values exist.
    expect(isCollectable(new NoopMetricsRegistry())).toBe(true);
  });

  test('a write-through registry opts out', () => {
    expect(isCollectable(new WriteThroughRegistry())).toBe(false);
  });
});

describe('exportPrometheus over a non-collectable registry', () => {
  test('renders nothing at all, which is why callers must ask first', () => {
    // Characterisation, not a wish: the exporter is also wired by hand
    // (`prometheusHandler`, the manual-wiring docs) against a registry the
    // caller chose, so it stays a pure renderer.  The guard belongs at the
    // routes that pick a status code, which is what the next block covers.
    const registry = new WriteThroughRegistry();
    registry.counter(MESSAGES_DELIVERED, {}, { help: 'delivered' }).inc(41);

    expect(exportPrometheus(registry)).toBe('');
    // The value is not lost — it is in the collector the bridge forwards to.
    expect(exportPrometheus(registry.foreign)).toContain(`${MESSAGES_DELIVERED} 41`);
  });
});

describe('managementRoutes — GET /metrics against a non-collectable registry', () => {
  test('refuses with 503 instead of a 200 zero-byte scrape', async () => {
    const system = newSystem('mgmt-noncollectable');
    system.extension(MetricsExtensionId).useRegistry(new WriteThroughRegistry());
    const routes = managementRoutes(system, null, { enableMetricsEndpoint: true });
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/metrics`);
    // 503 and not 200: a scraper already knows how to treat this target as
    // down, where a zero-byte 200 marks it up with no series at all.
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('collect()');

    await binding.unbind();
    await system.terminate();
  });

  test('the check is per request, so a registry installed later is still caught', async () => {
    const system = newSystem('mgmt-noncollectable-late');
    const routes = managementRoutes(system, null, { enableMetricsEndpoint: true });
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);

    // The documented wiring order: routes first, bridge afterwards.  A guard
    // evaluated once while building the route tree would have captured the
    // default registry here and served zeros for the life of the process.
    const before = await fetch(`http://127.0.0.1:${binding.port}/metrics`);
    expect(before.status).toBe(200);

    system.extension(MetricsExtensionId).useRegistry(new WriteThroughRegistry());
    const after = await fetch(`http://127.0.0.1:${binding.port}/metrics`);
    expect(after.status).toBe(503);

    await binding.unbind();
    await system.terminate();
  });

  test('an ordinary registry still serves 200 text/plain', async () => {
    const system = newSystem('mgmt-collectable');
    system.extension(MetricsExtensionId).enable();
    const routes = managementRoutes(system, null, { enableMetricsEndpoint: true });
    const binding = await system.extension(HttpExtensionId).newServerAt('127.0.0.1', 0).bind(routes);

    const response = await fetch(`http://127.0.0.1:${binding.port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')?.toLowerCase()).toContain('text/plain');

    await binding.unbind();
    await system.terminate();
  });
});

describe('NodeSampler — figures against a non-collectable registry', () => {
  test('reports the metrics figures as unavailable rather than as zero', async () => {
    const system = newSystem('sampler-noncollectable');
    system.extension(MetricsExtensionId).useRegistry(new WriteThroughRegistry());

    const sampler = new NodeSampler(system);
    sampler.start();
    const figures = sampler.figures('local');
    sampler.stop();

    expect(figures.metricsUnavailable).toBe(true);
    // The figures that do not come from the registry stay true — blanking
    // the whole panel would hide the actor tree and the event stream, which
    // are still being read correctly.
    expect(figures.actorCount).toBeGreaterThan(0);
    await system.terminate();
  });

  test('leaves the operator\'s bridge installed rather than replacing it', async () => {
    const system = newSystem('sampler-keeps-bridge');
    const metrics = system.extension(MetricsExtensionId);
    const bridge = new WriteThroughRegistry();
    metrics.useRegistry(bridge);

    const sampler = new NodeSampler(system);
    sampler.start();
    // Installing our own registry here would fix the panel by taking the
    // operator's own /metrics route down with it — a far worse trade.
    expect(metrics.get()).toBe(bridge);
    sampler.stop();
    expect(metrics.get()).toBe(bridge);

    await system.terminate();
  });

  test('says nothing when the registry can be read back', async () => {
    const system = newSystem('sampler-collectable');
    system.extension(MetricsExtensionId).enable();

    const sampler = new NodeSampler(system);
    sampler.start();
    const figures = sampler.figures('local');
    sampler.stop();

    expect(figures.metricsUnavailable).toBeUndefined();
    await system.terminate();
  });

  test('follows a registry swapped after sampling started', async () => {
    const system = newSystem('sampler-swap');
    const metrics = system.extension(MetricsExtensionId);
    metrics.enable();

    const sampler = new NodeSampler(system);
    sampler.start();
    expect(sampler.figures('local').metricsUnavailable).toBeUndefined();

    metrics.useRegistry(new WriteThroughRegistry());
    expect(sampler.figures('local').metricsUnavailable).toBe(true);

    sampler.stop();
    await system.terminate();
  });
});

describe('StatsTap — the dashboard sample', () => {
  test('carries the unavailability up into the totals', async () => {
    const system = newSystem('stats-noncollectable');
    system.extension(MetricsExtensionId).useRegistry(new WriteThroughRegistry());
    const sampler = new NodeSampler(system);
    sampler.start();
    const tap = new StatsTap(system, null, 100_000, sampler);
    tap.install(() => {});
    try {
      const [sample] = tap.snapshot() as [StatsSamplePayload];
      // One blind node makes the sum an undercount of an unknown amount,
      // which is exactly as misleading as that node's own zeros.
      expect(sample.metricsUnavailable).toBe(true);
      expect(sample.nodes[0]!.figures.metricsUnavailable).toBe(true);
    } finally {
      tap.uninstall();
      sampler.stop();
      await system.terminate();
    }
  });

  test('says nothing when every node can be read', async () => {
    const system = newSystem('stats-collectable');
    system.extension(MetricsExtensionId).enable();
    const sampler = new NodeSampler(system);
    sampler.start();
    const tap = new StatsTap(system, null, 100_000, sampler);
    tap.install(() => {});
    try {
      const [sample] = tap.snapshot() as [StatsSamplePayload];
      expect(sample.metricsUnavailable).toBeUndefined();
    } finally {
      tap.uninstall();
      sampler.stop();
      await system.terminate();
    }
  });
});
