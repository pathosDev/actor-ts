/**
 * **A label value is normalised before the series is minted** (#1414, #784).
 *
 * The C0 strip used to live only in `escapeLabelValue`, at render time, while
 * the registry minted a child under `seriesKey` over the value exactly as it
 * was passed.  Two values differing only in a stripped control were therefore
 * two children that rendered to one identity, and the body carried the same
 * series twice — two rows with a byte-identical name and label set and
 * different values.  A Prometheus scrape rejects a body with a duplicated
 * series **wholesale**, so the outcome was worse than a merge either way
 * round, and it is reachable by construction: #784's own migration note tells
 * users to move request-derived data out of a metric name and into a label
 * value.
 *
 * So the strip now runs *before* the key is computed.  Two label maps that
 * strip to the same bytes are one series, and the counter sums.
 *
 * ## Why this file and not another row in `PrometheusExporter.test.ts`
 *
 * The defect was never visible in the rendered bytes of one series — both
 * readings render `msg="ab"`.  It was visible in *how many* series the
 * registry held, which is a property of the mint path.  These therefore read
 * the registry and the whole body, never `escapeLabelValue`.
 *
 * ## What the strip must not swallow
 *
 * "The same strip the exporter applies" is the decision, and it is held to
 * literally: TAB and LF are the two C0 bytes the exposition has an answer for
 * — TAB is ordinary data to both Go readers and LF is one of the three
 * entries in the 0.0.4 escape table — so neither is stripped, and a value
 * that differs from another by one of them stays a series of its own.  A
 * normalisation broader than the strip would fold two series the exposition
 * can tell apart, which is the same defect pointed the other way.
 *
 * ## Cost
 *
 * The empty tuple short-circuits before any value is touched, which is what
 * keeps the per-message path free: `ActorCell` makes three registry calls per
 * delivered user message and every one passes `{}`.  The count is asserted
 * rather than a clock, for the reason `MetricsSeriesKey.test.ts` gives —
 * a wall-clock budget in a unit test is a flake on a loaded machine.  The
 * timings are in the commit that made the change.
 */
import { describe, expect, test } from 'bun:test';
import { STRIPPED_CONTROL_CHARACTERS_PATTERN } from '../../../src/metrics/Constants.js';
import { DefaultMetricsRegistry, seriesKey } from '../../../src/metrics/Metrics.js';
import { exportPrometheus } from '../../../src/metrics/PrometheusExporter.js';

/** The identity half of an exposition row — everything left of the value. */
function identitiesOf(body: string): ReadonlyArray<string> {
  return body
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.slice(0, line.lastIndexOf(' ')));
}

