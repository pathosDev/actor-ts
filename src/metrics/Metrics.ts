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
 * Names and label keys, by contrast, are **not** a place for data of any
 * kind: they must be developer-chosen constants (#784).  The exposition is
 * a line-oriented text format, and only a label *value* is quoted and
 * escaped there — a name and a label key are interpolated raw, because the
 * format gives them no escaping to interpolate them with.  A metric name
 * derived from a tenant, a route or a header therefore lets whoever
 * controls that string end the current series and write another one, and
 * the forged series is indistinguishable from a real one to whatever
 * scrapes it — an alert on `node_up == 0` is silenced by a fabricated `1`
 * as effectively as by a fixed outage.  `DefaultMetricsRegistry` refuses
 * both at registration: a name outside
 * {@link PROMETHEUS_METRIC_NAME_PATTERN} and a label key outside
 * {@link PROMETHEUS_LABEL_NAME_PATTERN} throw, the way `ActorPath` refuses
 * an actor name that would corrupt the path it becomes part of.
 * If a per-tenant or per-route breakdown is what you want, it belongs in a
 * label *value* — bounded with {@link bucketize} — never in the name.
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
  PROMETHEUS_LABEL_NAME_PATTERN,
  PROMETHEUS_METRIC_NAME_PATTERN,
  RESERVED_LABEL_PREFIX,
  STRIPPED_CONTROL_CHARACTERS_PATTERN,
  THREAD_LABEL,
} from './Constants.js';
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
   * Whether {@link MetricsRegistry.collect} is this registry's source of
   * truth (#744).
   *
   * Optional, and **absent means `true`** — a registry that holds its own
   * samples is collectable and says nothing, which is every implementation
   * written before this flag existed, here and outside this repository.
   * A registry sets it to `false` only when it forwards writes to a foreign
   * collector and keeps no copy: its `collect()` is then empty because the
   * values live somewhere this interface cannot reach, not because nothing
   * has happened.
   *
   * The distinction has to be declared because an empty snapshot is
   * otherwise indistinguishable from a quiet system, and rendering it as
   * one is worse than an error: `exportPrometheus` turns it into a
   * zero-byte 0.0.4 body, which is a *valid* empty scrape — the target
   * stays `up=1` and every framework series simply stops existing, so
   * threshold alerts over them never fire again.  Readers ask
   * {@link isCollectable} and report the figures as unavailable instead.
   */
  readonly collectable?: boolean;

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
 * Can `registry.collect()` be believed?
 *
 * The default is deliberately optimistic — {@link MetricsRegistry.collectable}
 * is optional precisely so that every registry predating the flag keeps
 * meaning "yes" without being edited — so this reads as "not opted out"
 * rather than "opted in".  A reader that inverted it would report a plain
 * {@link DefaultMetricsRegistry} as unreadable.
 */
export function isCollectable(registry: MetricsRegistry): boolean {
  return registry.collectable !== false;
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
    const key = seriesKey(labels);
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
    // After the memo hit, never before it.  This runs once per family, on
    // the call that mints it; hoisting it above the `families.get` would
    // put a regex on every `counter(...).inc()` in the process for a
    // question whose answer cannot change — a name already in the map was
    // validated on the way in.
    assertValidMetricName(name);
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
    const key = seriesKey(labels);
    const existing = family.children.get(key);
    if (existing) return existing.metric as unknown as M;
    // After the memo hit, for the same reason as in `familyOf`: a tuple the
    // family already holds had its keys checked when it was minted, and the
    // hit is the path every write to an established series takes.  Before
    // the cap check, though — the overflow tuple reuses these key names, so
    // they have to be sound before they can be copied onto it.
    assertValidLabelKeys(name, labels);
    if (this.maxSeriesPerFamily > 0 && family.children.size >= this.maxSeriesPerFamily) {
      return this.overflowChildOf<M>(name, family, labels, factory);
    }
    const metric = factory();
    // Stored normalised, not as passed.  The child is the series, and what the
    // series *is* has to be the tuple every exporter will carry: `collect()`
    // feeds the Prometheus exporter, `MetricsRelay`'s worker snapshots and
    // `PromClientAdapter` alike, and a control byte surviving here would reach
    // all three under an identity the key already stripped.
    family.children.set(key, { labels: normalisedLabelsOf(labels), metric: metric as never });
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
      const key = seriesKey(overflowLabels);
      family.overflowKey = key;
      if (!family.children.has(key)) {
        family.children.set(key, { labels: overflowLabels, metric: factory() as never });
      }
      warnCardinalityOverflow(name, this.maxSeriesPerFamily, labels);
    }
    return family.children.get(family.overflowKey)!.metric as unknown as M;
  }
}

