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
 *     (#1414).  "Every other C0 control" is the whole reach of that rule:
 *     TAB and LF stay, and DEL is not a C0 control and stays too.
 *   - Trailing newline on non-empty output.
 *
 * The same strip runs one layer down, before a series is minted, so two
 * values differing only in a stripped control are one series — that half
 * lives in `MetricsLabelValueNormalisation.test.ts`, because it is a
 * property of the registry rather than of the rendered bytes (#1414).
 */
import { describe, expect, test } from 'bun:test';
import {
  DefaultMetricsRegistry,
  type MetricSample,
  type MetricsRegistry,
} from '../../../src/metrics/Metrics.js';
import {
  exportPrometheus,
  prometheusHandler,
  renderPrometheusSamples,
} from '../../../src/metrics/PrometheusExporter.js';
import {
  PROMETHEUS_LABEL_NAME_PATTERN,
  PROMETHEUS_METRIC_NAME_PATTERN,
} from '../../../src/metrics/index.js';

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
    // What reaches the body, stated as the set rather than as an absence.
    // This row used to claim "nothing anywhere in the body a reader could
    // take for a control byte" and then name two survivors in the same
    // breath — TAB and LF *are* control bytes, and both are in this body on
    // purpose. The true statement is narrower: the only C0 bytes left are the
    // two the exposition has an answer for, TAB as data in either position
    // and LF as the format's own line terminator.
    const controlBytesInBody = [...new Set(
      [...text].map((character) => character.charCodeAt(0)).filter((code) => code < 0x20),
    )].sort((a, b) => a - b);
    expect(controlBytesInBody).toEqual([0x09, 0x0a]);
  });

  test('DEL is outside the C0 range the strip names, and survives (#1414)', () => {
    // Pinned so that nobody widens the strip to "every unprintable byte"
    // without meeting this row first. 0x7f is not a C0 control, and both Go
    // readers take it as data in a quoted value exactly as they take TAB —
    // the scrape lexer's class is `[^\\"]` and the classic parser writes
    // every byte but a raw LF. Removing it would silently fold two series
    // that a scrape can tell apart, which is the mirror image of the
    // duplicate #1414 closed.
    const registry = new DefaultMetricsRegistry();
    registry.counter('d_total', { msg: 'a\x7fb' }).inc(1);
    registry.counter('d_total', { msg: 'ab' }).inc(2);
    const text = exportPrometheus(registry);
    expect(text).toContain('msg="a\x7fb"');
    expect(text).toContain('msg="ab"');
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

  test('a histogram whose two label sets used to share a grouping key keeps them apart (#1513)', () => {
    // The renderer groups a histogram's rows by label set so that each set's
    // buckets are followed by its own `_sum` and `_count` — the layout the
    // comment above the grouping promises.  It did that with a second,
    // private copy of the registry's series key, which had the registry's
    // collision in it: `{ a: 'x\x1fb=y' }` and `{ a: 'x', b: 'y' }` joined to
    // one string, so both sets landed in one group and the rows interleaved.
    // Sharing one helper is what keeps the two answers to "same series?" from
    // drifting apart again.
    const registry = new DefaultMetricsRegistry();
    registry.histogram('h_seconds', { a: 'x\x1fb=y' }, { buckets: [1] }).observe(0.5);
    registry.histogram('h_seconds', { a: 'x', b: 'y' }, { buckets: [1] }).observe(2);

    expect(exportPrometheus(registry)).toBe(
      '# TYPE h_seconds histogram\n'
      + 'h_seconds_bucket{a="xb=y",le="1"} 1\n'
      + 'h_seconds_bucket{a="xb=y",le="+Inf"} 1\n'
      + 'h_seconds_sum{a="xb=y"} 0.5\n'
      + 'h_seconds_count{a="xb=y"} 1\n'
      + 'h_seconds_bucket{a="x",b="y",le="1"} 0\n'
      + 'h_seconds_bucket{a="x",b="y",le="+Inf"} 1\n'
      + 'h_seconds_sum{a="x",b="y"} 2\n'
      + 'h_seconds_count{a="x",b="y"} 1\n',
    );
  });
});

/**
 * What the renderer trusts, written down as behaviour rather than as a
 * comment (#1513).
 *
 * `renderPrometheusSamples` interpolates family names and label keys **raw**,
 * because the 0.0.4 format offers no escaping for either position — they are
 * the grammar itself.  What makes that safe is the registry refusing anything
 * outside the grammar at registration (#784), so every name that reaches the
 * renderer through `DefaultMetricsRegistry` has already been checked.
 *
 * Both halves of that sentence are load-bearing and neither was tested.  The
 * renderer is a **public seam**: `exportPrometheus` takes any
 * `MetricsRegistry`, and since #1570 `renderPrometheusSamples` takes any list
 * at all.  A registry implemented outside this package, or a list assembled
 * by hand, inherits the obligation — and if it does not meet it, the forged
 * series renders verbatim.  These tests state that, so a future render-time
 * re-check is a deliberate change with a red test in front of it rather than
 * a silent one, and so the documented cost of *not* re-checking (no regex per
 * family per scrape) stays a measurable claim.
 */