describe('a stripped control folds two tuples into one series (#1414)', () => {
  test('a counter sums rather than emitting the same identity twice', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('m_total', { msg: 'ab' }).inc(1);
    registry.counter('m_total', { msg: 'a\x1fb' }).inc(2);

    // One child, not two that render alike. The count is the part that was
    // lost: 1 and 2 on two rows became a body no scraper would accept.
    expect(registry.collect().filter((sample) => sample.name === 'm_total')).toHaveLength(1);
    expect(exportPrometheus(registry)).toBe(
      '# TYPE m_total counter\n'
      + 'm_total{msg="ab"} 3\n',
    );
  });

  test('and the other way round, because the first call used to win', () => {
    // The merged series takes the labels of whichever call came first, so a
    // test that registers them in one order only pins half the behaviour.
    const registry = new DefaultMetricsRegistry();
    registry.counter('m_total', { msg: 'a\x1fb' }).inc(2);
    registry.counter('m_total', { msg: 'ab' }).inc(1);
    expect(exportPrometheus(registry)).toBe(
      '# TYPE m_total counter\n'
      + 'm_total{msg="ab"} 3\n',
    );
  });

  test('a gauge reaches the same place, so it is not a counter quirk', () => {
    const registry = new DefaultMetricsRegistry();
    registry.gauge('d', { q: 'ab' }).set(1);
    registry.gauge('d', { q: 'a\x00b' }).set(2);
    // A gauge has no addition to lose; what it loses is the second write
    // landing on a series of its own. Last write wins on the one series.
    expect(identitiesOf(exportPrometheus(registry))).toEqual(['d{q="ab"}']);
    expect(exportPrometheus(registry)).toContain('d{q="ab"} 2');
  });

  test('a histogram folds all four of its identities, `_sum` and `_count` included', () => {
    const registry = new DefaultMetricsRegistry();
    registry.histogram('h_seconds', { q: 'ab' }, { buckets: [1] }).observe(0.5);
    registry.histogram('h_seconds', { q: 'a\x01b' }, { buckets: [1] }).observe(2);
    const identities = identitiesOf(exportPrometheus(registry));
    // Four rows over four distinct identities — `le="1"`, `le="+Inf"`, `_sum`
    // and `_count` — where the duplicate produced eight rows over those same
    // four, which is four duplicated series in one body rather than one.
    expect(identities).toHaveLength(4);
    expect(new Set(identities).size).toBe(4);
    expect(exportPrometheus(registry)).toContain('h_seconds_count{q="ab"} 2');
    expect(exportPrometheus(registry)).toContain('h_seconds_sum{q="ab"} 2.5');
  });

  test('the registry stores the normalised value, so every exporter sees it', () => {
    // Not only the Prometheus one: `MetricsRelay` ships `collect()` across a
    // worker boundary and `PromClientAdapter` hands the same labels to
    // prom-client, whose escape table is the same three entries. A raw
    // control byte surviving in the stored tuple would reach both.
    const registry = new DefaultMetricsRegistry();
    registry.counter('m_total', { msg: 'a\x1fb' }).inc(2);
    const [sample] = registry.collect().filter((s) => s.name === 'm_total');
    expect(sample?.labels).toEqual({ msg: 'ab' });
  });

  test('remove() takes the folded child out when handed either spelling', () => {
    // `remove` looks the series up by the same key, so the normalisation has
    // to be inside the key rather than beside one of its callers.
    const registry = new DefaultMetricsRegistry();
    registry.counter('m_total', { msg: 'ab' }).inc(1);
    expect(registry.remove('m_total', { msg: 'a\x1fb' })).toBe(true);
    expect(registry.collect().filter((sample) => sample.name === 'm_total')).toHaveLength(0);
  });

  test('the shrunk counterexample the injectivity property found, as an example', () => {
    // `MetricsSeriesKey.test.ts`'s "distinct rendered tuples get distinct
    // keys" property fails on `[{ a: '\x1f\x1f' }, { a: '' }]` against a model
    // of rendering that is `String(value)` with no strip. The property is
    // right to fail and its model was wrong; the pair stays here as a plain
    // example, because a counterexample outlives the property that found it.
    expect(seriesKey({ a: '\x1f\x1f' })).toBe(seriesKey({ a: '' }));
    const registry = new DefaultMetricsRegistry();
    registry.counter('m_total', { a: '\x1f\x1f' }).inc(1);
    registry.counter('m_total', { a: '' }).inc(1);
    expect(exportPrometheus(registry)).toBe(
      '# TYPE m_total counter\n'
      + 'm_total{a=""} 2\n',
    );
  });
});

describe('the normalisation is the strip and nothing wider (#1414)', () => {
  test('TAB is not stripped, so a value carrying one keeps its own series', () => {
    // TAB is ordinary data to both Go readers — a quoted value is lexed as
    // `[^\\"]` and a HELP string as `C [^\n]` — so the exporter writes it
    // through. Folding it here would merge two series the exposition renders
    // distinguishably, which is this defect pointed the other way.
    const registry = new DefaultMetricsRegistry();
    registry.counter('m_total', { msg: 'ab' }).inc(1);
    registry.counter('m_total', { msg: 'a\tb' }).inc(2);
    const identities = identitiesOf(exportPrometheus(registry));
    expect(identities).toHaveLength(2);
    expect(new Set(identities).size).toBe(2);
  });

  test('LF is not stripped either — it is escaped, which is a rendering of it', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('m_total', { msg: 'ab' }).inc(1);
    registry.counter('m_total', { msg: 'a\nb' }).inc(2);
    expect(identitiesOf(exportPrometheus(registry))).toEqual([
      'm_total{msg="ab"}', 'm_total{msg="a\\nb"}',
    ]);
  });

  test('a number and its string spelling are still one series', () => {
    // The key was always injective on what is *rendered* rather than on what
    // was passed, and normalising the value is one more rendering step, not a
    // change of that contract.
    const registry = new DefaultMetricsRegistry();
    registry.counter('responses_total', { code: 500 }).inc(2);
    registry.counter('responses_total', { code: '500' }).inc(3);
    const series = registry.collect().filter((sample) => sample.name === 'responses_total');
    expect(series).toHaveLength(1);
    expect(series[0]?.value).toBe(5);
  });

  test('a control byte in a label *key* is still refused rather than normalised', () => {
    // The key side is grammar-checked and unescapable, so silently repairing
    // one would hand the call site a series under a key it never asked for —
    // the `assertValidMetricName` reasoning, one field over. Normalising the
    // value must not have widened that door.
    const registry = new DefaultMetricsRegistry();
    expect(() => registry.counter('m_total', { 'a\x1fb': 'x' }).inc(1)).toThrow(/label/i);
  });

  test('the unlabeled tuple still short-circuits, which is what keeps it free', () => {
    expect(seriesKey({})).toBe('');
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits_total').inc(4);
    registry.counter('hits_total', { route: '/a' }).inc(5);
    expect(registry.collect().filter((sample) => sample.name === 'hits_total')).toHaveLength(2);
  });
});

