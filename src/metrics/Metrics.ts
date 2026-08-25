/**
 * In-process metrics primitives for the actor framework (#11).
 *
 * Three classic types:
 *
 *   - **Counter** — monotonic, only goes up.  Page views, messages
 *     delivered, restart counts.
 *   - **Gauge** — settable / inc/dec.  Mailbox depth, members up,
 *     active connections.
 *   - **Histogram** — fixed buckets + sum + count.  Persist latency,
 *     handler duration.  Bucket boundaries are upper-inclusive
 *     (`le="0.005"` matches the Prometheus convention).
 *
 * Metrics carry **labels** — key/value tag pairs that turn one metric
 * into many time series.  A `MetricsRegistry.counter('foo')` with no
 * labels has one series; with `{node: 'n-1'}` you get one series per
 * distinct value of `node`.
 *
 * Cardinality is **capped, not unbounded** (#131).  A label value that
 * reaches the registry from user-controlled input — a URL path, a header,
 * an id — would otherwise mint one series per distinct value and take the
 * monitoring backend down with it.  `DefaultMetricsRegistry` therefore
 * stops minting new series per family at
 * {@link DEFAULT_MAX_SERIES_PER_FAMILY} and folds everything past it into
 * a single {@link METRICS_OVERFLOW_LABEL_VALUE} series.  The cap is a
 * backstop, not a licence: it bounds the blast radius, it does not make
 * a high-cardinality label correct.  Keep label values bounded at the
 * source — {@link bucketize} is the helper for the common "known values
 * plus everything else" shape.
 *
 * Series are also **removable** (#745).  A label tuple whose subject has
 * gone — an entity that passivated, an actor that stopped — would
 * otherwise outlive it for the life of the process, since the cap bounds
 * how many series a family holds but never releases one.  `remove()` is
 * how the instrument's owner says the tuple is finished; see its contract
 * on {@link MetricsRegistry} for why that is a call and not a TTL.
 *
 * Exposition format is decoupled — see {@link PrometheusExporter} for
 * the Prometheus 0.0.4 text format implementation.
 */

import {
  DEFAULT_MAX_SERIES_PER_FAMILY,
  MetricsRegistryOptionsValidator,
  type MetricsRegistryOptions,
  type MetricsRegistryOptionsType,
} from './MetricsRegistryOptions.js';

export type LabelValue = string | number | boolean;
export type Labels = Readonly<Record<string, LabelValue>>;

/* --------------------------- Sample shape --------------------------- */

/**
 * A single point-in-time observation of one metric series.  Exporters
 * walk the registry and turn each sample into their wire format.
 */
export type MetricSample = {
  /** Family name — e.g. `actor_messages_delivered_total`. */
  readonly name: string;
  /** Free-form description for `# HELP`. */
  readonly help: string;
  /** `'counter'`, `'gauge'`, `'histogram'`. */
  readonly kind: 'counter' | 'gauge' | 'histogram';
  /** Series-level labels.  Empty object for unlabeled series. */
  readonly labels: Labels;
  /** Counter / gauge value, or histogram sum (when `bucket` is set). */
  readonly value: number;
  /**
   * Histogram bucket upper bound.  When set, `value` carries the
   * cumulative count for that bucket; series name will be suffixed
   * with `_bucket` and labels will include `le=<bound>`.  Special
   * value `Infinity` represents the `+Inf` bucket.
   */
  readonly bucket?: number;
  /** For histograms: total observation count.  Series name `_count`. */
  readonly count?: number;
  /** For histograms: total observation sum.  Series name `_sum`. */
  readonly sum?: number;
};

/* ------------------------------- Counter ----------------------------- */

export interface Counter {
  inc(delta?: number): void;
  /** Read for testing — exporters use the registry's `collect()`. */
  readonly value: number;
}

class CounterImplementation implements Counter {
  private _v = 0;
  inc(delta = 1): void {
    if (delta < 0) throw new Error('Counter.inc requires delta >= 0');
    if (!Number.isFinite(delta)) throw new Error('Counter.inc requires a finite delta');
    this._v += delta;
  }
  get value(): number { return this._v; }
}

/* ------------------------------- Gauge ------------------------------- */

export interface Gauge {
  set(value: number): void;
  inc(delta?: number): void;
  dec(delta?: number): void;
  readonly value: number;
}

