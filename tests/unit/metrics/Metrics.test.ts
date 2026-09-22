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
  type Labels,
} from '../../../src/metrics/Metrics.js';
import { exportPrometheus } from '../../../src/metrics/PrometheusExporter.js';

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
    // Spread rather than widen the constant: `DEFAULT_HISTOGRAM_BUCKETS` is
    // `readonly number[]` on purpose, and `toEqual` wants a mutable array.
    expect(histogram.buckets.slice(0, -1)).toEqual([...DEFAULT_HISTOGRAM_BUCKETS]);
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

describe('DefaultMetricsRegistry — remove', () => {
  test('drops one series and leaves its siblings alone (#745)', () => {
    const registry = new DefaultMetricsRegistry();
    registry.gauge('depth', { path: '/a' }).set(7);
    registry.gauge('depth', { path: '/b' }).set(9);

    expect(registry.remove('depth', { path: '/a' })).toBe(true);

    const series = registry.collect().filter((s) => s.name === 'depth');
    expect(series).toHaveLength(1);
    expect(series[0]!.labels).toEqual({ path: '/b' });
  });

  test('the tuple is the key, so label order is irrelevant', () => {
    const registry = new DefaultMetricsRegistry();
    registry.gauge('depth', { class: 'Sink', path: '/a' }).set(7);
    expect(registry.remove('depth', { path: '/a', class: 'Sink' })).toBe(true);
    expect(registry.collect()).toEqual([]);
  });

  test('a removed tuple comes back fresh rather than at its old reading', () => {
    // This is the whole difference between removing and zeroing, and the
    // reason the depth sampler wanted it: a path that falls behind again must
    // not inherit the spike it left behind the last time it did.
    const registry = new DefaultMetricsRegistry();
    registry.gauge('depth', { path: '/a' }).set(7);
    registry.remove('depth', { path: '/a' });
    expect(registry.gauge('depth', { path: '/a' }).value).toBe(0);
  });

  test('answers false for an unknown family and for a tuple never minted', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits', { route: '/a' }).inc();
    expect(registry.remove('nothing-here', { route: '/a' })).toBe(false);
    expect(registry.remove('hits', { route: '/b' })).toBe(false);
    // The unlabeled tuple is a tuple like any other, and this family has no
    // series under it.
    expect(registry.remove('hits')).toBe(false);
    expect(registry.collect()).toHaveLength(1);
  });

  test('the family outlives its last series, help text and all', () => {
    // Only the child goes.  Dropping the family with it would silently lose
    // the `help` an exporter prints, and would let the next call re-register
    // it as a different kind without the mismatch being caught.
    const registry = new DefaultMetricsRegistry();
    registry.gauge('depth', { path: '/a' }, { help: 'queued messages' }).set(1);
    registry.remove('depth', { path: '/a' });
    registry.gauge('depth', { path: '/b' }).set(2);

    const series = registry.collect().filter((s) => s.name === 'depth');
    expect(series).toHaveLength(1);
    expect(series[0]!.help).toBe('queued messages');
    expect(() => registry.counter('depth')).toThrow(/already registered as gauge/);
  });
});

/**
 * A label tuple has to map to exactly one series key, and two different
 * tuples to two (#1513).
 *
 * The first version of that key joined `k=v` pairs with `\x1f`, and a label
 * *value* is deliberately unrestricted — so a value carrying the separator
 * could spell a whole second pair, and two different tuples produced one
 * string.  Nothing about the failure was visible from a call site: the second
 * caller was handed the *first* caller's series, the exposition showed the
 * first caller's labels, and both subjects' counts were added together under
 * them.  No error, no warning, one series where there should be two.
 *
 * These read the registry's behaviour rather than the key itself, because the
 * key is an implementation detail and the aliasing is not.
 */