/* ------------- one declaration, and what it costs to read it ------------ */

/** How many times, and how, the one declaration was read. */
type StripReads = { readonly searches: number; readonly rewrites: number };

/**
 * Count the reads of the exposition strip while `body` runs.
 *
 * Own `[Symbol.search]` and `[Symbol.replace]` properties on the pattern
 * itself, which is what `String.prototype.search` and `.replace` dispatch to
 * when handed a regular expression.  Precise in a way that shadowing the two
 * `String.prototype` methods would not be: it counts reads of **this one
 * declaration** and of nothing else, so a private second copy of the character
 * class anywhere on the path reads as zero here rather than as an equal
 * number.  That is the measurement, not a side effect of it — "the same strip
 * the exporter applies" is the decision #1414 turned on, and a comment
 * claiming it is exactly what the first half of #1414 already had.
 *
 * Splitting the two is what makes the ask-before-rewrite shape visible: a
 * clean value searches and does not rewrite, which is the whole of why the
 * strip is affordable on a path that runs per request.
 *
 * Restored with a delete rather than a re-assignment, so the pattern goes back
 * to inheriting `RegExp.prototype`'s methods instead of carrying own copies of
 * them — bun runs a file in one process and a leaked wrapper would follow the
 * pattern into every suite after this one.
 */
function stripReadsDuring(body: () => void): StripReads {
  // Narrowed to the string-replacement overload: `.call` on the overloaded
  // builtin resolves to the *replacer-function* one, and a `''` is not a
  // replacer.
  const shippedReplace = RegExp.prototype[Symbol.replace] as
    (this: RegExp, target: string, replacement: string) => string;
  const shippedSearch = RegExp.prototype[Symbol.search];
  let searches = 0;
  let rewrites = 0;
  Object.defineProperty(STRIPPED_CONTROL_CHARACTERS_PATTERN, Symbol.replace, {
    configurable: true,
    writable: true,
    value(this: RegExp, target: string, replacement: string): string {
      rewrites += 1;
      return shippedReplace.call(this, target, replacement);
    },
  });
  Object.defineProperty(STRIPPED_CONTROL_CHARACTERS_PATTERN, Symbol.search, {
    configurable: true,
    writable: true,
    value(this: RegExp, target: string): number {
      searches += 1;
      return shippedSearch.call(this, target);
    },
  });
  try {
    body();
  } finally {
    Reflect.deleteProperty(STRIPPED_CONTROL_CHARACTERS_PATTERN, Symbol.replace);
    Reflect.deleteProperty(STRIPPED_CONTROL_CHARACTERS_PATTERN, Symbol.search);
  }
  return { searches, rewrites };
}

/** Total reads, for the rows that only care that the declaration was read. */
function stripReadCount(reads: StripReads): number {
  return reads.searches + reads.rewrites;
}

