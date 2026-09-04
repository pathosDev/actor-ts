/**
 * Metric names and label keys are checked against the Prometheus
 * exposition grammar at registration (#784).
 *
 * The exposition is a line-oriented text format in which only a label
 * *value* is quoted and escaped.  A name and a label key are interpolated
 * raw — the format gives the exporter nothing to escape them with — so an
 * application that derives either from request data hands whoever controls
 * that string the ability to end the current series and write another one.
 * A forged `node_up{job="prod"} 1` is indistinguishable from a real one to
 * whatever scrapes it, which is enough to silence an alert.
 *
 * These tests pin the boundary: the registry throws at the call that is
 * actually wrong, nothing is minted when it does, the grammars for the two
 * positions differ where Prometheus says they differ, and the check sits
 * where a payload in a label *value* still cannot break out either.
 */
import { describe, expect, test } from 'bun:test';
import { DefaultMetricsRegistry, NoopMetricsRegistry } from '../../../src/metrics/Metrics.js';
import { exportPrometheus } from '../../../src/metrics/PrometheusExporter.js';

/** The walkthrough payload from the report, as a metric name. */
const FORGED_NAME = 'x_total 1\nnode_up{job="prod"} 0\n# dummy';

/** Names outside `[a-zA-Z_:][a-zA-Z0-9_:]*`, one reason each. */
const REJECTED_NAMES: ReadonlyArray<readonly [string, string]> = [
  [FORGED_NAME, 'the report’s forged-series payload'],
  ['hits\ntotal', 'a bare line feed'],
  ['hits\rtotal', 'a bare carriage return'],
  ['hits"total', 'a double quote'],
  ['hits{a="b"}', 'a label-tuple brace'],
  ['hits total', 'a space, which ends the name token'],
  ['hits-total', 'a hyphen — legal in many systems, not in this grammar'],
  ['hits.total', 'a dot'],
  ['9lives', 'a leading digit'],
  ['', 'the empty string'],
];

/** Names the grammar allows, including shapes that look unusual but are legal. */
const ACCEPTED_NAMES: ReadonlyArray<string> = [
  'hits_total',
  '_leading_underscore',
  ':leading_colon',
  'instance:requests:rate5m',
  'a9',
];

/** Label keys outside `[a-zA-Z_][a-zA-Z0-9_]*`, one reason each. */
const REJECTED_LABEL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['bad"key', 'a double quote, which closes the value string early'],
  ['a:b', 'a colon — legal in a name, never in a label key'],
  ['a-b', 'a hyphen'],
  ['a b', 'a space'],
  ['a\nb', 'a line feed'],
  ['1st', 'a leading digit'],
  ['', 'the empty string'],
];

describe('DefaultMetricsRegistry — metric name validation (#784)', () => {
  test('rejects the report’s forged-series payload and mints nothing', () => {
    const registry = new DefaultMetricsRegistry();
    expect(() => registry.counter(FORGED_NAME)).toThrow(/Invalid metric name/);
    // Not merely "it threw": a family half-registered before the throw would
    // still reach the exposition on the next scrape.
    expect(registry.collect()).toEqual([]);
    expect(exportPrometheus(registry)).toBe('');
  });

  test('the error names the offending value with its control characters escaped', () => {
    const registry = new DefaultMetricsRegistry();
    let message = '';
    try {
      registry.counter('hits\ntotal');
    } catch (error) {
      message = (error as Error).message;
    }
    // The message is written to a log the same way the exposition is written
    // to a scrape, so a raw newline in it is the same defect one layer up.
    expect(message).toContain('Invalid metric name');
    expect(message).toContain('"hits\\ntotal"');
    expect(message.includes('\n')).toBe(false);
  });

  // One test per row rather than a `test.each` table: the titles carry the
  // reason, and a rejected name has to be JSON-escaped to survive being one.
  for (const [name, why] of REJECTED_NAMES) {
    test(`rejects ${JSON.stringify(name)} — ${why}`, () => {
      const registry = new DefaultMetricsRegistry();
      expect(() => registry.counter(name)).toThrow(/Invalid metric name/);
    });
  }

  for (const name of ACCEPTED_NAMES) {
    test(`accepts ${JSON.stringify(name)}`, () => {
      const registry = new DefaultMetricsRegistry();
      expect(() => registry.counter(name).inc()).not.toThrow();
      expect(registry.collect().map((sample) => sample.name)).toContain(name);
    });
  }

  test('all three accessors validate, not just the counter', () => {
    const registry = new DefaultMetricsRegistry();
    expect(() => registry.counter('bad name')).toThrow(/Invalid metric name/);
    expect(() => registry.gauge('bad name')).toThrow(/Invalid metric name/);
    expect(() => registry.histogram('bad name')).toThrow(/Invalid metric name/);
  });

  test('remove() does not validate — it cannot mint, so it just misses', () => {
    // The boundary is registration, deliberately: `remove` looks a name up
    // and deletes at most what is already there, so a bad one is a lookup
    // that fails rather than a series that gets created.
    const registry = new DefaultMetricsRegistry();
    expect(registry.remove(FORGED_NAME)).toBe(false);
  });

  test('the noop registry stays free of the check, and free of the risk', () => {
    // It records nothing and exports nothing, so there is no exposition for a
    // name to break out of; paying a regex there would put the cost on every
    // system that has metrics switched off.
    expect(() => new NoopMetricsRegistry().counter(FORGED_NAME).inc()).not.toThrow();
  });
});