describe('DefaultMetricsRegistry — distinct label tuples are distinct series (#1513)', () => {
  /** The tuple pair the verifier minted, in the order they reported it. */
  const SPLIT_VALUE: Labels = { a: 'x\x1fb=y' };
  const TWO_LABELS: Labels = { a: 'x', b: 'y' };

  test('a value that spells a second pair does not alias onto the two-label tuple', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits_total', SPLIT_VALUE).inc(6);
    registry.counter('hits_total', TWO_LABELS).inc(7);

    const series = registry.collect().filter((sample) => sample.name === 'hits_total');
    expect(series).toHaveLength(2);
    // Not just "two of something": each tuple keeps its own count, which is
    // what the merge destroyed — one series read 13 before.
    expect(series.find((sample) => sample.labels.b === 'y')?.value).toBe(7);
    expect(series.find((sample) => sample.labels.b === undefined)?.value).toBe(6);
  });

  test('and does not alias the other way round either', () => {
    // The merged series took the labels of whichever call came first, so a
    // test that only ever registers them in one order pins half the fix.
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits_total', TWO_LABELS).inc(7);
    registry.counter('hits_total', SPLIT_VALUE).inc(6);
    expect(registry.collect().filter((sample) => sample.name === 'hits_total')).toHaveLength(2);
  });

  test('both label sets reach the exposition', () => {
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits_total', SPLIT_VALUE).inc(6);
    registry.counter('hits_total', TWO_LABELS).inc(7);
    const text = exportPrometheus(registry);
    // The separator is stripped on the way out (#1414), so the first tuple
    // renders as `a="xb=y"` — still a different label set from `a="x",b="y"`,
    // which is the point.
    expect(text).toContain('hits_total{a="xb=y"} 6');
    expect(text).toContain('hits_total{a="x",b="y"} 7');
  });

  test('remove() tells the two apart, because it looks up the same key', () => {
    // `remove` computing its own key, or the family storing a different one,
    // would take the wrong series out — and on the old key it took the only
    // series out, since there was just the one.
    const registry = new DefaultMetricsRegistry();
    registry.counter('hits_total', SPLIT_VALUE).inc(6);
    registry.counter('hits_total', TWO_LABELS).inc(7);

    expect(registry.remove('hits_total', TWO_LABELS)).toBe(true);

    const series = registry.collect().filter((sample) => sample.name === 'hits_total');
    expect(series).toHaveLength(1);
    expect(series[0]!.labels).toEqual({ ...SPLIT_VALUE });
  });

  test('a rarer separator is not the fix — any character can appear in a value', () => {
    // These three pairs collide under a `k=v` join with `\x1f`, `\x00` and
    // `|` respectively.  Only the first one was ever broken here; the other
    // two are the guard against "fixing" it by moving the separator, which
    // leaves the same hole one character over.
    const separators = ['\x1f', '\x00', '|', '\x01', ','];
    for (const separator of separators) {
      const registry = new DefaultMetricsRegistry();
      registry.counter('hits_total', { a: `x${separator}b=y` }).inc(1);
      registry.counter('hits_total', TWO_LABELS).inc(1);
      expect(registry.collect().filter((sample) => sample.name === 'hits_total'))
        .toHaveLength(2);
    }
  });

  test('a number and its string spelling stay one series — the exposition cannot tell them apart', () => {
    // The key is injective on what gets *rendered*, not on what was passed:
    // `{ code: 500 }` and `{ code: '500' }` are both `code="500"` in the body,
    // so splitting them here would mint two series that a scrape rejects as
    // one duplicated series.
    const registry = new DefaultMetricsRegistry();
    registry.counter('responses_total', { code: 500 }).inc(2);
    registry.counter('responses_total', { code: '500' }).inc(3);
    const series = registry.collect().filter((sample) => sample.name === 'responses_total');
    expect(series).toHaveLength(1);
    expect(series[0]!.value).toBe(5);
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

  test('remove() answers false — nothing was minted, so nothing can be dropped', () => {
    const registry = new NoopMetricsRegistry();
    registry.gauge('a', { path: '/x' }).set(1);
    expect(registry.remove('a', { path: '/x' })).toBe(false);
    expect(registry.remove('a')).toBe(false);
  });

  test('reads return zero / empty', () => {
    const registry = new NoopMetricsRegistry();
    expect(registry.counter('a').value).toBe(0);
    expect(registry.gauge('a').value).toBe(0);
    expect(registry.histogram('a').count).toBe(0);
  });
});