describe('the strip is one declaration, and the empty tuple never reads it (#1414)', () => {
  test('the meter checks itself against calls that do search and rewrite', () => {
    // Guards every count below from reading 0 because a shadow never took,
    // and from reading a number because one never came off.
    expect(stripReadsDuring(() => {
      'a\x1fb'.search(STRIPPED_CONTROL_CHARACTERS_PATTERN);
      'a\x1fb'.replace(STRIPPED_CONTROL_CHARACTERS_PATTERN, '');
    })).toEqual({ searches: 1, rewrites: 1 });
    expect(stripReadsDuring(() => {})).toEqual({ searches: 0, rewrites: 0 });
    let leaked = 0;
    stripReadsDuring(() => { leaked += 1; });
    'a\x1fb'.replace(STRIPPED_CONTROL_CHARACTERS_PATTERN, '');
    'a\x1fb'.search(STRIPPED_CONTROL_CHARACTERS_PATTERN);
    expect(leaked).toBe(1);
  });

  test('a clean value is searched and not rewritten, which is what it costs', () => {
    // The ask-before-rewrite shape, asserted rather than described: a value
    // with nothing to strip allocates no result string. Measured in the
    // commit that made the change — 383.7 ns against 438.0 ns for rewriting
    // unconditionally, over 325.8 ns before the strip reached the mint path.
    const registry = new DefaultMetricsRegistry();
    expect(stripReadsDuring(() => {
      registry.counter('hits_total', { route: '/orders' }).inc();
    })).toEqual({ searches: 2, rewrites: 0 });

    // And a value that does carry one scans twice and pays for it — the right
    // way round, because that value is a bug at its source.
    const dirty = new DefaultMetricsRegistry();
    expect(stripReadsDuring(() => {
      dirty.counter('hits_total', { route: '/a\x1fb' }).inc();
    })).toEqual({ searches: 2, rewrites: 2 });
  });

  test('the hazard the pattern bans `.test` for is real, demonstrated not assumed', () => {
    // The constant's JSDoc states a rule; this is the measurement under it.
    // `.test` on a global regex resumes from `lastIndex`, so the *same string*
    // answers differently on alternate calls. Without this row the rule is a
    // belief, and a reader who doubts it has nothing to run.
    const pattern = STRIPPED_CONTROL_CHARACTERS_PATTERN;
    pattern.lastIndex = 0;
    try {
      expect([pattern.test('a\x1fb'), pattern.test('a\x1fb'), pattern.test('a\x1fb')])
        .toEqual([true, false, true]);
    } finally {
      // The pattern is shared with the whole subsystem; leaving it advanced
      // would be the very defect this row documents, inflicted on every test
      // after it in this file.
      pattern.lastIndex = 0;
    }
    // The two readers the strip actually uses do not: `search` saves and
    // restores it, `replace` zeroes it on the way in.
    expect([
      'a\x1fb'.search(pattern), 'a\x1fb'.search(pattern), 'a\x1fb'.search(pattern),
    ]).toEqual([1, 1, 1]);
    expect(pattern.lastIndex).toBe(0);
  });

  test('the global pattern keeps no state between reads', () => {
    // The behavioural half of the row above, through the registry: a run of
    // values, alternating clean and dirty, each of which must be stripped in
    // full however many strips came before it.
    const registry = new DefaultMetricsRegistry();
    registry.counter('m_total', { msg: 'a\x1fb' }).inc(1);
    registry.counter('m_total', { msg: 'a\x1fb' }).inc(1);
    registry.counter('m_total', { msg: 'clean' }).inc(1);
    registry.counter('m_total', { msg: 'c\x1fd' }).inc(1);
    registry.counter('m_total', { msg: '\x01\x02\x03xy' }).inc(1);
    const identities = registry.collect()
      .filter((sample) => sample.name === 'm_total')
      .map((sample) => String(sample.labels.msg));
    expect(identities.sort()).toEqual(['ab', 'cd', 'clean', 'xy']);
  });

  test('the three per-message calls read the strip not once', () => {
    // `ActorCell` makes exactly these three per delivered user message, every
    // one with `{}`. The short-circuit in `seriesKey` returns before a value
    // is looked at, which is the whole reason a strip on every mint was
    // affordable: the hot path has no label values to strip. Measured in the
    // commit that made the change — 47.2 ns before, 46.6 ns after, which is
    // the same code and reads as the same number.
    const registry = new DefaultMetricsRegistry();
    const reads = stripReadsDuring(() => {
      registry.counter('actor_messages_delivered_total', {}).inc();
      registry.histogram('actor_mailbox_wait_seconds', {}).observe(0.01);
      registry.histogram('actor_mailbox_depth', {}).observe(3);
    });
    expect(
      stripReadCount(reads),
      'the unlabeled tuple is being stripped on the per-message path; it has no '
      + 'values to strip (#1414)',
    ).toBe(0);
  });

  test('a non-string label value skips the scan, because it cannot carry one', () => {
    // A number or a boolean has no representation a control byte fits in, so
    // asking would be the whole cost and there is nothing to ask. Measured:
    // 327.7 ns before against 325.7 ns after, on a one-number tuple.
    const registry = new DefaultMetricsRegistry();
    expect(stripReadCount(stripReadsDuring(() => {
      registry.counter('responses_total', { code: 500 }).inc();
      registry.counter('responses_total', { ok: true }).inc();
    }))).toBe(0);
  });

  test('the mint path reads this declaration, so a private second copy shows as zero', () => {
    // The first call encodes the tuple (one value) and then stores it
    // normalised (one value); the two after it hit the memo, so they pay the
    // encode alone. If `Metrics.ts` ever spells the character class out for
    // itself again, every one of these reads 0.
    const registry = new DefaultMetricsRegistry();
    expect(stripReadCount(stripReadsDuring(() => {
      registry.counter('hits_total', { route: '/a' }).inc();
    }))).toBe(2);
    expect(stripReadCount(stripReadsDuring(() => {
      registry.counter('hits_total', { route: '/a' }).inc();
      registry.counter('hits_total', { route: '/a' }).inc();
    }))).toBe(2);
  });

  test('the render path reads the same declaration', () => {
    // The other half of "one declaration": `escapeLabelValue` and
    // `escapeHelp` are counted by the same meter, so the exporter cannot
    // quietly acquire a copy of its own either.
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits_total', { route: '/a' }, { help: 'Hits' }).inc();
    expect(stripReadCount(stripReadsDuring(() => { exportPrometheus(registry); }))).toBe(2);
  });
});