class GaugeImplementation implements Gauge {
  private _v = 0;
  set(v: number): void {
    if (!Number.isFinite(v)) throw new Error('Gauge.set requires a finite value');
    this._v = v;
  }
  inc(delta = 1): void {
    if (!Number.isFinite(delta)) throw new Error('Gauge.inc requires a finite delta');
    this._v += delta;
  }
  dec(delta = 1): void {
    if (!Number.isFinite(delta)) throw new Error('Gauge.dec requires a finite delta');
    this._v -= delta;
  }
  get value(): number { return this._v; }
}

/* ----------------------------- Histogram ----------------------------- */

/**
 * Default bucket boundaries — the Prometheus client-library defaults,
 * which work well for short-tail latencies in the 5ms..10s range.
 * Provide your own via `MetricsRegistry.histogram(..., { buckets })`
 * for histograms that don't fit this shape (e.g. payload sizes).
 */
export const DEFAULT_HISTOGRAM_BUCKETS: ReadonlyArray<number> = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);

export interface Histogram {
  /** Record an observation in seconds (or whatever unit your buckets use). */
  observe(value: number): void;
  /** Internal — exporters read via the registry. */
  readonly buckets: ReadonlyArray<number>;
  readonly counts: ReadonlyArray<number>;
  readonly sum: number;
  readonly count: number;
}

class HistogramImplementation implements Histogram {
  private readonly _buckets: ReadonlyArray<number>;
  private readonly _counts: number[];
  private _sum = 0;
  private _count = 0;

  constructor(buckets: ReadonlyArray<number>) {
    if (buckets.length === 0) throw new Error('Histogram: at least one bucket boundary required');
    // Defensive copy + sorted ascending; we add a +Inf bucket internally.
    const sorted = [...buckets].sort((a, b) => a - b);
    if (sorted.some((b) => !Number.isFinite(b))) {
      throw new Error('Histogram: bucket boundaries must be finite');
    }
    this._buckets = Object.freeze([...sorted, Number.POSITIVE_INFINITY]);
    this._counts = new Array(this._buckets.length).fill(0);
  }

  observe(v: number): void {
    if (!Number.isFinite(v)) {
      // Prometheus convention — only record if finite.  +Inf observations
      // are dropped; NaN throws so the bug is visible.
      if (Number.isNaN(v)) throw new Error('Histogram.observe: NaN');
      return;
    }
    this._sum += v;
    this._count += 1;
    for (let i = 0; i < this._buckets.length; i++) {
      if (v <= this._buckets[i]!) {
        this._counts[i]! += 1;
      }
    }
  }

  get buckets(): ReadonlyArray<number> { return this._buckets; }
  get counts(): ReadonlyArray<number> { return this._counts; }
  get sum(): number { return this._sum; }
  get count(): number { return this._count; }
}

/* ----------------------------- Registry ----------------------------- */

/**
 * Metric family metadata.  One family produces N series indexed by
 * label-tuple; series are created lazily on first label access.
 *
 * `overflowKey` is the series key of this family's single overflow child,
 * set the first time the cardinality cap bites.  Holding the key (rather
 * than recomputing it) is what guarantees a family can only ever gain
 * *one* extra series no matter how many distinct tuples arrive after the
 * cap, and doubles as the one-shot flag for the warning.
 *
 * It is never unset, not even when {@link DefaultMetricsRegistry.remove}
 * takes the family back under its cap.  The freed slot is genuinely
 * reusable — the next tuple mints a real series again — but the overflow
 * child stays, because it is the standing record that tuples were
 * discarded and its counter still holds how many.
 */
type CounterFamily = {
  readonly kind: 'counter';
  readonly help: string;
  readonly children: Map<string, { labels: Labels; metric: CounterImplementation }>;
  overflowKey?: string;
};
type GaugeFamily = {
  readonly kind: 'gauge';
  readonly help: string;
  readonly children: Map<string, { labels: Labels; metric: GaugeImplementation }>;
  overflowKey?: string;
};
type HistogramFamily = {
  readonly kind: 'histogram';
  readonly help: string;
  readonly buckets: ReadonlyArray<number>;
  readonly children: Map<string, { labels: Labels; metric: HistogramImplementation }>;
  overflowKey?: string;
};

type Family = CounterFamily | GaugeFamily | HistogramFamily;

