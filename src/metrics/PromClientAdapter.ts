/**
 * Bridge from the framework's {@link MetricsRegistry} to a
 * `prom-client` registry (#64).
 *
 * Most users that already run a Node service have `prom-client` wired
 * to their own `/metrics` route.  Without an adapter, framework
 * metrics live in our own `MetricsRegistry` and the user has to scrape
 * them on a separate path or merge two text exports — both irritating.
 * `promClientRegistry(...)` returns a `MetricsRegistry` whose every
 * mutation lands in the user's `prom-client` registry directly, so
 * the framework's counters / gauges / histograms appear under the
 * user's existing exposition route alongside their app metrics.
 *
 * Why this isn't an `import 'prom-client'`:
 * - Optional peer dep, not a hard dependency — only users who wire
 *   the bridge pull it in.
 * - The user already has `import client from 'prom-client'` in their
 *   app; passing the namespace in (instead of us loading it) avoids
 *   loading the module twice and keeps version pinning under the
 *   user's control.
 *
 * Structural typing: the {@link PromClientLike} interface below
 * captures only the surface we actually use.  `prom-client`'s real
 * types are a superset; passing `import * as client from 'prom-client'`
 * in works at runtime and TypeScript narrows down to our shape.
 */

import type { PromClientAdapterOptions, PromClientAdapterOptionsType } from './PromClientAdapterOptions.js';
import { PromClientAdapterOptionsValidator } from './PromClientAdapterOptions.js';
import type {
  Counter, CounterOptions, Gauge, GaugeOptions, Histogram, HistogramOptions,
  Labels, LabelValue, MetricSample, MetricsRegistry,
} from './Metrics.js';
import { DEFAULT_HISTOGRAM_BUCKETS, overflowLabelsOf, warnCardinalityOverflow } from './Metrics.js';
import { DEFAULT_MAX_SERIES_PER_FAMILY } from './MetricsRegistryOptions.js';

/* ----------------------- prom-client surface ----------------------- */
/* Structural — keep in sync with prom-client v15.x.  We only use the */
/* construct-and-mutate path; readback goes through prom-client's    */
/* own `register.metrics()`, which the user already calls.            */

export type PromClientLabelValues = {
  [k: string]: string | number;
};

export interface PromClientCounter {
  inc(value?: number): void;
  inc(labels: PromClientLabelValues, value?: number): void;
  labels(values: PromClientLabelValues): { inc(value?: number): void };
}

export interface PromClientGauge {
  set(value: number): void;
  set(labels: PromClientLabelValues, value: number): void;
  inc(value?: number): void;
  inc(labels: PromClientLabelValues, value?: number): void;
  dec(value?: number): void;
  dec(labels: PromClientLabelValues, value?: number): void;
  labels(values: PromClientLabelValues): {
    set(v: number): void;
    inc(v?: number): void;
    dec(v?: number): void;
  };
}

export interface PromClientHistogram {
  observe(value: number): void;
  observe(labels: PromClientLabelValues, value: number): void;
  labels(values: PromClientLabelValues): { observe(v: number): void };
}

export interface PromClientRegistryLike {
  registerMetric(metric: unknown): void;
  removeSingleMetric?(name: string): void;
  getSingleMetric(name: string): unknown;
  resetMetrics?(): void;
}

export type PromClientLike = {
  Counter:   new (options: PromConstructorOpts) => PromClientCounter;
  Gauge:     new (options: PromConstructorOpts) => PromClientGauge;
  Histogram: new (options: PromConstructorOpts & { buckets?: number[] }) => PromClientHistogram;
};

type PromConstructorOpts = {
  name: string;
  help: string;
  labelNames?: string[];
  registers?: PromClientRegistryLike[];
  buckets?: number[];
};

/* --------------------------- adapter --------------------------- */

/**
 * Per-family bookkeeping.  `series` is the bridge's own label-tuple
 * counter and exists because `families` is keyed by metric *name* only:
 * the series itself is minted inside prom-client by
 * `entry.impl.labels(...)`, where we can neither count nor evict it.
 * Without a local tally there is nothing to compare against the cap.
 * `overflowed` is the one-shot flag for the warning.
 */
type EntryBase = {
  readonly help: string;
  readonly labelNames: ReadonlyArray<string>;
  readonly series: Set<string>;
  overflowed: boolean;
};

type CounterEntry = EntryBase & {
  readonly kind: 'counter';
  readonly impl: PromClientCounter;
};
type GaugeEntry = EntryBase & {
  readonly kind: 'gauge';
  readonly impl: PromClientGauge;
};
type HistogramEntry = EntryBase & {
  readonly kind: 'histogram';
  readonly buckets: ReadonlyArray<number>;
  readonly impl: PromClientHistogram;
};

type Entry = CounterEntry | GaugeEntry | HistogramEntry;

