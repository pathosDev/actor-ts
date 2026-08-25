import { describe, expect, test } from 'bun:test';
import { promClientRegistry } from '../../../src/metrics/PromClientAdapter.js';
import { PromClientAdapterOptions } from '../../../src/metrics/PromClientAdapterOptions.js';
import { METRICS_OVERFLOW_LABEL_VALUE } from '../../../src/metrics/Metrics.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

/**
 * The bridge is exercised against a hand-rolled `prom-client`-shaped
 * fake.  This keeps the test self-contained (no extra dev-dep) and
 * proves the adapter's contract: every framework metric mutation
 * lands on the prom-client side, and the adapter never reads back
 * through prom-client to fulfil framework-side reads (the local
 * mirror does that).
 *
 * The fake reproduces one rule of the real library on purpose:
 * `labels()` rejects a label name outside the set the metric was
 * constructed with.  That is what forces the cardinality overflow
 * tuple (#131) to reuse the family's own label names instead of a
 * synthetic `__overflow__` name — without the rule here, the test
 * would happily accept a tuple prom-client throws on.
 */

type RecordedCall = {
  readonly type: 'inc' | 'dec' | 'set' | 'observe';
  readonly labels: Record<string, string | number>;
  readonly value: number;
};

type FakePromMetric = {
  readonly options: {
    name: string; help: string;
    labelNames?: string[]; buckets?: number[];
    registers?: unknown[];
  };
  readonly calls: RecordedCall[];
  /** Tuples handed to `remove` — prom-client's own per-child eviction. */
  readonly removed: Record<string, string | number>[];
};

interface FakePromRegistry {
  registered: FakePromMetric[];
  registerMetric(m: FakePromMetric): void;
  getSingleMetric(name: string): FakePromMetric | undefined;
}

function makeFakeClient(reg: FakePromRegistry): {
  Counter: new (options: FakePromMetric['options']) => Record<string, unknown>;
  Gauge: new (options: FakePromMetric['options']) => Record<string, unknown>;
  Histogram: new (options: FakePromMetric['options']) => Record<string, unknown>;
} {
  function makeChild(metric: FakePromMetric, labels: Record<string, string | number>, type: RecordedCall['type'][]): Record<string, (v?: number) => void> {
    const declared = metric.options.labelNames ?? [];
    for (const labelName of Object.keys(labels)) {
      if (!declared.includes(labelName)) {
        throw new Error(`Added label "${labelName}" is not included in initial labelset`);
      }
    }
    const out: Record<string, (v?: number) => void> = {};
    if (type.includes('inc')) out.inc = (v = 1) => metric.calls.push({ type: 'inc', labels, value: v });
    if (type.includes('dec')) out.dec = (v = 1) => metric.calls.push({ type: 'dec', labels, value: v });
    if (type.includes('set')) out.set = (v) => metric.calls.push({ type: 'set', labels, value: v ?? 0 });
    if (type.includes('observe')) out.observe = (v) => metric.calls.push({ type: 'observe', labels, value: v ?? 0 });
    return out;
  }
  function instance(type: 'counter' | 'gauge' | 'histogram', allowed: RecordedCall['type'][]) {
    return function FakeMetric(this: Record<string, unknown>, options: FakePromMetric['options']) {
      const metric: FakePromMetric = { options, calls: [], removed: [] };
      reg.registered.push(metric);
      this['__metric'] = metric;
      this['labels'] = (labels: Record<string, string | number>) => makeChild(metric, labels, allowed);
      this['remove'] = (labels: Record<string, string | number>) => { metric.removed.push(labels); };
      // Direct (no-labels) mutators land on `{}`-keyed series.
      if (allowed.includes('inc')) this['inc'] = (v: number = 1) => metric.calls.push({ type: 'inc', labels: {}, value: v });
      if (allowed.includes('dec')) this['dec'] = (v: number = 1) => metric.calls.push({ type: 'dec', labels: {}, value: v });
      if (allowed.includes('set')) this['set'] = (v: number) => metric.calls.push({ type: 'set', labels: {}, value: v });
      if (allowed.includes('observe')) this['observe'] = (v: number) => metric.calls.push({ type: 'observe', labels: {}, value: v });
      void type;
    } as unknown as new (options: FakePromMetric['options']) => Record<string, unknown>;
  }
  return {
    Counter:   instance('counter',   ['inc']),
    Gauge:     instance('gauge',     ['set', 'inc', 'dec']),
    Histogram: instance('histogram', ['observe']),
  };
}

