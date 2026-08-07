import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type {
  PromClientLike,
  PromClientRegistryLike,
} from './PromClientAdapter.js';

/** Plain options-object shape accepted by {@link promClientRegistry}. */
export type PromClientAdapterOptionsType = {
  /** The prom-client API namespace (`import client from 'prom-client'`). */
  readonly client: PromClientLike;
  /** The prom-client `Registry` to publish into.  Typically `client.register`. */
  readonly registry: PromClientRegistryLike;
  /**
   * Optional name prefix, e.g. `'actor_ts_'`.  Applied to every metric
   * name registered through the adapter.  Default: empty.
   */
  readonly namePrefix?: string;
  /**
   * Cap on distinct label tuples per metric family, mirroring the
   * `DefaultMetricsRegistry` cap on the bridge (#131).  prom-client mints
   * a series inside its own `Counter`/`Gauge`/`Histogram` on every
   * `.labels(...)` call and never expires one, so without a cap here the
   * bridge is the *more* exposed of the two paths.  Past the cap the
   * bridge folds further tuples into a single overflow series, leaving
   * prom-client with at most `maxSeriesPerFamily + 1` tuples per family.
   *
   * Default: `DEFAULT_MAX_SERIES_PER_FAMILY`, the same 10 000 the
   * in-process registry uses; `0` disables the cap.
   */
  readonly maxSeriesPerFamily?: number;
};

/**
 * Fluent builder for {@link PromClientAdapterOptionsType}:
 *
 *     promClientRegistry(
 *       PromClientAdapterOptions.create()
 *         .withClient(client)
 *         .withRegistry(client.register)
 *         .withNamePrefix('actor_ts_'),
 *     )
 *
 * `withClient` + `withRegistry` are mandatory — the bridge has nothing to
 * publish into without them.
 */
export class PromClientAdapterOptionsBuilder extends OptionsBuilder<PromClientAdapterOptionsType> {
  /** Start a fresh builder.  Equivalent to `new PromClientAdapterOptionsBuilder()`. */
  static create(): PromClientAdapterOptionsBuilder {
    return new PromClientAdapterOptionsBuilder();
  }

  /** The prom-client API namespace (`import client from 'prom-client'`). */
  withClient(client: PromClientLike): this {
    return this.set('client', client);
  }

  /** The prom-client `Registry` to publish into.  Typically `client.register`. */
  withRegistry(registry: PromClientRegistryLike): this {
    return this.set('registry', registry);
  }

  /** Name prefix, e.g. `'actor_ts_'`, applied to every registered metric name.  Default: empty. */
  withNamePrefix(namePrefix: string): this {
    return this.set('namePrefix', namePrefix);
  }

  /** Cap on distinct label tuples per metric family.  `0` disables the cap. */
  withMaxSeriesPerFamily(maxSeriesPerFamily: number): this {
    return this.set('maxSeriesPerFamily', maxSeriesPerFamily);
  }
}

/** Validates resolved {@link PromClientAdapterOptionsType} settings. */
export class PromClientAdapterOptionsValidator extends OptionsValidator<PromClientAdapterOptionsType> {
  constructor() {
    super('PromClientAdapterOptions');
  }
  protected rules(): void {
    // `>= 0` rather than `>= 1`: 0 is the documented cap opt-out.
    this.nonNegativeInt('maxSeriesPerFamily');
  }
}

/**
 * Accepted input for {@link promClientRegistry}: the fluent
 * {@link PromClientAdapterOptionsBuilder} OR a plain
 * {@link PromClientAdapterOptionsType} object.
 */
export type PromClientAdapterOptions = PromClientAdapterOptionsBuilder | Partial<PromClientAdapterOptionsType>;
/** Value alias so `PromClientAdapterOptions.create()` / `new PromClientAdapterOptions()` resolve to the builder. */
export const PromClientAdapterOptions = PromClientAdapterOptionsBuilder;