/**
 * Stable, **injective** string key for a label tuple — the inner-map key of a
 * family's children, the key {@link DefaultMetricsRegistry.remove} looks up,
 * and the key the exporter groups a histogram's rows by.
 *
 * One helper for all three deliberately (#1513): they have to agree on when
 * two tuples are the same series, and the exporter used to carry its own copy
 * of the encoding, so the two answers could drift.
 *
 * *Injective* is the load-bearing word.  The first version joined `k=v` pairs
 * with `\x1f`, and a label *value* is deliberately unrestricted — so
 * `{ a: 'x\x1fb=y' }` and `{ a: 'x', b: 'y' }` produced the same string, and
 * the second caller silently got the first one's series, labels and counts
 * included.  Moving to a rarer separator only moves the hole: any character
 * can appear in a value.  `JSON.stringify` over the sorted `[key, value]`
 * pairs cannot collide, because it escapes the quotes and backslashes that
 * delimit each string, so distinct pair lists have distinct encodings.
 *
 * Values are **rendered before they are encoded**, by
 * {@link renderedLabelValue}, and rendering is deliberately *not* injective on
 * {@link LabelValue}.  `{ code: 500 }` and `{ code: '500' }` are both
 * `code="500"` in the exposition, so they are one series there and have to be
 * one series here; and — the half #1414 shipped without — `{ msg: 'ab' }` and
 * `{ msg: 'a\x1fb' }` are both `msg="ab"`, because the control strip has no
 * escape to tell them apart with.  The key is injective on what is rendered,
 * never on what was passed.  Two tuples the exposition cannot distinguish
 * must not be two children: the body would then carry the same series twice,
 * and a Prometheus scrape rejects a duplicated series by rejecting the whole
 * body, so the rows would take every other family down with them.
 *
 * Sorted, so label order at the call site is irrelevant.  The encoding is
 * in-memory only — nothing persists it, sends it or parses it back — so it
 * may change again without a migration.
 *
 * The **unlabeled tuple short-circuits**, and that is not a micro-optimisation
 * for its own sake (#1414).  `ActorCell` makes three registry calls per
 * delivered user message — `actor_messages_delivered_total`,
 * `actor_mailbox_wait_seconds`, `actor_mailbox_depth` — and every one passes
 * `{}`; {@link DefaultMetricsRegistry.childOf} computes the key *before* the
 * memo lookup, so each is a fresh encode and not a hit on a cached string.
 * Without the short-circuit that is three `JSON.stringify` calls a message to
 * produce a constant, on a path whose neighbours are written against exactly
 * this class of cost, and one more per sample when the exporter groups an
 * unlabeled histogram's fourteen rows.
 *
 * Injectivity survives it, which is the only thing that made it safe to
 * restore: `''` is not the `JSON.stringify` of any non-empty array, because
 * every one of those begins with `[`.  The empty tuple keeps a key of its own.
 *
 * It is also what keeps the strip off the per-message path: the short-circuit
 * returns before a value is looked at, so the three unlabeled calls a
 * delivered message makes do no stripping at all — 47.2 ns before the strip
 * reached the mint path against 46.6 ns after, nine interleaved rounds of
 * 500 000 calls with the arms alternating, which is the same code and reads
 * as the same number.  A labeled tuple pays one scan per **string** value on
 * top of the encode it already paid: 316.7 → 350.1 ns for a one-string tuple
 * and 754.9 → 842.6 ns for two strings and a number, while a number-only
 * tuple is 327.7 → 325.7 ns because {@link renderedLabelValue} never asks.
 */
export function seriesKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return JSON.stringify(keys.map((key) => [key, renderedLabelValue(labels[key])]));
}