describe('DefaultMetricsRegistry — label key validation (#784)', () => {
  test('rejects a key that would close the quoted value early, and mints nothing', () => {
    const registry = new DefaultMetricsRegistry();
    expect(() => registry.counter('http_requests_total', { 'x" 1\nnode_up': 'y' }))
      .toThrow(/Invalid label key/);
    expect(registry.collect()).toEqual([]);
  });

  for (const [key, why] of REJECTED_LABEL_KEYS) {
    test(`rejects ${JSON.stringify(key)} — ${why}`, () => {
      const registry = new DefaultMetricsRegistry();
      expect(() => registry.counter('hits_total', { [key]: 'v' })).toThrow(/Invalid label key/);
    });
  }

  test('the error names both the key and the family it was minted under', () => {
    const registry = new DefaultMetricsRegistry();
    let message = '';
    try {
      registry.gauge('queue_depth', { 'bad key': 1 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Invalid label key "bad key"');
    expect(message).toContain('queue_depth');
  });

  test('a colon separates the two grammars — legal in a name, not in a key', () => {
    const registry = new DefaultMetricsRegistry();
    expect(() => registry.counter('instance:hits:rate5m', { route: '/a' }).inc()).not.toThrow();
    expect(() => registry.counter('hits_total', { 'ns:route': '/a' })).toThrow(/Invalid label key/);
  });

  test('label values are not constrained — they are the field that carries data', () => {
    const registry = new DefaultMetricsRegistry();
    expect(() => registry.counter('hits_total', { route: 'a"b\nc\\d\re' }).inc()).not.toThrow();
  });

  test('a family at its cardinality cap still refuses a bad key', () => {
    // Placement, not just presence: the key check has to run before the cap
    // check, because the overflow tuple is built by copying these key names
    // onto a synthetic value.  A check that ran after it would let a family
    // that is already full mint an overflow series with a forged key in it.
    const registry = new DefaultMetricsRegistry({ maxSeriesPerFamily: 1 });
    registry.counter('hits_total', { route: '/a' }).inc();
    expect(() => registry.counter('hits_total', { 'route" 1\nnode_up': '/b' }))
      .toThrow(/Invalid label key/);
    const forged = exportPrometheus(registry);
    expect(forged).not.toContain('node_up');
  });
});

describe('exportPrometheus — a validated name cannot be broken out of (#784)', () => {
  test('the payload in a label value renders as one escaped series, not two', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits_total', { tenant: 'x"} 1\nnode_up{job="prod"} 0\n#' }).inc();
    const text = exportPrometheus(registry);

    // Every non-comment line of the body belongs to the one family declared.
    // The `\n` in the payload survives as the two characters `\` and `n`, so
    // this split finds one line where the unescaped value would have made two.
    const seriesNames = text.split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line)?.[0] ?? `<unparseable: ${line}>`);
    expect([...new Set(seriesNames)]).toEqual(['hits_total']);
    expect(text).not.toContain('node_up{job="prod"} 0');
  });
});
