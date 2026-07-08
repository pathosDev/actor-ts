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
 * Cardinality discipline is the user's responsibility — high-cardinality
 * labels (request id, user id, …) will OOM your monitoring system.  The
 * registry doesn't enforce limits; it'll happily create one series per
 * combo you ask for.
 *
 * Exposition format is decoupled — see {@link PrometheusExporter} for
 * the Prometheus 0.0.4 text format implementation.
 */

export type LabelValue = string | number | boolean;
export type Labels = Readonly<Record<string, LabelValue>>;

/* --------------------------- Sample shape --------------------------- */

/**
 * A single point-in-time observation of one metric series.  Exporters
 * walk the registry and turn each sample into their wire format.
 */
export interface MetricSample {
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
}

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
 */
interface CounterFamily {
  readonly kind: 'counter';
  readonly help: string;
  readonly children: Map<string, { labels: Labels; metric: CounterImplementation }>;
}
interface GaugeFamily {
  readonly kind: 'gauge';
  readonly help: string;
  readonly children: Map<string, { labels: Labels; metric: GaugeImplementation }>;
}
interface HistogramFamily {
  readonly kind: 'histogram';
  readonly help: string;
  readonly buckets: ReadonlyArray<number>;
  readonly children: Map<string, { labels: Labels; metric: HistogramImplementation }>;
}

type Family = CounterFamily | GaugeFamily | HistogramFamily;

export interface CounterOptions { readonly help?: string }
export interface GaugeOptions { readonly help?: string }
export interface HistogramOptions {
  readonly help?: string;
  /** Override the default bucket set.  Sorted automatically. */
  readonly buckets?: ReadonlyArray<number>;
}

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
  counter(name: string, labels?: Labels, opts?: CounterOptions): Counter;
  gauge(name: string, labels?: Labels, opts?: GaugeOptions): Gauge;
  histogram(name: string, labels?: Labels, opts?: HistogramOptions): Histogram;

  /** Snapshot every series as a flat list of {@link MetricSample}s. */
  collect(): ReadonlyArray<MetricSample>;

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

  counter(name: string, labels: Labels = {}, opts: CounterOptions = {}): Counter {
    const family = this.familyOf(name, 'counter', opts.help);
    return this.childOf<CounterImplementation>(family, labels, () => new CounterImplementation());
  }

  gauge(name: string, labels: Labels = {}, opts: GaugeOptions = {}): Gauge {
    const family = this.familyOf(name, 'gauge', opts.help);
    return this.childOf<GaugeImplementation>(family, labels, () => new GaugeImplementation());
  }

  histogram(name: string, labels: Labels = {}, opts: HistogramOptions = {}): Histogram {
    const family = this.familyOf(name, 'histogram', opts.help, opts.buckets);
    return this.childOf<HistogramImplementation>(family, labels,
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
          const h = child.metric as HistogramImplementation;
          let cumulative = 0;
          for (let i = 0; i < h.buckets.length; i++) {
            cumulative = h.counts[i]!;       // counts are already cumulative inside observe()
            out.push({
              name, help: family.help, kind: 'histogram',
              labels: child.labels, value: cumulative,
              bucket: h.buckets[i]!,
            });
          }
          out.push({
            name, help: family.help, kind: 'histogram',
            labels: child.labels, value: 0,  // unused for sum/count rows
            sum: h.sum, count: h.count,
          });
        }
      }
    }
    return out;
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
    family: Family, labels: Labels, factory: () => M,
  ): M {
    const key = labelKey(labels);
    const existing = family.children.get(key);
    if (existing) return existing.metric as unknown as M;
    const metric = factory();
    family.children.set(key, { labels: { ...labels }, metric: metric as never });
    return metric;
  }
}

/** Stable string key for a label set — used as the inner-map key. */
function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${String(labels[k])}`).join('\x1f');
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
 */
export class NoopMetricsRegistry implements MetricsRegistry {
  counter(): Counter { return NOOP_COUNTER; }
  gauge(): Gauge { return NOOP_GAUGE; }
  histogram(): Histogram { return NOOP_HIST; }
  collect(): ReadonlyArray<MetricSample> { return []; }
  clear(): void {}
}