/**
 * Remove the C0 controls the exposition has no answer for — the strip, as one
 * declaration rather than one per layer (#1414).
 *
 * `PrometheusExporter` calls it when it writes a label value or a `# HELP`
 * string; {@link seriesKey} calls it before it encodes a tuple.  That both
 * sides call *this* function, reading *one*
 * {@link STRIPPED_CONTROL_CHARACTERS_PATTERN}, is what makes "the same strip
 * the exporter applies" a fact rather than a claim — a private second copy on
 * either side is how the two halves of #1414 came apart in the first place.
 *
 * Exported for the exporter, which is one module over, and not re-exported
 * from `src/metrics/index.ts`: the strip is an internal rule of the
 * exposition, not something a caller composes with.
 *
 * **It asks before it rewrites, and the asking is what makes it affordable on
 * the mint path.**  Almost no label value carries a control byte, and a
 * `replace` that finds nothing still builds a match and a result string;
 * `search` answers `-1` and allocates nothing.  Measured inside `seriesKey`,
 * nine rounds of 500 000 calls with the arms rotated per round, medians: over
 * one clean seven-character value, 325.8 ns before the strip reached the mint
 * path, 438.0 ns rewriting unconditionally, **383.7 ns asking first**; over a
 * three-label tuple, 720.0 / 1017.9 / **886.9 ns**.  Roughly half the added
 * cost, twice over.  A value that *does* carry a control scans twice and pays
 * 61 ns for it (533.3 → 594.6 ns), which is the right way round: that value
 * is a bug at its source, and the clean one is every request.
 *
 * Both readers leave `lastIndex` alone — see
 * {@link STRIPPED_CONTROL_CHARACTERS_PATTERN}, where the rule that `.test` may
 * not be used on it lives.
 */
export function stripExpositionControlCharacters(text: string): string {
  return text.search(STRIPPED_CONTROL_CHARACTERS_PATTERN) === -1
    ? text
    : text.replace(STRIPPED_CONTROL_CHARACTERS_PATTERN, '');
}

/**
 * One label value as the exposition will carry it.
 *
 * Only a `string` can hold a control byte, so a number or a boolean skips the
 * scan entirely and goes straight through `String` — the branch is not a
 * micro-optimisation for its own sake but the reason a `{ code: 500 }` tuple
 * costs exactly what it cost before this rule existed.
 */
function renderedLabelValue(value: LabelValue): string {
  return typeof value === 'string' ? stripExpositionControlCharacters(value) : String(value);
}

/**
 * The tuple a child is stored under: every value normalised, every non-string
 * left as the type it was passed as.
 *
 * Rendering the numbers to strings here would be the wider change and a wrong
 * one — `collect()` hands `MetricSample.labels` to exporters that have their
 * own formatting, and `{ code: 500 }` is a number until one of them renders
 * it.  What has to go is only what the exposition cannot represent.
 *
 * A fresh object either way, because the caller's may be mutated after the
 * call; this replaces the `{ ...labels }` copy the mint path already made, so
 * it is not a second allocation.
 */
function normalisedLabelsOf(labels: Labels): Labels {
  const normalised: Record<string, LabelValue> = {};
  for (const key of Object.keys(labels)) {
    const value = labels[key];
    normalised[key] = typeof value === 'string'
      ? stripExpositionControlCharacters(value)
      : value;
  }
  return normalised;
}

/* --------------------------- Name validation ------------------------- */

/**
 * Reject a metric name the exposition cannot carry safely (#784).
 *
 * A hard throw rather than a sanitising rewrite, matching `ActorPath`'s
 * treatment of an actor name: silently renaming a family would produce a
 * series under a name the call site never asked for, so a dashboard and an
 * alert rule would both quietly miss it, and the developer would find out
 * from a blank panel rather than from a stack trace at the call that is
 * actually wrong.  The check is unconditional and has no configuration key
 * — a deployment that could switch it off would be a deployment where the
 * exporter's raw interpolation is unguarded again.
 *
 * The offending name is put through `JSON.stringify` so the *message* is
 * not itself an injection point: a name carrying a newline would otherwise
 * forge a line in whatever log the error is written to, which is the same
 * defect one layer up.
 */