export type CounterOptions = { readonly help?: string };
export type GaugeOptions = { readonly help?: string };
export type HistogramOptions = {
  readonly help?: string;
  /** Override the default bucket set.  Sorted automatically. */
  readonly buckets?: ReadonlyArray<number>;
};

/**
 * Collection of metric families bound to one ActorSystem.  Pluggable
 * exporters (`PrometheusExporter`) walk `collect()` to produce wire
 * format; tests use the typed `counter` / `gauge` / `histogram`
 * accessors directly.
 */
export interface MetricsRegistry {
  /**
   * Get-or-create a counter family.  Same `(name, help)` returns the
   * same family across calls; `labels` selects (or creates) a child
   * series within it.
   */
  counter(name: string, labels?: Labels, options?: CounterOptions): Counter;
  gauge(name: string, labels?: Labels, options?: GaugeOptions): Gauge;
  histogram(name: string, labels?: Labels, options?: HistogramOptions): Histogram;

  /** Snapshot every series as a flat list of {@link MetricSample}s. */
  collect(): ReadonlyArray<MetricSample>;

  /**
   * Drop one series, so a label tuple whose subject no longer exists stops
   * being exported and stops occupying a slot under the cardinality cap
   * (#745).  Returns whether a series was actually removed.
   *
   * **Caller-driven rather than a TTL, deliberately.**  The registry cannot
   * know when a tuple is dead — a series that has not moved in an hour is
   * either a finished entity or a counter for something rare, and those are
   * indistinguishable from here.  The instrument's owner does know:
   * {@link MailboxDepthSampler} walks the tree every tick and sees exactly
   * which paths left it.  An age-based sweep would also need a clock and a
   * timer in a primitive that has neither and has to stay allocation-cheap,
   * and it would be wrong for counters specifically: a counter that ages
   * out and is minted again reads as a reset that never happened.
   *
   * Removing a *counter's* series is therefore something to do only when
   * the thing it counted is gone for good, not to reclaim cardinality — a
   * scrape that straddles the removal sees the value fall to nothing and
   * back, which is a real reset to every backend that reads it.  Gauges
   * carry no such history and are the intended caller.
   */
  remove(name: string, labels?: Labels): boolean;

  /** Wipe the registry — primarily for tests. */
  clear(): void;
}

/**
 * Default in-memory implementation.  Thread-safe by virtue of being
 * single-threaded (Bun + Node both run JS on a single thread per
 * Worker; metrics live on the main thread of an ActorSystem).
 */
export class DefaultMetricsRegistry implements MetricsRegistry {
  private readonly families = new Map<string, Family>();
  /** Distinct label tuples one family may mint; `0` disables the cap. */
  private readonly maxSeriesPerFamily: number;

  constructor(options: MetricsRegistryOptions = {}) {
    // Destructuring default rather than a spread: `undefined` on the way
    // in means "not set" and must fall through to the default, never
    // shadow it.
    const {
      maxSeriesPerFamily = DEFAULT_MAX_SERIES_PER_FAMILY,
    } = options as MetricsRegistryOptionsType;
    new MetricsRegistryOptionsValidator().validate({ maxSeriesPerFamily });
    this.maxSeriesPerFamily = maxSeriesPerFamily;
  }

  counter(name: string, labels: Labels = {}, options: CounterOptions = {}): Counter {
    const family = this.familyOf(name, 'counter', options.help);
    return this.childOf<CounterImplementation>(name, family, labels, () => new CounterImplementation());
  }

  gauge(name: string, labels: Labels = {}, options: GaugeOptions = {}): Gauge {
    const family = this.familyOf(name, 'gauge', options.help);
    return this.childOf<GaugeImplementation>(name, family, labels, () => new GaugeImplementation());
  }

  histogram(name: string, labels: Labels = {}, options: HistogramOptions = {}): Histogram {
    const family = this.familyOf(name, 'histogram', options.help, options.buckets);
    return this.childOf<HistogramImplementation>(name, family, labels,
      () => new HistogramImplementation((family as HistogramFamily).buckets));
  }

