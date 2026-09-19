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
import {
  PROMETHEUS_LABEL_NAME_PATTERN,
  PROMETHEUS_METRIC_NAME_PATTERN,
} from '../../../src/metrics/index.js';

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

/**
 * Count the calls a shipped pattern receives while `body` runs.
 *
 * An own `test` property shadows `RegExp.prototype.test` for the duration,
 * and an own property is exactly what `assertValidMetricName` /
 * `assertValidLabelKeys` resolve when they write `PATTERN.test(…)` — each
 * pattern has precisely one call site in `src/`, so the count is unambiguous.
 * Restored in a `finally`, because bun runs every file in one process and a
 * leaked counter would follow the pattern into unrelated suites.
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

describe('DefaultMetricsRegistry — the reserved label key `thread` (#1570)', () => {
  // The exposition stamps every sample with the thread that produced it once
  // a worker mesh relays its registries into the main thread's scrape.  An
  // application label with the same key was, before this, silently
  // overwritten to `thread="main"` — two values became two rows with one
  // identical label set, which a Prometheus scrape rejects wholesale — and on
  // a worker it made the relay drop that thread's entire snapshot.  Refusing
  // the key where labels are minted turns both into an error at the
  // developer's desk, on every thread, with a message that says what to do.
  type Kind = 'counter' | 'gauge' | 'histogram';
  const mint = (registry: DefaultMetricsRegistry, kind: Kind): unknown => (
    kind === 'counter' ? registry.counter('jobs_total', { thread: 'io' })
      : kind === 'gauge' ? registry.gauge('jobs_total', { thread: 'io' })
        : registry.histogram('jobs_total', { thread: 'io' })
  );
  for (const kind of ['counter', 'gauge', 'histogram'] as const) {
    test(`${kind}: a tuple carrying \`thread\` is refused when the family is minted, and nothing is minted`, () => {
      const registry = new DefaultMetricsRegistry();
      expect(() => mint(registry, kind)).toThrow(/Reserved label key "thread"/);
      expect(registry.collect()).toEqual([]);
    });
  }

  test('the message names the metric and says what to do instead', () => {
    const registry = new DefaultMetricsRegistry();
    let message = '';
    try {
      registry.counter('jobs_total', { route: '/a', thread: 'cpu' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('"jobs_total"');
    expect(message).toContain('rename');
    expect(message).toContain('#1570');
  });

  test('is a whole-key match — `thread_pool` and `threads` are ordinary keys', () => {
    // The check must not become a prefix or substring rule: a pool metric
    // labelled by `thread_pool` is exactly the kind of label the rule is
    // meant to leave alone.
    const registry = new DefaultMetricsRegistry();
    expect(() => registry.counter('jobs_total', { thread_pool: 'io' })).not.toThrow();
    expect(() => registry.gauge('threads_active', { threads: '4' })).not.toThrow();
    expect(registry.collect()).toHaveLength(2);
  });

  test('a series the exposition stamps can no longer collide with one the application labelled', () => {
    // The verifier's reproduction: two values of an application `thread`
    // label rendered as two `jobs_total{thread="main"}` rows once a relay was
    // active.  With the key refused at mint, the registry never holds such a
    // series, so the export-time stamp has nothing to overwrite.
    const registry = new DefaultMetricsRegistry();
    expect(() => registry.counter('jobs_total', { thread: 'io' }).inc()).toThrow(/Reserved label key/);
    expect(() => registry.counter('jobs_total', { thread: 'cpu' }).inc()).toThrow(/Reserved label key/);
    expect(registry.collect().filter((sample) => sample.name === 'jobs_total')).toEqual([]);
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

  test('EVERY key in the tuple is checked, not just the first one', () => {
    // Every other case in this block passes a single-entry tuple, so an
    // implementation that validated `Object.keys(labels)[0]` and stopped would
    // satisfy all of them.  It is a plausible slip rather than a hypothetical
    // one — the loop is the only thing between a forged key and the exposition
    // once any legal key precedes it, and a caller building a tuple from
    // request data puts the derived key wherever its object literal happens to
    // put it.
    const registry = new DefaultMetricsRegistry();
    expect(() => registry.counter('hits_total', { route: '/a', 'bad" 1\nnode_up': 'x' }))
      .toThrow(/Invalid label key/);
    // Third position too, so "checks the first two" is refused as well.
    expect(() => registry.gauge('queue_depth', { a: '1', b: '2', 'c d': '3' }))
      .toThrow(/Invalid label key/);
    expect(registry.collect()).toEqual([]);
    expect(exportPrometheus(registry)).toBe('');
  });

  test('the error escapes the key, so the message is not an injection point either', () => {
    // The metric-name message has this assertion (above); the label-key
    // message had none, even though its JSDoc claims the "same rule and same
    // reasoning" — which includes not forging a line in whatever log the
    // error is written to.  A naive `"${key}"` satisfies every other
    // assertion in this block, because none of their keys carries a newline.
    const registry = new DefaultMetricsRegistry();
    let message = '';
    try {
      registry.counter('hits_total', { 'bad\nkey': 'v' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Invalid label key');
    expect(message).toContain('"bad\\nkey"');
    expect(message.includes('\n')).toBe(false);
  });

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

/**
 * Where the two checks sit, rather than whether they run.
 *
 * Both are placed **after** the memo hit — `assertValidMetricName` after
 * `families.get(name)`, `assertValidLabelKeys` after `children.get(key)` — and
 * `Metrics.ts` calls that placement load-bearing: hoisting either one puts a
 * regex on the path every `counter(...).inc()` on an established series takes,
 * for a question whose answer cannot change, because a name or a tuple the map
 * already holds was validated on the way in.
 *
 * Behaviour is identical either way, which is precisely why nothing else here
 * can see a hoist: every assertion above is about what throws, and a hoisted
 * check throws on the same inputs.  The observable that separates them is how
 * often the pattern is consulted, so that is what these read.
 *
 * The *other* half of the label-key placement — before the cardinality-cap
 * branch, so the overflow tuple cannot copy a forged key onto itself — is
 * pinned by "a family at its cardinality cap still refuses a bad key" above.
 * These pin the half that faces the other way.
 */
