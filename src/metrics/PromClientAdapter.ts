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

/**
 * `remove` is prom-client's own per-child eviction — the object-argument
 * overload of `Metric.remove(...)`, present since v11.2 — and it is what
 * this bridge forwards {@link MetricsRegistry.remove} onto (#745).
 *
 * Declared **required** rather than optional, unlike the registry-level
 * members below.  An optional method would let a client namespace missing
 * it type-check and then silently diverge: the bridge would drop the tuple
 * from its own `series` tally, freeing a cap slot, while the series itself
 * stayed on the prom-client side and kept being scraped.  A compile error
 * on a namespace that cannot evict is the honest outcome.
 */
export interface PromClientCounter {
  inc(value?: number): void;
  inc(labels: PromClientLabelValues, value?: number): void;
  labels(values: PromClientLabelValues): { inc(value?: number): void };
  remove(labels: PromClientLabelValues): void;
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
  remove(labels: PromClientLabelValues): void;
}

export interface PromClientHistogram {
  observe(value: number): void;
  observe(labels: PromClientLabelValues, value: number): void;
  labels(values: PromClientLabelValues): { observe(v: number): void };
  remove(labels: PromClientLabelValues): void;
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
 * **`collect()` on the returned registry is empty and always will be** —
 * prom-client holds the canonical state and this bridge keeps no copy of
 * it, so the registry declares `collectable: false` (#744).  Read the
 * framework's metrics the way you read your own: `register.metrics()` on
 * the prom-client side.  Anything in this framework that reads through
 * `collect()` — the management `GET /metrics` route, the DevTools
 * overview — reports the figures as unavailable rather than as zero while
 * this bridge is installed.
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
     * **Always empty**, and `collectable` above is how a reader finds that
     * out before believing it.
     *
     * The bridge writes through to prom-client and mirrors nothing, so
     * there is no snapshot here to hand back: the values are in the
     * registry the caller owns, and translating them back would put a
     * second, competing exposition of the same series next to the user's
     * own `/metrics` handler.  Read them there — `register.metrics()`, or
     * `register.getMetricsAsJSON()` in a test.
     *
     * This used to be documented as a translated snapshot in two places,
     * which is how both of the framework's own readers came to render the
     * empty array as a busy system reporting zeros (#744).
     */
    collect(): ReadonlyArray<MetricSample> {
      return [];
    },

    /**
     * `false`: see {@link collect}.  Declared as a property on the returned
     * literal rather than by throwing from `collect()`, because a reader has
     * to be able to ask *before* it commits to an answer — the management
     * route needs to choose a status code, and the DevTools sampler needs to
     * choose between a figure and a dash.  A throw would only move the
     * failure from a silent wrong number to a loud one.
     */
    collectable: false,

    /**
     * Forward a removal to prom-client's own per-child eviction (#745).
     *
     * The local `series` tally is dropped first and unconditionally, because
     * it is the only thing the cardinality cap counts: leaving the key in it
     * would keep a slot spent on a tuple that no longer exists, which is the
     * accounting error the cap exists to prevent. `false` therefore means
     * "this bridge never minted that tuple", not "prom-client refused".
     *
     * `DefaultMetricsRegistry`'s refusal to evict the overflow child falls
     * out of the same tally rather than needing a special case here:
     * `seriesLabelsOf` deliberately never adds the overflow tuple to
     * `series` — it is not counted against the cap — so a removal naming it
     * finds nothing, returns `false`, and never reaches prom-client.
     */
    remove(name, labels): boolean {
      const entry = families.get(fullName(name));
      if (entry === undefined) return false;
      if (!entry.series.delete(labelKey(labels))) return false;
      entry.impl.remove(asPromLabels(labels));
      return true;
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