function makeFakeRegistry(): FakePromRegistry {
  const reg: FakePromRegistry = {
    registered: [],
    registerMetric(m) { reg.registered.push(m); },
    getSingleMetric(name) { return reg.registered.find((m) => m.options.name === name); },
  };
  return reg;
}

describe('promClientRegistry', () => {
  test('counter.inc lands on prom-client child', () => {
    const reg = makeFakeRegistry();
    const client = makeFakeClient(reg);
    const promOptions = PromClientAdapterOptions.create()
      .withClient(client as never)
      .withRegistry(reg);
    const adapted = promClientRegistry(
      promOptions,
    );

    const counter = adapted.counter('foo_total', { node: 'a' }, { help: 'hits' });
    counter.inc();
    counter.inc(4);

    const metric = reg.registered.find((m) => m.options.name === 'foo_total')!;
    expect(metric.options.labelNames).toEqual(['node']);
    expect(metric.calls.map((x) => `${x.type}:${x.value}@${x.labels['node']}`)).toEqual([
      'inc:1@a',
      'inc:4@a',
    ]);
    // Local mirror works without round-tripping through prom-client.
    expect(counter.value).toBe(5);
  });

  test('gauge supports set + inc + dec', () => {
    const reg = makeFakeRegistry();
    const client = makeFakeClient(reg);
    const promOptions = PromClientAdapterOptions.create()
      .withClient(client as never)
      .withRegistry(reg);
    const adapted = promClientRegistry(
      promOptions,
    );

    const gauge = adapted.gauge('mailbox_depth');
    gauge.set(10);
    gauge.inc();
    gauge.dec(2);

    const metric = reg.registered.find((m) => m.options.name === 'mailbox_depth')!;
    expect(metric.calls.map((x) => `${x.type}:${x.value}`)).toEqual(['set:10', 'inc:1', 'dec:2']);
    expect(gauge.value).toBe(9);
  });

  test('histogram observe + buckets', () => {
    const reg = makeFakeRegistry();
    const client = makeFakeClient(reg);
    const promOptions = PromClientAdapterOptions.create()
      .withClient(client as never)
      .withRegistry(reg);
    const adapted = promClientRegistry(
      promOptions,
    );

    const histogram = adapted.histogram('lat_seconds', undefined, { buckets: [0.1, 0.5, 1] });
    histogram.observe(0.05);
    histogram.observe(0.7);
    histogram.observe(1.5);

    expect(histogram.count).toBe(3);
    expect(histogram.sum).toBeCloseTo(2.25, 5);
    // buckets [0.1, 0.5, 1, +Inf]; counts [1, 1, 2, 3] cumulative
    expect([...histogram.counts]).toEqual([1, 1, 2, 3]);
    const metric = reg.registered.find((m) => m.options.name === 'lat_seconds')!;
    expect(metric.options.buckets).toEqual([0.1, 0.5, 1]);
    expect(metric.calls.length).toBe(3);
  });

  test('namePrefix applies to every registered metric', () => {
    const reg = makeFakeRegistry();
    const client = makeFakeClient(reg);
    const promOptions = PromClientAdapterOptions.create()
      .withClient(client as never)
      .withRegistry(reg)
      .withNamePrefix('actor_ts_');
    const adapted = promClientRegistry(
      promOptions,
    );

    adapted.counter('messages_delivered_total');
    adapted.gauge('members_up');
    adapted.histogram('handler_seconds');

    const names = reg.registered.map((m) => m.options.name).sort();
    expect(names).toEqual([
      'actor_ts_handler_seconds',
      'actor_ts_members_up',
      'actor_ts_messages_delivered_total',
    ]);
  });

  test('remove forwards to prom-client and frees the slot it held (#745)', () => {
    const reg = makeFakeRegistry();
    const client = makeFakeClient(reg);
    const promOptions = PromClientAdapterOptions.create()
      .withClient(client as never)
      .withRegistry(reg)
      .withMaxSeriesPerFamily(2);
    const adapted = promClientRegistry(promOptions);

    adapted.gauge('depth', { path: '/a' }).set(1);
    adapted.gauge('depth', { path: '/b' }).set(2);

    expect(adapted.remove('depth', { path: '/a' })).toBe(true);
    const metric = reg.registered.find((m) => m.options.name === 'depth')!;
    expect(metric.removed).toEqual([{ path: '/a' }]);

    // The freed slot is the point: without dropping the tuple from the
    // bridge's own tally the family would still read as full and fold the
    // next path into `__overflow__`.
    adapted.gauge('depth', { path: '/c' }).set(3);
    const written = metric.calls.map((c) => String(c.labels['path']));
    expect(written).toEqual(['/a', '/b', '/c']);
    expect(written).not.toContain(METRICS_OVERFLOW_LABEL_VALUE);
  });

  test('remove answers false for tuples this bridge never minted, and never for the overflow one', () => {
    const reg = makeFakeRegistry();
    const client = makeFakeClient(reg);
    const promOptions = PromClientAdapterOptions.create()
      .withClient(client as never)
      .withRegistry(reg)
      .withMaxSeriesPerFamily(1);
    const adapted = promClientRegistry(promOptions);

    adapted.counter('hits', { route: '/a' }).inc();
    const originalWarn = console.warn;
    console.warn = (): void => {};
    try {
      adapted.counter('hits', { route: '/b' }).inc();   // folds into overflow
    } finally {
      console.warn = originalWarn;
    }

    expect(adapted.remove('nothing-here', { route: '/a' })).toBe(false);
    expect(adapted.remove('hits', { route: '/b' })).toBe(false);
    // The overflow tuple is deliberately never counted against the cap, so it
    // is not in the tally either — which is what refuses it here, with no
    // special case of its own.
    expect(adapted.remove('hits', { route: METRICS_OVERFLOW_LABEL_VALUE })).toBe(false);

    const metric = reg.registered.find((m) => m.options.name === 'hits')!;
    expect(metric.removed).toEqual([]);
  });

  test('registering the same name with two types throws', () => {
    const reg = makeFakeRegistry();
    const client = makeFakeClient(reg);
    const promOptions = PromClientAdapterOptions.create()
      .withClient(client as never)
      .withRegistry(reg);
    const adapted = promClientRegistry(
      promOptions,
    );

    adapted.counter('busy');
    expect(() => adapted.gauge('busy')).toThrow(/already registered/);
  });

  test('counter family is reused across label-value variants (one prom-client metric, multiple series)', () => {
    const reg = makeFakeRegistry();
    const client = makeFakeClient(reg);
    const promOptions = PromClientAdapterOptions.create()
      .withClient(client as never)
      .withRegistry(reg);
    const adapted = promClientRegistry(
      promOptions,
    );

    adapted.counter('hits', { node: 'a' }).inc();
    adapted.counter('hits', { node: 'b' }).inc(2);
    adapted.counter('hits', { node: 'a' }).inc(3);

    // Only one prom-client Counter object is registered for 'hits';
    // both label values land on it via .labels(...).inc().
    const hits = reg.registered.filter((m) => m.options.name === 'hits');
    expect(hits.length).toBe(1);
    expect(hits[0]!.calls.map((counter) => `${counter.value}@${counter.labels['node']}`)).toEqual([
      '1@a', '2@b', '3@a',
    ]);
  });
});

