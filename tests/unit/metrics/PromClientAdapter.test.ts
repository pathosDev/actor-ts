import { describe, expect, test } from 'bun:test';
import { promClientRegistry } from '../../../src/metrics/PromClientAdapter.js';
import { PromClientAdapterOptions } from '../../../src/metrics/PromClientAdapterOptions.js';

/**
 * The bridge is exercised against a hand-rolled `prom-client`-shaped
 * fake.  This keeps the test self-contained (no extra dev-dep) and
 * proves the adapter's contract: every framework metric mutation
 * lands on the prom-client side, and the adapter never reads back
 * through prom-client to fulfil framework-side reads (the local
 * mirror does that).
 */

interface RecordedCall {
  readonly type: 'inc' | 'dec' | 'set' | 'observe';
  readonly labels: Record<string, string | number>;
  readonly value: number;
}

interface FakePromMetric {
  readonly options: {
    name: string; help: string;
    labelNames?: string[]; buckets?: number[];
    registers?: unknown[];
  };
  readonly calls: RecordedCall[];
}

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
    const out: Record<string, (v?: number) => void> = {};
    if (type.includes('inc')) out.inc = (v = 1) => metric.calls.push({ type: 'inc', labels, value: v });
    if (type.includes('dec')) out.dec = (v = 1) => metric.calls.push({ type: 'dec', labels, value: v });
    if (type.includes('set')) out.set = (v) => metric.calls.push({ type: 'set', labels, value: v ?? 0 });
    if (type.includes('observe')) out.observe = (v) => metric.calls.push({ type: 'observe', labels, value: v ?? 0 });
    return out;
  }
  function instance(type: 'counter' | 'gauge' | 'histogram', allowed: RecordedCall['type'][]) {
    return function FakeMetric(this: Record<string, unknown>, options: FakePromMetric['options']) {
      const metric: FakePromMetric = { options, calls: [] };
      reg.registered.push(metric);
      this['__metric'] = metric;
      this['labels'] = (labels: Record<string, string | number>) => makeChild(metric, labels, allowed);
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
