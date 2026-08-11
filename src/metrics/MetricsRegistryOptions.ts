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
 * data instead of an attack.  `actor_mailbox_dropped_total` carries a
 * `path` label — one series per dropping actor path — so a node hosting
 * a few thousand sharded entities under back-pressure crosses 1024 with
 * nothing hostile happening at all, and a 1024 cap would fold genuine
 * per-entity drop counts into the overflow series precisely when an
 * operator most needs to read them.  10 000 clears that by an order of
 * magnitude and still bounds the damage: at the ~500 B a series costs in
 * V8, a capped family holds ~5 MB resident instead of the ~500 MB an
 * unbounded million-series family reaches, and the scrape body stays in
 * the hundreds of KB rather than tens of MB.  It is also already past
 * the point where a single family is an operational problem worth
 * alerting on, so a deployment that hits the cap wants to hear about it.
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
