/**
 * Reading the framework's own metrics back out for the dashboard.
 *
 * Everything here goes through `MetricsRegistry.collect()` rather than
 * `registry.counter(name)`: the accessor *creates* a family when one is
 * missing, and a family created here would carry an empty `# HELP`
 * string that the real call site can no longer fix.  A snapshot reads
 * without mutating.
 */
import type { MetricSample } from '../../metrics/Metrics.js';
import type { HandlerLatencySummary } from '../protocol/index.js';

/**
 * Total of every series in a counter family.  Labelled families
 * (`actor_mailbox_dropped_total` carries class/path/reason) collapse to
 * the one number the dashboard shows; an absent family reads 0, which
 * is what "nothing has happened yet" means for a counter.
 */
export function counterTotal(samples: ReadonlyArray<MetricSample>, name: string): number {
  let total = 0;
  for (const sample of samples) {
    if (sample.kind === 'counter' && sample.name === name) total += sample.value;
  }
  return total;
}

/**
 * Percentiles interpolated from a cumulative-bucket histogram, the way
 * Prometheus' `histogram_quantile` does it.  Approximate by
 * construction — the answer can only ever be as precise as the bucket
 * edges — so the panel labels it as such.
 *
 * Returns `null` while the histogram has no observations: a percentile
 * over zero samples is not 0 ms, it is unknown, and showing 0 would read
 * as "everything is instant".
 */
export function handlerLatency(
  samples: ReadonlyArray<MetricSample>,
  name: string,
): HandlerLatencySummary | null {
  // Cumulative counts per bucket bound, summed across label series so a
  // future labelled histogram still yields one system-wide figure.
  const cumulative = new Map<number, number>();
  let count = 0;
  for (const sample of samples) {
    if (sample.kind !== 'histogram' || sample.name !== name) continue;
    if (sample.bucket !== undefined) {
      cumulative.set(sample.bucket, (cumulative.get(sample.bucket) ?? 0) + sample.value);
    } else {
      count += sample.count ?? 0;
    }
  }
  if (count === 0) return null;

  const bounds = [...cumulative.keys()].sort((a, b) => a - b);
  return {
    p50Ms: quantile(bounds, cumulative, count, 0.5) * 1000,
    p99Ms: quantile(bounds, cumulative, count, 0.99) * 1000,
    count,
  };
}

/** Linear interpolation inside the bucket the quantile falls into. */
function quantile(
  bounds: ReadonlyArray<number>,
  cumulative: ReadonlyMap<number, number>,
  count: number,
  q: number,
): number {
  const target = q * count;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const bound of bounds) {
    const bucketCount = cumulative.get(bound) ?? 0;
    if (bucketCount >= target) {
      // The `+Inf` bucket has no upper edge to interpolate towards, so
      // the best honest answer is the last finite bound we passed.
      if (!Number.isFinite(bound)) return lowerBound;
      const span = bucketCount - lowerCount;
      if (span <= 0) return bound;
      return lowerBound + (bound - lowerBound) * ((target - lowerCount) / span);
    }
    lowerBound = bound;
    lowerCount = bucketCount;
  }
  return lowerBound;
}
