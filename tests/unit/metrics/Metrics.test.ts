/**
 * Unit tests for the Metrics primitives (#11).
 *
 *   - Counter / Gauge / Histogram value tracking.
 *   - Label-tuple identity: same labels return the same series.
 *   - Re-registering with a different type throws.
 *   - Histogram bucket boundaries are upper-inclusive (Prom-compatible).
 *   - NoopMetricsRegistry never throws and never records.
 */
import { describe, expect, test } from 'bun:test';
import {
  DefaultMetricsRegistry,
  NoopMetricsRegistry,
  DEFAULT_HISTOGRAM_BUCKETS,
} from '../../../src/metrics/Metrics.js';

describe('DefaultMetricsRegistry — Counter', () => {
  test('inc() accumulates; default delta is 1', () => {
    const registry = new DefaultMetricsRegistry();
    const counter = registry.counter('hits');
    counter.inc();
    counter.inc();
    counter.inc(5);
    expect(counter.value).toBe(7);
  });

  test('rejects negative deltas', () => {
    const counter = new DefaultMetricsRegistry().counter('x');
    expect(() => counter.inc(-1)).toThrow(/delta >= 0/);
  });

  test('same name + same labels returns the same series', () => {
    const registry = new DefaultMetricsRegistry();
    const counterA = registry.counter('hits', { node: 'n-1' });
    const counterB = registry.counter('hits', { node: 'n-1' });
    counterA.inc(3);
    expect(counterB.value).toBe(3);
  });

  test('different label values create distinct series', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits', { node: 'n-1' }).inc(2);
    registry.counter('hits', { node: 'n-2' }).inc(5);
    const samples = registry.collect().filter((s) => s.name === 'hits');
    expect(samples).toHaveLength(2);
    expect(samples.find((s) => s.labels.node === 'n-1')?.value).toBe(2);
    expect(samples.find((s) => s.labels.node === 'n-2')?.value).toBe(5);
  });
});

describe('DefaultMetricsRegistry — Gauge', () => {
  test('set / inc / dec', () => {
    const gauge = new DefaultMetricsRegistry().gauge('depth');
    gauge.set(10);
    gauge.inc(5);
    gauge.dec(3);
    expect(gauge.value).toBe(12);
  });
});

describe('DefaultMetricsRegistry — Histogram', () => {
  test('default buckets match the documented Prom defaults', () => {
    const histogram = new DefaultMetricsRegistry().histogram('latency');
    // The +Inf bucket is appended internally.
    expect(histogram.buckets.slice(0, -1)).toEqual(DEFAULT_HISTOGRAM_BUCKETS);
    expect(histogram.buckets[histogram.buckets.length - 1]).toBe(Number.POSITIVE_INFINITY);
  });

  test('observations land in every bucket >= the value (upper-inclusive)', () => {
    const registry = new DefaultMetricsRegistry();
    const histogram = registry.histogram('latency', {}, { buckets: [0.1, 0.5, 1] });
    histogram.observe(0.05);   // counts in 0.1, 0.5, 1, +Inf
    histogram.observe(0.7);    // counts in 1, +Inf
    histogram.observe(2);      // counts in +Inf only
    expect(histogram.count).toBe(3);
    expect(histogram.sum).toBe(2.75);
    // counts[]: [n<=0.1, n<=0.5, n<=1, n<=Inf]
    expect(histogram.counts).toEqual([1, 1, 2, 3]);
  });

  test('custom buckets are sorted ascending automatically', () => {
    const histogram = new DefaultMetricsRegistry().histogram('x', {}, { buckets: [1, 0.1, 0.5] });
    expect(histogram.buckets.slice(0, -1)).toEqual([0.1, 0.5, 1]);
  });

  test('rejects empty bucket lists', () => {
    expect(() => new DefaultMetricsRegistry().histogram('x', {}, { buckets: [] })).toThrow();
  });

  test('NaN observations throw, +Inf observations are dropped', () => {
    const histogram = new DefaultMetricsRegistry().histogram('x');
    expect(() => histogram.observe(Number.NaN)).toThrow();
    histogram.observe(Number.POSITIVE_INFINITY);
    expect(histogram.count).toBe(0);
  });
});

describe('DefaultMetricsRegistry — type-mismatch protection', () => {
  test('same name with a different type throws', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('m');
    expect(() => registry.gauge('m')).toThrow(/already registered as counter/);
  });
});

describe('DefaultMetricsRegistry — collect()', () => {
  test('emits one sample per counter / gauge series', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('a').inc(2);
    registry.gauge('b').set(7);
    const samples = registry.collect();
    expect(samples).toHaveLength(2);
    expect(samples.find((s) => s.name === 'a')?.value).toBe(2);
    expect(samples.find((s) => s.name === 'b')?.value).toBe(7);
  });

  test('histogram emits one bucket sample per boundary plus a sum/count row', () => {
    const registry = new DefaultMetricsRegistry();
    const histogram = registry.histogram('x', {}, { buckets: [0.1, 1] });
    histogram.observe(0.05);
    histogram.observe(0.5);
    const samples = registry.collect();
    // Buckets: 0.1, 1, +Inf → 3 bucket samples; plus 1 sum/count row.
    expect(samples.filter((s) => s.bucket !== undefined)).toHaveLength(3);
    expect(samples.filter((s) => s.sum !== undefined)).toHaveLength(1);
  });

  test('clear() empties the registry', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('a').inc();
    registry.clear();
    expect(registry.collect()).toEqual([]);
  });
});

describe('NoopMetricsRegistry', () => {
  test('counter / gauge / histogram are no-ops; collect returns empty', () => {
    const registry = new NoopMetricsRegistry();
    registry.counter('a').inc();
    registry.gauge('b').set(10);
    registry.histogram('c').observe(0.5);
    expect(registry.collect()).toEqual([]);
  });

  test('reads return zero / empty', () => {
    const registry = new NoopMetricsRegistry();
    expect(registry.counter('a').value).toBe(0);
    expect(registry.gauge('a').value).toBe(0);
    expect(registry.histogram('a').count).toBe(0);
  });
});