describe('renderPrometheusSamples — the renderer trusts its input (#1513)', () => {
  /** The report's forged-series payload, in each of the two raw positions. */
  const FORGED_SAMPLES: ReadonlyArray<MetricSample> = [
    {
      name: 'x_total 1\nnode_up{job="prod"} 0\n# d',
      help: '', kind: 'counter', labels: {}, value: 1,
    },
    {
      name: 'ok_total', help: '', kind: 'counter', value: 1,
      labels: { 'k" 1\nnode_up{job="prod"} 0\n#x': 'v' },
    },
  ];

  /** A `MetricsRegistry` from outside this package, checking nothing. */
  const foreignRegistryOf = (samples: ReadonlyArray<MetricSample>): MetricsRegistry => ({
    counter: () => { throw new Error('this characterisation only reads collect()'); },
    gauge: () => { throw new Error('this characterisation only reads collect()'); },
    histogram: () => { throw new Error('this characterisation only reads collect()'); },
    collect: () => samples,
    remove: () => false,
    clear: () => {},
  });

  /**
   * Calls a shipped pattern receives while `body` runs.  The twin of the
   * helper in `MetricsNameValidation.test.ts` — bun runs each test file in
   * its own module graph, so the two cannot share one without a helper module
   * that is not a test.  An own `test` property shadows
   * `RegExp.prototype.test` for the duration and is deleted in a `finally`,
   * because a leaked counter would follow a module-level singleton into
   * unrelated suites.
   */
  function patternCallsDuring(pattern: RegExp, body: () => void): number {
    const shipped = RegExp.prototype.test;
    let calls = 0;
    Object.defineProperty(pattern, 'test', {
      configurable: true,
      value(this: RegExp, input: string): boolean {
        calls += 1;
        return shipped.call(this, input);
      },
    });
    try {
      body();
    } finally {
      delete (pattern as { test?: unknown }).test;
    }
    return calls;
  }

  test('a forged family name in a hand-built list renders verbatim', () => {
    const text = renderPrometheusSamples([FORGED_SAMPLES[0]!]);
    expect(text).toContain('node_up{job="prod"} 0');
    // Not "an oddly named series": a whole extra line a scraper reads as one.
    expect(text.split('\n')).toContain('node_up{job="prod"} 0');
  });

  test('a forged label key does the same, one field over', () => {
    const text = renderPrometheusSamples([FORGED_SAMPLES[1]!]);
    expect(text.split('\n')).toContain('node_up{job="prod"} 0');
  });

  test('a foreign MetricsRegistry reaches the same place through exportPrometheus', () => {
    // `exportPrometheus` is `renderPrometheusSamples(registry.collect())`, so
    // implementing the interface outside this package is the other way in.
    expect(exportPrometheus(foreignRegistryOf(FORGED_SAMPLES)))
      .toBe(renderPrometheusSamples(FORGED_SAMPLES));
    expect(exportPrometheus(foreignRegistryOf(FORGED_SAMPLES)))
      .toContain('node_up{job="prod"} 0');
  });

  test('neither grammar is consulted during a render — that is the cost being avoided', () => {
    // The JSDoc's reason for trusting the input is that a re-check would cost
    // a regex per family per scrape.  This is that claim as a number: zero
    // today, and any render-time check makes it non-zero here first.
    expect(patternCallsDuring(PROMETHEUS_METRIC_NAME_PATTERN, () => {
      renderPrometheusSamples(FORGED_SAMPLES);
    })).toBe(0);
    expect(patternCallsDuring(PROMETHEUS_LABEL_NAME_PATTERN, () => {
      renderPrometheusSamples(FORGED_SAMPLES);
    })).toBe(0);
  });

  test('the counter is not vacuous — registration does consult both', () => {
    // Guards the two zeros above: a helper that never increments, or patterns
    // nothing reads any more, would also read 0 there.
    const registry = new DefaultMetricsRegistry();
    expect(patternCallsDuring(PROMETHEUS_METRIC_NAME_PATTERN, () => {
      registry.counter('hits_total', { route: '/a' }).inc();
    })).toBe(1);
    expect(patternCallsDuring(PROMETHEUS_LABEL_NAME_PATTERN, () => {
      registry.counter('misses_total', { route: '/a' }).inc();
    })).toBe(1);
  });

  test('the framework’s own registry cannot produce such a sample', () => {
    // The other direction of the contract: the obligation is met at
    // registration for anything minted here, which is why the renderer may
    // skip it.  A registry from outside inherits the obligation instead.
    const registry = new DefaultMetricsRegistry();
    expect(() => registry.counter(FORGED_SAMPLES[0]!.name)).toThrow(/Invalid metric name/);
    expect(() => registry.counter('ok_total', FORGED_SAMPLES[1]!.labels))
      .toThrow(/Invalid label key/);
    expect(exportPrometheus(registry)).toBe('');
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
