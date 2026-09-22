/**
 * Verify the Prometheus 0.0.4 text-format exposition (#11).  We
 * include a few specific format-compliance points the spec calls out:
 *
 *   - `# HELP` and `# TYPE` lines per family.
 *   - Counter names typically end in `_total` — we don't enforce, but
 *     the test data follows the convention.
 *   - Histogram emits `_bucket{le="X"}`, then `_sum`, then `_count`.
 *   - Label values are escaped (backslash, line feed, double-quote) and
 *     `# HELP` for all but the quote — exactly the escape table 0.0.4
 *     defines, and nothing beyond it (#784, #1414).
 *   - Every other C0 control except TAB is **removed** from both
 *     positions rather than escaped, because an escape the table does not
 *     define makes prometheus/common's parser reject the whole body
 *     (#1414).
 *   - Trailing newline on non-empty output.
 */
import { describe, expect, test } from 'bun:test';
import { DefaultMetricsRegistry, type MetricSample } from '../../../src/metrics/Metrics.js';
import {
  exportPrometheus,
  prometheusHandler,
  renderPrometheusSamples,
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

  test('a carriage return is removed from both positions, not escaped (#1414)', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('m_total', { msg: 'a\rb' }, { help: 'one\rtwo' }).inc();
    const text = exportPrometheus(registry);
    // `\r` is not in the 0.0.4 escape table, and the two Go readers disagree
    // about one that appears anyway: prometheus/common's classic parser takes
    // an undefined escape for a syntax error and fails the *whole body* with
    // it, while the scrape-path lexer hands the two characters through as
    // data.  Removing the byte is the one outcome both accept — and it still
    // serves the readers that motivated #784, the ones that split a line on a
    // lone CR.
    expect(text).toContain('msg="ab"');
    expect(text).toContain('# HELP m_total onetwo');
    expect(text.includes('\r')).toBe(false);
    expect(text.includes('\\r')).toBe(false);
  });

  test('every other C0 control goes with it, in both positions, and TAB stays (#1414)', () => {
    // The CR was never alone: before #1414 the exporter passed NUL, SOH, the
    // unit separator and the rest through raw in both positions, so the body
    // carried control bytes the moment a label value did.  They leave under
    // one rule rather than a special case for the character an issue happened
    // to name.  TAB is the exception both Go lexers explicitly admit
    // (`[^\\"]` for a quoted value, `C [^\n]` for a HELP string).
    const registry = new DefaultMetricsRegistry();
    registry.counter('c_total', { msg: 'a\x00b\x01c\x1fd\te' }, { help: 'p\x01q\x1br\ts' }).inc();
    const text = exportPrometheus(registry);
    expect(text).toContain('msg="abcd\te"');
    expect(text).toContain('# HELP c_total pqr\ts');
    // And nothing anywhere in the body a reader could take for a control
    // byte: TAB (0x09) and the line separators (0x0a) are the two survivors.
    expect(/[\x00-\x08\x0b-\x1f]/.test(text)).toBe(false);
  });

  test('a line feed is escaped rather than removed — it is in the escape table (#1414)', () => {
    // The rule is not "controls are dangerous, delete them": it is "the
    // escape table has three entries, and a character outside it cannot be
    // escaped at all".  LF is inside it, so it keeps the escape it had.
    const registry = new DefaultMetricsRegistry();
    registry.counter('n_total', { msg: 'a\nb' }, { help: 'one\ntwo' }).inc();
    const text = exportPrometheus(registry);
    expect(text).toContain('msg="a\\nb"');
    expect(text).toContain('# HELP n_total one\\ntwo');
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

describe('renderPrometheusSamples — a sample list from several registries (#1570)', () => {
  test('exportPrometheus is the renderer over collect(), byte for byte', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits_total', { node: 'n-1' }, { help: 'Hits' }).inc(3);
    registry.histogram('lat_seconds', {}, { buckets: [0.1, 1] }).observe(0.5);
    expect(exportPrometheus(registry)).toBe(renderPrometheusSamples(registry.collect()));
  });

  test('one family contributed by two threads renders a single HELP and TYPE, with one row per label set', () => {
    const main = new DefaultMetricsRegistry();
    main.counter('actor_messages_delivered_total', {}, { help: 'Delivered' }).inc(5);
    const worker = new DefaultMetricsRegistry();
    worker.counter('actor_messages_delivered_total', {}, { help: 'Delivered' }).inc(7);
    const stamp = (samples: ReadonlyArray<MetricSample>, thread: string): MetricSample[] =>
      samples.map((s) => ({ ...s, labels: { ...s.labels, thread } }));

    const text = renderPrometheusSamples([...stamp(main.collect(), 'main'), ...stamp(worker.collect(), 'worker-0')]);

    expect(text.match(/# HELP actor_messages_delivered_total/g)).toHaveLength(1);
    expect(text.match(/# TYPE actor_messages_delivered_total counter/g)).toHaveLength(1);
    expect(text).toBe(
      '# HELP actor_messages_delivered_total Delivered\n'
      + '# TYPE actor_messages_delivered_total counter\n'
      + 'actor_messages_delivered_total{thread="main"} 5\n'
      + 'actor_messages_delivered_total{thread="worker-0"} 7\n',
    );
  });

  test('a histogram contributed by two threads keeps each thread’s buckets, sum and count together', () => {
    const main = new DefaultMetricsRegistry();
    main.histogram('h_seconds', {}, { buckets: [1] }).observe(0.5);
    const worker = new DefaultMetricsRegistry();
    worker.histogram('h_seconds', {}, { buckets: [1] }).observe(2);
    const stamp = (samples: ReadonlyArray<MetricSample>, thread: string): MetricSample[] =>
      samples.map((s) => ({ ...s, labels: { ...s.labels, thread } }));

    const text = renderPrometheusSamples([...stamp(main.collect(), 'main'), ...stamp(worker.collect(), 'worker-0')]);

    expect(text.match(/# TYPE h_seconds histogram/g)).toHaveLength(1);
    expect(text).toBe(
      '# TYPE h_seconds histogram\n'
      + 'h_seconds_bucket{le="1",thread="main"} 1\n'
      + 'h_seconds_bucket{le="+Inf",thread="main"} 1\n'
      + 'h_seconds_sum{thread="main"} 0.5\n'
      + 'h_seconds_count{thread="main"} 1\n'
      + 'h_seconds_bucket{le="1",thread="worker-0"} 0\n'
      + 'h_seconds_bucket{le="+Inf",thread="worker-0"} 1\n'
      + 'h_seconds_sum{thread="worker-0"} 2\n'
      + 'h_seconds_count{thread="worker-0"} 1\n',
    );
  });

  test('an empty list renders an empty body', () => {
    expect(renderPrometheusSamples([])).toBe('');
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
