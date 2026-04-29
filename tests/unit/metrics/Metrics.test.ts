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
    const r = new DefaultMetricsRegistry();
    const c = r.counter('hits');
    c.inc();
    c.inc();
    c.inc(5);
    expect(c.value).toBe(7);
  });

  test('rejects negative deltas', () => {
    const c = new DefaultMetricsRegistry().counter('x');
    expect(() => c.inc(-1)).toThrow(/delta >= 0/);
  });

  test('same name + same labels returns the same series', () => {
    const r = new DefaultMetricsRegistry();
    const a = r.counter('hits', { node: 'n-1' });
    const b = r.counter('hits', { node: 'n-1' });
    a.inc(3);
    expect(b.value).toBe(3);
  });

  test('different label values create distinct series', () => {
    const r = new DefaultMetricsRegistry();
    r.counter('hits', { node: 'n-1' }).inc(2);
    r.counter('hits', { node: 'n-2' }).inc(5);
    const samples = r.collect().filter((s) => s.name === 'hits');
    expect(samples).toHaveLength(2);
    expect(samples.find((s) => s.labels.node === 'n-1')?.value).toBe(2);
    expect(samples.find((s) => s.labels.node === 'n-2')?.value).toBe(5);
  });
});

describe('DefaultMetricsRegistry — Gauge', () => {
  test('set / inc / dec', () => {
    const g = new DefaultMetricsRegistry().gauge('depth');
    g.set(10);
    g.inc(5);
    g.dec(3);
    expect(g.value).toBe(12);
  });
});

describe('DefaultMetricsRegistry — Histogram', () => {
  test('default buckets match the documented Prom defaults', () => {
    const h = new DefaultMetricsRegistry().histogram('latency');
    // The +Inf bucket is appended internally.
    expect(h.buckets.slice(0, -1)).toEqual(DEFAULT_HISTOGRAM_BUCKETS);
    expect(h.buckets[h.buckets.length - 1]).toBe(Number.POSITIVE_INFINITY);
  });

  test('observations land in every bucket >= the value (upper-inclusive)', () => {
    const r = new DefaultMetricsRegistry();
    const h = r.histogram('latency', {}, { buckets: [0.1, 0.5, 1] });
    h.observe(0.05);   // counts in 0.1, 0.5, 1, +Inf
    h.observe(0.7);    // counts in 1, +Inf
    h.observe(2);      // counts in +Inf only
    expect(h.count).toBe(3);
    expect(h.sum).toBe(2.75);
    // counts[]: [n<=0.1, n<=0.5, n<=1, n<=Inf]
    expect(h.counts).toEqual([1, 1, 2, 3]);
  });

  test('custom buckets are sorted ascending automatically', () => {
    const h = new DefaultMetricsRegistry().histogram('x', {}, { buckets: [1, 0.1, 0.5] });
    expect(h.buckets.slice(0, -1)).toEqual([0.1, 0.5, 1]);
  });

  test('rejects empty bucket lists', () => {
    expect(() => new DefaultMetricsRegistry().histogram('x', {}, { buckets: [] })).toThrow();
  });

  test('NaN observations throw, +Inf observations are dropped', () => {
    const h = new DefaultMetricsRegistry().histogram('x');
    expect(() => h.observe(Number.NaN)).toThrow();
    h.observe(Number.POSITIVE_INFINITY);
    expect(h.count).toBe(0);
  });
});

describe('DefaultMetricsRegistry — type-mismatch protection', () => {
  test('same name with a different type throws', () => {
    const r = new DefaultMetricsRegistry();
    r.counter('m');
    expect(() => r.gauge('m')).toThrow(/already registered as counter/);
  });
});

describe('DefaultMetricsRegistry — collect()', () => {
  test('emits one sample per counter / gauge series', () => {
    const r = new DefaultMetricsRegistry();
    r.counter('a').inc(2);
    r.gauge('b').set(7);
    const samples = r.collect();
    expect(samples).toHaveLength(2);
    expect(samples.find((s) => s.name === 'a')?.value).toBe(2);
    expect(samples.find((s) => s.name === 'b')?.value).toBe(7);
  });

  test('histogram emits one bucket sample per boundary plus a sum/count row', () => {
    const r = new DefaultMetricsRegistry();
    const h = r.histogram('x', {}, { buckets: [0.1, 1] });
    h.observe(0.05);
    h.observe(0.5);
    const samples = r.collect();
    // Buckets: 0.1, 1, +Inf → 3 bucket samples; plus 1 sum/count row.
    expect(samples.filter((s) => s.bucket !== undefined)).toHaveLength(3);
    expect(samples.filter((s) => s.sum !== undefined)).toHaveLength(1);
  });

  test('clear() empties the registry', () => {
    const r = new DefaultMetricsRegistry();
    r.counter('a').inc();
    r.clear();
    expect(r.collect()).toEqual([]);
  });
});

describe('NoopMetricsRegistry', () => {
  test('counter / gauge / histogram are no-ops; collect returns empty', () => {
    const r = new NoopMetricsRegistry();
    r.counter('a').inc();
    r.gauge('b').set(10);
    r.histogram('c').observe(0.5);
    expect(r.collect()).toEqual([]);
  });

  test('reads return zero / empty', () => {
    const r = new NoopMetricsRegistry();
    expect(r.counter('a').value).toBe(0);
    expect(r.gauge('a').value).toBe(0);
    expect(r.histogram('a').count).toBe(0);
  });
});