describe('DefaultMetricsRegistry — validation runs once per registration (#784)', () => {
  test('a metric name is checked when its family is minted, not on every write', () => {
    const registry = new DefaultMetricsRegistry();
    const calls = patternCallsDuring(PROMETHEUS_METRIC_NAME_PATTERN, () => {
      registry.counter('hits_total').inc();
      registry.counter('hits_total').inc();
      registry.counter('hits_total').inc();
    });
    expect(calls).toBe(1);
  });

  test('a label tuple is checked when its series is minted, not on every write', () => {
    const registry = new DefaultMetricsRegistry();
    const calls = patternCallsDuring(PROMETHEUS_LABEL_NAME_PATTERN, () => {
      registry.counter('hits_total', { route: '/a' }).inc();
      registry.counter('hits_total', { route: '/a' }).inc();
      registry.counter('hits_total', { route: '/a' }).inc();
    });
    // One key, checked once — a second tuple costs one more, and a hoisted
    // check costs one per write forever.
    expect(calls).toBe(1);
  });

  test('a second family and a second tuple each pay their own check', () => {
    // Guards the two above from passing for the wrong reason: a check deleted
    // outright, or a counter that never increments, also reads 0 or 1 there.
    const registry = new DefaultMetricsRegistry();
    const nameCalls = patternCallsDuring(PROMETHEUS_METRIC_NAME_PATTERN, () => {
      registry.counter('hits_total').inc();
      registry.counter('misses_total').inc();
    });
    expect(nameCalls).toBe(2);
    const keyCalls = patternCallsDuring(PROMETHEUS_LABEL_NAME_PATTERN, () => {
      registry.counter('hits_total', { route: '/a' }).inc();
      registry.counter('hits_total', { route: '/b' }).inc();
    });
    expect(keyCalls).toBe(2);
  });
});

/**
 * The two grammars are part of the `actor-ts/metrics` public surface.
 *
 * They are exported so a caller assembling a name or a tuple from anything but
 * a literal can ask the same question the registry will ask, before the throw
 * — which is the only way to turn "this metric is rejected" into a validation
 * error at the caller's own boundary.  Nothing inside the repository imports
 * them through the barrel (`Metrics.ts` reaches `./Constants.js` directly), so
 * without this the two re-exports could be dropped in a barrel tidy-up with
 * every gate green and the seam gone.
 */
describe('the exposition grammars are reachable from the metrics barrel (#784)', () => {
  test('both patterns are exported, and are the ones the registry enforces', () => {
    expect(PROMETHEUS_METRIC_NAME_PATTERN.test('instance:hits:rate5m')).toBe(true);
    expect(PROMETHEUS_METRIC_NAME_PATTERN.test('hits total')).toBe(false);
    // A colon is the one character the two grammars disagree about.
    expect(PROMETHEUS_LABEL_NAME_PATTERN.test('route')).toBe(true);
    expect(PROMETHEUS_LABEL_NAME_PATTERN.test('ns:route')).toBe(false);

    // The same objects the registry consults, not a second copy that could
    // drift: the counter sees the call made through the barrel binding.
    const registry = new DefaultMetricsRegistry();
    expect(patternCallsDuring(PROMETHEUS_METRIC_NAME_PATTERN, () => {
      registry.counter('hits_total');
    })).toBe(1);
  });

  test('neither pattern carries the `g` flag, which would make it answer alternately', () => {
    // `lastIndex` is per-object state, and these are module-level singletons
    // consulted once per registration — a `g` flag would reject every second
    // legal name in the process.
    expect(PROMETHEUS_METRIC_NAME_PATTERN.global).toBe(false);
    expect(PROMETHEUS_LABEL_NAME_PATTERN.global).toBe(false);
    expect(PROMETHEUS_METRIC_NAME_PATTERN.test('hits_total')).toBe(true);
    expect(PROMETHEUS_METRIC_NAME_PATTERN.test('hits_total')).toBe(true);
  });
});