  collect(): ReadonlyArray<MetricSample> {
    const out: MetricSample[] = [];
    for (const [name, family] of this.families) {
      for (const child of family.children.values()) {
        if (family.kind === 'counter') {
          out.push({
            name, help: family.help, kind: 'counter',
            labels: child.labels, value: (child.metric as CounterImplementation).value,
          });
        } else if (family.kind === 'gauge') {
          out.push({
            name, help: family.help, kind: 'gauge',
            labels: child.labels, value: (child.metric as GaugeImplementation).value,
          });
        } else {
          // Histogram: emit cumulative bucket samples + sum + count.
          const histogram = child.metric as HistogramImplementation;
          let cumulative = 0;
          for (let i = 0; i < histogram.buckets.length; i++) {
            cumulative = histogram.counts[i]!;       // counts are already cumulative inside observe()
            out.push({
              name, help: family.help, kind: 'histogram',
              labels: child.labels, value: cumulative,
              bucket: histogram.buckets[i]!,
            });
          }
          out.push({
            name, help: family.help, kind: 'histogram',
            labels: child.labels, value: 0,  // unused for sum/count rows
            sum: histogram.sum, count: histogram.count,
          });
        }
      }
    }
    return out;
  }

  remove(name: string, labels: Labels = {}): boolean {
    const family = this.families.get(name);
    if (family === undefined) return false;
    const key = labelKey(labels);
    // The overflow child is the one series that is not evictable.  It is the
    // record that this family discarded tuples, so deleting it would erase
    // the evidence; and `overflowKey` doubles as the once-per-family flag
    // for the warning, so a caller that removed it would re-arm a warning
    // the operator has already been given.
    if (key === family.overflowKey) return false;
    return family.children.delete(key);
  }

  clear(): void {
    this.families.clear();
  }

  /* ----------------------------- internals ---------------------------- */

  private familyOf(
    name: string, kind: Family['kind'], help: string | undefined,
    buckets?: ReadonlyArray<number>,
  ): Family {
    const existing = this.families.get(name);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(
          `Metric '${name}' already registered as ${existing.kind}, can't reuse as ${kind}`,
        );
      }
      return existing;
    }
    let family: Family;
    if (kind === 'counter') {
      family = { kind: 'counter', help: help ?? '', children: new Map() };
    } else if (kind === 'gauge') {
      family = { kind: 'gauge', help: help ?? '', children: new Map() };
    } else {
      family = {
        kind: 'histogram',
        help: help ?? '',
        buckets: buckets ?? DEFAULT_HISTOGRAM_BUCKETS,
        children: new Map(),
      };
    }
    this.families.set(name, family);
    return family;
  }

  private childOf<M>(
    name: string, family: Family, labels: Labels, factory: () => M,
  ): M {
    const key = labelKey(labels);
    const existing = family.children.get(key);
    if (existing) return existing.metric as unknown as M;
    if (this.maxSeriesPerFamily > 0 && family.children.size >= this.maxSeriesPerFamily) {
      return this.overflowChildOf<M>(name, family, labels, factory);
    }
    const metric = factory();
    family.children.set(key, { labels: { ...labels }, metric: metric as never });
    return metric;
  }

  /**
   * The family is at its cap: hand back its single overflow child,
   * creating it (and warning once) on the first tuple that overflows.
   *
   * The overflow tuple reuses the *label names* of that first rejected
   * tuple with every value replaced by {@link METRICS_OVERFLOW_LABEL_VALUE},
   * so the series stays shaped like its siblings and a dashboard grouping
   * on those labels still sees it.  A synthetic label *name* would not
   * work: Prometheus reserves `__`-prefixed names and strips them at
   * ingestion, which would silently merge the overflow series into the
   * family's unlabeled one.
   */
  private overflowChildOf<M>(
    name: string, family: Family, labels: Labels, factory: () => M,
  ): M {
    if (family.overflowKey === undefined) {
      const overflowLabels = overflowLabelsOf(Object.keys(labels));
      const key = labelKey(overflowLabels);
      family.overflowKey = key;
      if (!family.children.has(key)) {
        family.children.set(key, { labels: overflowLabels, metric: factory() as never });
      }
      warnCardinalityOverflow(name, this.maxSeriesPerFamily, labels);
    }
    return family.children.get(family.overflowKey)!.metric as unknown as M;
  }
}

