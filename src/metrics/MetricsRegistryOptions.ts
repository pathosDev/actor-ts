import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Built-in cap on distinct label tuples per metric family — the bound
 * that keeps a user-controlled label value from turning one family into
 * a million time series (#131).
 *
 * **Why 10 000 rather than the 1024 the report proposed.**  A cap only
 * protects if it sits above the largest series count the system can
 * legitimately reach; below that it silently discards real operating
 * data instead of an attack.  Two families can reach thousands with
 * nothing hostile happening: `actor_mailbox_size` carries a `path`, one
 * series per actor sustaining a 10 000-message backlog, so a node whose
 * sharded entities are all behind at once produces one per entity; and
 * `persistence_projection_*` carries a `projection`, which under the
 * documented per-pid fan-out is one per entity as well.  A 1024 cap
 * would fold those into the overflow series precisely when an operator
 * most needs to read them — an incident is exactly when both families
 * are at their widest.
 *
 * 10 000 clears that by an order of magnitude and still bounds the
 * damage: at the ~500 B a series costs in V8, a capped family holds
 * ~5 MB resident instead of the ~500 MB an unbounded million-series
 * family reaches, and the scrape body stays in the hundreds of KB
 * rather than tens of MB.  It is also already past the point where a
 * single family is an operational problem worth alerting on, so a
 * deployment that hits the cap wants to hear about it.
 *
 * This used to be argued from `actor_mailbox_dropped_total`'s `path`
 * label, which #658 removed.  The number did not move with it: the two
 * families above inherit the argument intact, and both — unlike the
 * drop counter — mint a series only for an actor or a projection that
 * is *already* in trouble, so their width is bounded by how much of the
 * deployment is broken rather than by how much traffic it is serving.
 */
export const DEFAULT_MAX_SERIES_PER_FAMILY = 10_000;

/** Plain options-object shape accepted by a {@link DefaultMetricsRegistry}. */
export type MetricsRegistryOptionsType = {
  /**
   * Cap on distinct label tuples per metric family.  Once a family has
   * minted this many series, every further tuple is folded into a single
   * overflow series instead of creating a new one, and the registry logs
   * one warning naming the family.
   *
   * Default {@link DEFAULT_MAX_SERIES_PER_FAMILY}.  **`0` disables the
   * cap** — only safe when every label value provably comes from a
   * bounded set.  (`0` rather than `Infinity`: the cap is an integer
   * count and `Infinity` is not an integer, so it would not survive
   * validation.)
   */
  readonly maxSeriesPerFamily?: number;
};

/**
 * Fluent builder for {@link MetricsRegistryOptionsType}:
 *
 *     const metricsOptions = MetricsRegistryOptions.create().withMaxSeriesPerFamily(50_000);
 *     system.extension(MetricsExtensionId).enable(metricsOptions);
 */
export class MetricsRegistryOptionsBuilder extends OptionsBuilder<MetricsRegistryOptionsType> {
  /** Start a fresh builder.  Equivalent to `new MetricsRegistryOptionsBuilder()`. */
  static create(): MetricsRegistryOptionsBuilder {
    return new MetricsRegistryOptionsBuilder();
  }

  /** Cap on distinct label tuples per metric family.  `0` disables the cap. */
  withMaxSeriesPerFamily(maxSeriesPerFamily: number): this {
    return this.set('maxSeriesPerFamily', maxSeriesPerFamily);
  }
}

/** Validates resolved {@link MetricsRegistryOptionsType} settings. */
export class MetricsRegistryOptionsValidator extends OptionsValidator<MetricsRegistryOptionsType> {
  constructor() {
    super('MetricsRegistryOptions');
  }
  protected rules(): void {
    // `>= 0` rather than `>= 1`: 0 is the documented opt-out.
    this.nonNegativeInt('maxSeriesPerFamily');
  }
}

/**
 * Accepted input for the {@link DefaultMetricsRegistry} constructor: the
 * fluent {@link MetricsRegistryOptionsBuilder} OR a plain
 * {@link MetricsRegistryOptionsType} object.
 */
export type MetricsRegistryOptions = MetricsRegistryOptionsBuilder | Partial<MetricsRegistryOptionsType>;
/** Value alias so `MetricsRegistryOptions.create()` / `new MetricsRegistryOptions()` resolve to the builder. */
export const MetricsRegistryOptions = MetricsRegistryOptionsBuilder;
