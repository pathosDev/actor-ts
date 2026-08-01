/**
 * Verify the Prometheus 0.0.4 text-format exposition (#11).  We
 * include a few specific format-compliance points the spec calls out:
 *
 *   - `# HELP` and `# TYPE` lines per family.
 *   - Counter names typically end in `_total` — we don't enforce, but
 *     the test data follows the convention.
 *   - Histogram emits `_bucket{le="X"}`, then `_sum`, then `_count`.
 *   - Label values are escaped (backslash, newline, double-quote).
 *   - Trailing newline on non-empty output.
 */
import { describe, expect, test } from 'bun:test';
import { DefaultMetricsRegistry } from '../../../src/metrics/Metrics.js';
import {
  exportPrometheus,
  prometheusHandler,
} from '../../../src/metrics/PrometheusExporter.js';

describe('exportPrometheus — counters', () => {
  test('counter family renders HELP, TYPE and one row per labelled series', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits_total', { node: 'n-1' }, { help: 'Hits per node' }).inc(3);
    registry.counter('hits_total', { node: 'n-2' }).inc(7);
    const text = exportPrometheus(registry);
    expect(text).toContain('# HELP hits_total Hits per node');
    expect(text).toContain('# TYPE hits_total counter');
    expect(text).toContain('hits_total{node="n-1"} 3');
    expect(text).toContain('hits_total{node="n-2"} 7');
  });

  test('un-labelled counter renders without braces', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('plain_total', {}).inc(2);
    expect(exportPrometheus(registry)).toContain('plain_total 2');
  });

  test('label values are escaped (backslash, newline, double-quote)', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('m_total', { msg: 'a"b\nc\\d' }).inc();
    const text = exportPrometheus(registry);
    expect(text).toContain('msg="a\\"b\\nc\\\\d"');
  });
});

describe('exportPrometheus — gauges', () => {
  test('gauge family renders TYPE gauge and one row per series', () => {
    const registry = new DefaultMetricsRegistry();
    registry.gauge('depth', { queue: 'main' }, { help: 'Queue depth' }).set(42);
    const text = exportPrometheus(registry);
    expect(text).toContain('# HELP depth Queue depth');
    expect(text).toContain('# TYPE depth gauge');
    expect(text).toContain('depth{queue="main"} 42');
  });
});

describe('exportPrometheus — histograms', () => {
  test('histogram emits _bucket rows in cumulative ascending order, then _sum and _count', () => {
    const registry = new DefaultMetricsRegistry();
    const histogram = registry.histogram('latency', {}, {
      help: 'Latency seconds', buckets: [0.1, 1],
    });
    histogram.observe(0.05);  // 0.1 + 1 + +Inf
    histogram.observe(0.7);   // 1 + +Inf
    histogram.observe(2);     // +Inf
    const text = exportPrometheus(registry);
    expect(text).toContain('# TYPE latency histogram');
    expect(text).toContain('latency_bucket{le="0.1"} 1');
    expect(text).toContain('latency_bucket{le="1"} 2');
    expect(text).toContain('latency_bucket{le="+Inf"} 3');
    expect(text).toContain('latency_sum 2.75');
    expect(text).toContain('latency_count 3');
    // Order: bucket(le=0.1), bucket(le=1), bucket(le=+Inf), sum, count.
    const lines = text.split('\n');
    const bIndex = lines.findIndex((l) => l.startsWith('latency_bucket{le="+Inf"}'));
    const sIndex = lines.findIndex((l) => l.startsWith('latency_sum'));
    const cIndex = lines.findIndex((l) => l.startsWith('latency_count'));
    expect(bIndex).toBeLessThan(sIndex);
    expect(sIndex).toBeLessThan(cIndex);
  });
});

describe('exportPrometheus — formatting', () => {
  test('empty registry → empty string', () => {
    expect(exportPrometheus(new DefaultMetricsRegistry())).toBe('');
  });

  test('non-empty output ends in newline', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('x_total', {}).inc();
    expect(exportPrometheus(registry).endsWith('\n')).toBe(true);
  });
});

describe('prometheusHandler', () => {
  test('returns Prometheus-content-typed text', async () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('reqs_total', { route: '/api' }).inc(42);
    const handler = prometheusHandler(registry);
    const response = handler(new Request('http://localhost/metrics'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')?.startsWith('text/plain')).toBe(true);
    const body = await response.text();
    expect(body).toContain('reqs_total{route="/api"} 42');
  });
});