/** Stable string key for a label set — used as the inner-map key. */
function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${String(labels[k])}`).join('\x1f');
}

/* --------------------------- Cardinality cap ------------------------- */

/**
 * Label **value** every dimension of an overflow series carries, e.g.
 * `actor_mailbox_size{class="__overflow__",path="__overflow__"}`.
 *
 * A value, deliberately, not a label name: Prometheus reserves label
 * names beginning with `__` for its own use and drops them after
 * relabeling, so an `__overflow__="1"` *name* would vanish on ingestion
 * and collapse the overflow series onto a real one.  Label values are
 * unrestricted, so the marker survives the scrape and stays greppable in
 * an alert rule (`{path="__overflow__"}`).
 */
export const METRICS_OVERFLOW_LABEL_VALUE = '__overflow__';

/** The overflow tuple for a family whose series carry `labelNames`. */
export function overflowLabelsOf(labelNames: ReadonlyArray<string>): Labels {
  const out: Record<string, LabelValue> = {};
  for (const labelName of labelNames) out[labelName] = METRICS_OVERFLOW_LABEL_VALUE;
  return out;
}

/**
 * One-shot warning when a family hits its cap.  Deliberately a bare
 * `console.warn` rather than a `Logger`: a registry is a standalone
 * primitive with no `ActorSystem` behind it (the prom-client bridge is
 * built by a free function), and the alternative — threading a logger
 * through the options — would put a hard dependency on the logging
 * subsystem into the one place that has to stay allocation-cheap.
 * Callers guarantee the once-per-family part.
 */
export function warnCardinalityOverflow(
  name: string, maxSeriesPerFamily: number, rejected: Labels,
): void {
  console.warn(
    `metrics: family '${name}' reached maxSeriesPerFamily=${maxSeriesPerFamily}; ` +
    `further label tuples are folded into a single ${METRICS_OVERFLOW_LABEL_VALUE} series. ` +
    `A user-controlled label value is the usual cause — bound it at the source ` +
    `(see bucketize) or raise the cap. First rejected tuple: ${JSON.stringify(rejected)}`,
  );
}

/**
 * Map a possibly-unbounded value onto a bounded label domain: `value` if
 * it is one of `allowed`, `'other'` otherwise.
 *
 *     const ALLOWED_ROUTES = ['/orders', '/users/:id', '/health'] as const;
 *     metrics.counter('http_requests_total', {
 *       route: bucketize(routeTemplateOf(request), ALLOWED_ROUTES),
 *     }).inc();
 *
 * This is the fix for high-cardinality labels; the registry's cap is only
 * the backstop for when nobody applied one.  Keep `allowed` small — it is
 * scanned linearly, and its length *is* the family's series count.
 */
export function bucketize<T extends string>(
  value: string, allowed: ReadonlyArray<T>,
): T | 'other' {
  return (allowed as ReadonlyArray<string>).includes(value) ? (value as T) : 'other';
}

/* ------------------------------ Noop ------------------------------- */

const NOOP_COUNTER: Counter = { inc: () => {}, get value() { return 0; } };
const NOOP_GAUGE: Gauge = { set: () => {}, inc: () => {}, dec: () => {}, get value() { return 0; } };
const NOOP_HIST: Histogram = {
  observe: () => {},
  buckets: [],
  counts: [],
  sum: 0,
  count: 0,
};

/**
 * Zero-cost registry that throws nothing away but records nothing.
 * Used as the default on `ActorSystem.metrics` so instrumentation
 * sprinkled through the codebase pays nothing when metrics aren't
 * enabled.
 *
 * The three accessors spell out {@link MetricsRegistry}'s parameters
 * even though they discard every one of them.  Omitting them still
 * satisfies `implements` — a function that ignores its arguments is
 * assignable to one that takes them — but this class is exported, so a
 * caller holding the concrete type rather than the interface got
 * `Expected 0 arguments, but got 1` on the ordinary `counter('name')`
 * call the interface documents (#540).
 */
export class NoopMetricsRegistry implements MetricsRegistry {
  counter(_name: string, _labels?: Labels, _options?: CounterOptions): Counter { return NOOP_COUNTER; }
  gauge(_name: string, _labels?: Labels, _options?: GaugeOptions): Gauge { return NOOP_GAUGE; }
  histogram(_name: string, _labels?: Labels, _options?: HistogramOptions): Histogram { return NOOP_HIST; }
  collect(): ReadonlyArray<MetricSample> { return []; }
  /** Always `false` — nothing was minted here, so nothing can be removed. */
  remove(_name: string, _labels?: Labels): boolean { return false; }
  clear(): void {}
}