/**
 * Build a {@link MetricsRegistry} backed by the supplied `prom-client`
 * registry.  Plug it into `ActorSystem.create({ metrics })` (or the
 * framework's metrics extension) and your /metrics endpoint will
 * include the framework's counters / gauges / histograms next to
 * your existing app metrics — same registry, same exposition.
 *
 * `collect()` returns a snapshot translated from the prom-client side
 * for parity; in practice users read via `prom-client.register.metrics()`
 * directly and only call `collect()` from tests.
 */
export function promClientRegistry(
  options: PromClientAdapterOptions,
): MetricsRegistry {
  const settings = options as PromClientAdapterOptionsType;
  new PromClientAdapterOptionsValidator().validate(settings);
  const {
    client, registry,
    namePrefix = '',
    maxSeriesPerFamily = DEFAULT_MAX_SERIES_PER_FAMILY,
  } = settings;
  const families = new Map<string, Entry>();

  function fullName(name: string): string {
    return namePrefix + name;
  }

  /**
   * Stable string from a `Labels` object — sorted keys, JSON-encoded
   * values.  Same shape as `Metrics.ts`'s internal series-key, used
   * here only for our local cache (the prom-client side does its own
   * label-tuple hashing).
   */
  function labelKey(labels: Labels | undefined): string {
    if (!labels) return '';
    const keys = Object.keys(labels).sort();
    return keys.map((k) => `${k}=${JSON.stringify(labels[k])}`).join('|');
  }

  function asPromLabels(labels: Labels | undefined): PromClientLabelValues {
    if (!labels) return {};
    const out: PromClientLabelValues = {};
    for (const [k, v] of Object.entries(labels)) {
      // prom-client's `LabelValues` only takes string | number.  Booleans
      // and other primitives are coerced via `String(...)` so we don't
      // silently drop them.  The tuple has already been through
      // `seriesLabelsOf`, so the cardinality cap holds regardless.
      if (typeof v === 'string' || typeof v === 'number') out[k] = v;
      else out[k] = String(v as LabelValue);
    }
    return out;
  }

  function getOrCreateCounter(name: string, labels: Labels | undefined, options2: CounterOptions | undefined): CounterEntry {
    const fullN = fullName(name);
    const existing = families.get(fullN);
    if (existing) {
      if (existing.kind !== 'counter') {
        throw new Error(`promClientRegistry: '${fullN}' is already registered as ${existing.kind}`);
      }
      return existing;
    }
    const labelNames = labels ? Object.keys(labels).sort() : [];
    const impl = new client.Counter({
      name: fullN,
      help: options2?.help ?? fullN,
      labelNames: labelNames.length > 0 ? labelNames : undefined,
      registers: [registry],
    });
    const entry: CounterEntry = {
      kind: 'counter', help: options2?.help ?? fullN, labelNames, impl,
      series: new Set(), overflowed: false,
    };
    families.set(fullN, entry);
    return entry;
  }

  function getOrCreateGauge(name: string, labels: Labels | undefined, options2: GaugeOptions | undefined): GaugeEntry {
    const fullN = fullName(name);
    const existing = families.get(fullN);
    if (existing) {
      if (existing.kind !== 'gauge') {
        throw new Error(`promClientRegistry: '${fullN}' is already registered as ${existing.kind}`);
      }
      return existing;
    }
    const labelNames = labels ? Object.keys(labels).sort() : [];
    const impl = new client.Gauge({
      name: fullN,
      help: options2?.help ?? fullN,
      labelNames: labelNames.length > 0 ? labelNames : undefined,
      registers: [registry],
    });
    const entry: GaugeEntry = {
      kind: 'gauge', help: options2?.help ?? fullN, labelNames, impl,
      series: new Set(), overflowed: false,
    };
    families.set(fullN, entry);
    return entry;
  }

  function getOrCreateHistogram(name: string, labels: Labels | undefined, options2: HistogramOptions | undefined): HistogramEntry {
    const fullN = fullName(name);
    const existing = families.get(fullN);
    if (existing) {
      if (existing.kind !== 'histogram') {
        throw new Error(`promClientRegistry: '${fullN}' is already registered as ${existing.kind}`);
      }
      return existing;
    }
    const labelNames = labels ? Object.keys(labels).sort() : [];
    const buckets = options2?.buckets ?? DEFAULT_HISTOGRAM_BUCKETS;
    const impl = new client.Histogram({
      name: fullN,
      help: options2?.help ?? fullN,
      labelNames: labelNames.length > 0 ? labelNames : undefined,
      buckets: [...buckets],
      registers: [registry],
    });
    const entry: HistogramEntry = {
      kind: 'histogram', help: options2?.help ?? fullN, labelNames,
      buckets: [...buckets], impl,
      series: new Set(), overflowed: false,
    };
    families.set(fullN, entry);
    return entry;
  }

  /**
   * The label tuple this call is allowed to write to — `labels` while the
   * family is under its cap, the family's overflow tuple once it is not
   * (#131).
   *
   * The overflow tuple is built from the family's *declared* `labelNames`
   * rather than from a synthetic marker label, because prom-client fixes
   * a metric's label names at construction and throws on a `.labels(...)`
   * carrying a name outside that set — so a `{__overflow__: '1'}` tuple
   * would blow up the very call that is supposed to contain the damage.
   */
  function seriesLabelsOf(entry: Entry, name: string, labels: Labels | undefined): Labels {
    if (maxSeriesPerFamily <= 0) return labels ?? {};
    const key = labelKey(labels);
    if (entry.series.has(key)) return labels ?? {};
    if (entry.series.size >= maxSeriesPerFamily) {
      if (!entry.overflowed) {
        entry.overflowed = true;
        warnCardinalityOverflow(name, maxSeriesPerFamily, labels ?? {});
      }
      return overflowLabelsOf(entry.labelNames);
    }
    entry.series.add(key);
    return labels ?? {};
  }

  return {
    counter(name, labels, options2): Counter {
      const entry = getOrCreateCounter(name, labels, options2);
      const promLabels = asPromLabels(seriesLabelsOf(entry, fullName(name), labels));
      // Local mirror of the value so the framework's `Counter.value`
      // contract (read for testing) keeps working without poking the
      // prom-client side.
      let mirror = 0;
      // Prefix-bound inc on the prom-client side.
      const child = entry.impl.labels(promLabels);
      return {
        inc(delta = 1): void {
          if (delta < 0) throw new Error('Counter.inc requires delta >= 0');
          if (!Number.isFinite(delta)) throw new Error('Counter.inc requires a finite delta');
          mirror += delta;
          child.inc(delta);
        },
        get value(): number { return mirror; },
      };
    },

    gauge(name, labels, options2): Gauge {
      const entry = getOrCreateGauge(name, labels, options2);
      const promLabels = asPromLabels(seriesLabelsOf(entry, fullName(name), labels));
      let mirror = 0;
      const child = entry.impl.labels(promLabels);
      return {
        set(v: number): void {
          if (!Number.isFinite(v)) throw new Error('Gauge.set requires a finite value');
          mirror = v;
          child.set(v);
        },
        inc(delta = 1): void {
          if (!Number.isFinite(delta)) throw new Error('Gauge.inc requires a finite delta');
          mirror += delta;
          child.inc(delta);
        },
        dec(delta = 1): void {
          if (!Number.isFinite(delta)) throw new Error('Gauge.dec requires a finite delta');
          mirror -= delta;
          child.dec(delta);
        },
        get value(): number { return mirror; },
      };
    },

    histogram(name, labels, options2): Histogram {
      const entry = getOrCreateHistogram(name, labels, options2);
      const promLabels = asPromLabels(seriesLabelsOf(entry, fullName(name), labels));
      const child = entry.impl.labels(promLabels);
      // Mirror the bucket counts + sum + count locally so the
      // framework's `Histogram.{counts,sum,count}` contract keeps
      // working for tests that read the values directly.
      const bucketsWithInf = [...entry.buckets, Number.POSITIVE_INFINITY];
      const counts = new Array<number>(bucketsWithInf.length).fill(0);
      let sum = 0;
      let count = 0;
      return {
        observe(v: number): void {
          if (!Number.isFinite(v)) {
            if (Number.isNaN(v)) throw new Error('Histogram.observe: NaN');
            return;
          }
          sum += v;
          count += 1;
          for (let i = 0; i < bucketsWithInf.length; i++) {
            if (v <= bucketsWithInf[i]!) counts[i]! += 1;
          }
          child.observe(v);
        },
        get buckets(): ReadonlyArray<number> { return bucketsWithInf; },
        get counts(): ReadonlyArray<number> { return counts; },
        get sum(): number { return sum; },
        get count(): number { return count; },
      };
    },

    /**
     * Translate the prom-client side back into our `MetricSample` shape.
     * Mostly useful in tests; production users will read via
     * `register.metrics()` (or `register.getMetricsAsJSON()`) on the
     * prom-client side directly and skip this round-trip.
     */
    collect(): ReadonlyArray<MetricSample> {
      // This intentionally returns an empty array: the prom-client
      // registry holds the canonical state, and exposing
      // already-translated metrics here would compete with the
      // user's own /metrics handler.  Tests that need read-back can
      // call the prom-client registry directly.
      return [];
    },

    clear(): void {
      // We can't reach into the prom-client registry's internals to
      // remove just our metrics in a back-compat way, so `clear()`
      // is a no-op at the bridge level.  Tests that need a fresh
      // registry should construct one explicitly.  (prom-client's
      // own `Registry.clear()` works on its side — call that if you
      // own the registry exclusively.)
      families.clear();
    },
  };
}