function assertValidMetricName(name: string): void {
  if (!PROMETHEUS_METRIC_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid metric name ${JSON.stringify(name)}: must match ` +
      `${String(PROMETHEUS_METRIC_NAME_PATTERN)}. Metric names are part of the ` +
      `Prometheus exposition grammar and cannot be escaped, so they must be ` +
      `developer-chosen constants — put request-derived data in a label value ` +
      `(bounded with bucketize), never in the name.`,
    );
  }
}

/**
 * Why the exposition reserves this label key, or `null` when it does not
 * (#1570, #1513).
 *
 * **One predicate, two doors.**  {@link assertValidLabelKeys} refuses a
 * reserved key when a family is minted; `MetricsRelay`'s
 * `describeSampleProblem` refuses a relayed snapshot carrying one, because a
 * worker's samples never passed a registry of ours.  Spelled out twice — which
 * is how they stood — the two drift, and a rule on one side only is worse than
 * no rule at all: either a key the mint refuses still reaches the exposition
 * through a worker, or a key every call site may mint makes a worker's whole
 * snapshot disappear for a reason no stack trace names.  So the rule lives
 * here, and the two sites differ only in how they frame the answer: a throw
 * naming the call that is wrong, a log line naming the snapshot that was
 * dropped.
 *
 * The reason is therefore phrased as a property of the *key* rather than of
 * either door — it has to read correctly in both messages.
 *
 * {@link THREAD_LABEL} is a whole-key match and
 * {@link RESERVED_LABEL_PREFIX} a prefix one, which is the difference between
 * a key this project reserves (`thread_pool` and `threads` must stay legal)
 * and a namespace the server reserves (`__meta_*` is open-ended by design).
 */
export function describeReservedLabelKey(key: string): string | null {
  if (key === THREAD_LABEL) {
    return `the exposition stamps every sample with the thread that produced it while a worker ` +
      `mesh relays its registries (#1570), so an application label under this key would be ` +
      `overwritten on the main thread and refused on a worker`;
  }
  if (key.startsWith(RESERVED_LABEL_PREFIX)) {
    return `Prometheus reserves label names beginning with "${RESERVED_LABEL_PREFIX}" for the ` +
      `server's own use (#1513): it drops them after relabeling, and a scrape job configured ` +
      `with honor_labels: true keeps a "__name__" among them and files the sample under the ` +
      `name that label carries — the forged series #784 is about, one layer later`;
  }
  return null;
}

/**
 * Reject a label key the exposition cannot carry safely (#784), and the keys
 * the exposition reserves for itself (#1570, #1513).
 *
 * Same rule and same reasoning as {@link assertValidMetricName}, one field
 * over: `renderLabels` quotes and escapes the value and cannot do either
 * for the key.  The family name travels into the message because a bad key
 * is otherwise hard to place — the tuple is usually built several frames
 * away from the call that registers it.
 *
 * The reservations are refused here, at the mint, rather than reconciled at
 * export.  For {@link THREAD_LABEL} that is because
 * `MetricsExtension.collectAll` stamps every sample with the thread that
 * produced it while a worker mesh relays its threads' registries into one
 * scrape: an application label under the same key was overwritten on the main
 * thread — two values became two rows with one identical label set, which a
 * Prometheus scrape rejects wholesale — and on a worker it made the relay
 * refuse that thread's whole snapshot.  For {@link RESERVED_LABEL_PREFIX} it
 * is because the forgery the grammar check stops in the name position returns
 * in the key position under `honor_labels`.  Both were a silent time bomb of
 * somebody else's configuration: legal here, wrong at the server.  Refused
 * when the family is minted, they are an error at the developer's desk
 * instead, with the rename in the message.
 *
 * Which keys are reserved is {@link describeReservedLabelKey}'s answer, not
 * this function's — the worker relay asks the same question of a snapshot it
 * did not mint.
 */
function assertValidLabelKeys(name: string, labels: Labels): void {
  for (const key of Object.keys(labels)) {
    if (!PROMETHEUS_LABEL_NAME_PATTERN.test(key)) {
      throw new Error(
        `Invalid label key ${JSON.stringify(key)} on metric ${JSON.stringify(name)}: ` +
        `must match ${String(PROMETHEUS_LABEL_NAME_PATTERN)}. Label keys are part of ` +
        `the Prometheus exposition grammar and cannot be escaped, so they must be ` +
        `developer-chosen constants — put request-derived data in the label value ` +
        `(bounded with bucketize), never in the key.`,
      );
    }
    const reserved = describeReservedLabelKey(key);
    if (reserved !== null) {
      throw new Error(
        `Reserved label key ${JSON.stringify(key)} on metric ${JSON.stringify(name)}: ` +
        `${reserved} — rename the label.`,
      );
    }
  }
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
 *
 * That reservation is now the registry's rule as well as this constant's
 * reason — see {@link RESERVED_LABEL_PREFIX}, which refuses the prefix in
 * the key position while leaving this value exactly where it is.
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