/**
 * The bridge needs its own label-tuple tally: `families` is keyed by
 * metric name, and the series itself is minted inside prom-client by
 * `impl.labels(...)` — where the adapter can neither count nor evict it.
 * prom-client also never expires a series, so an uncapped bridge is the
 * more exposed of the two registries (#131).
 */
describe('promClientRegistry — cardinality cap', () => {
  function adaptedRegistryWith(maxSeriesPerFamily: number): {
    registry: FakePromRegistry;
    adapted: ReturnType<typeof promClientRegistry>;
  } {
    const registry = makeFakeRegistry();
    const client = makeFakeClient(registry);
    const promOptions = PromClientAdapterOptions.create()
      .withClient(client as never)
      .withRegistry(registry)
      .withMaxSeriesPerFamily(maxSeriesPerFamily);
    return { registry, adapted: promClientRegistry(promOptions) };
  }

  /** Distinct label tuples prom-client actually saw for `name`. */
  function tuplesSeen(registry: FakePromRegistry, name: string): ReadonlyArray<string> {
    const metric = registry.registered.find((m) => m.options.name === name)!;
    return [...new Set(metric.calls.map((call) => JSON.stringify(call.labels)))];
  }

  function withWarningsCaptured<T>(body: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => { warnings.push(args.map((a) => String(a)).join(' ')); };
    try {
      return { result: body(), warnings };
    } finally {
      console.warn = originalWarn;
    }
  }

  test('prom-client sees at most maxSeriesPerFamily + 1 distinct tuples', () => {
    const { registry, adapted } = adaptedRegistryWith(3);
    const { warnings } = withWarningsCaptured(() => {
      for (let i = 0; i < 50; i++) adapted.counter('hits', { path: `/p-${i}` }).inc();
    });

    const tuples = tuplesSeen(registry, 'hits');
    expect(tuples).toHaveLength(4);
    expect(tuples).toContain(JSON.stringify({ path: METRICS_OVERFLOW_LABEL_VALUE }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("family 'hits'");
  });

  test('the overflow tuple uses the family label names, so prom-client accepts it', () => {
    // The fake throws on a label name outside the initial labelset — a
    // synthetic `__overflow__` name would fail right here.
    const { registry, adapted } = adaptedRegistryWith(1);
    withWarningsCaptured(() => {
      adapted.counter('dropped', { path: '/a', reason: 'drop-head' }).inc();
      adapted.counter('dropped', { path: '/b', reason: 'drop-new' }).inc();
    });

    const metric = registry.registered.find((m) => m.options.name === 'dropped')!;
    expect(metric.options.labelNames).toEqual(['path', 'reason']);
    expect(metric.calls[1]!.labels).toEqual({
      path: METRICS_OVERFLOW_LABEL_VALUE,
      reason: METRICS_OVERFLOW_LABEL_VALUE,
    });
  });

  test('a tuple minted before the cap keeps its own series afterwards', () => {
    const { registry, adapted } = adaptedRegistryWith(2);
    withWarningsCaptured(() => {
      adapted.counter('hits', { path: '/a' }).inc();
      adapted.counter('hits', { path: '/b' }).inc();
      adapted.counter('hits', { path: '/c' }).inc(9);   // overflows
      adapted.counter('hits', { path: '/a' }).inc(4);   // still its own series
    });

    const metric = registry.registered.find((m) => m.options.name === 'hits')!;
    expect(metric.calls.map((call) => `${call.value}@${call.labels['path']}`)).toEqual([
      '1@/a', '1@/b', `9@${METRICS_OVERFLOW_LABEL_VALUE}`, '4@/a',
    ]);
  });

  test('gauges and histograms are capped on the same budget as counters', () => {
    const { registry, adapted } = adaptedRegistryWith(1);
    withWarningsCaptured(() => {
      adapted.gauge('depth', { queue: 'a' }).set(1);
      adapted.gauge('depth', { queue: 'b' }).set(2);
      adapted.histogram('latency', { route: 'a' }, { buckets: [1] }).observe(0.5);
      adapted.histogram('latency', { route: 'b' }, { buckets: [1] }).observe(0.5);
    });

    expect(tuplesSeen(registry, 'depth')).toContain(JSON.stringify({ queue: METRICS_OVERFLOW_LABEL_VALUE }));
    expect(tuplesSeen(registry, 'latency')).toContain(JSON.stringify({ route: METRICS_OVERFLOW_LABEL_VALUE }));
  });

  test('families budget independently', () => {
    const { registry, adapted } = adaptedRegistryWith(2);
    withWarningsCaptured(() => {
      for (let i = 0; i < 3; i++) adapted.counter('foo', { path: `/p-${i}` }).inc();
      for (let i = 0; i < 2; i++) adapted.counter('bar', { path: `/p-${i}` }).inc();
    });

    expect(tuplesSeen(registry, 'foo')).toHaveLength(3);   // 2 + overflow
    expect(tuplesSeen(registry, 'bar')).toHaveLength(2);
    expect(tuplesSeen(registry, 'bar')).not.toContain(JSON.stringify({ path: METRICS_OVERFLOW_LABEL_VALUE }));
  });

  test('maxSeriesPerFamily 0 disables the cap', () => {
    const { registry, adapted } = adaptedRegistryWith(0);
    const { warnings } = withWarningsCaptured(() => {
      for (let i = 0; i < 200; i++) adapted.counter('hits', { path: `/p-${i}` }).inc();
    });

    expect(tuplesSeen(registry, 'hits')).toHaveLength(200);
    expect(warnings).toHaveLength(0);
  });

  test('an out-of-domain cap is rejected at construction', () => {
    const registry = makeFakeRegistry();
    const client = makeFakeClient(registry);
    const badOptions = PromClientAdapterOptions.create()
      .withClient(client as never)
      .withRegistry(registry)
      .withMaxSeriesPerFamily(-5);
    expect(() => promClientRegistry(badOptions)).toThrow(OptionsError);
  });
});
