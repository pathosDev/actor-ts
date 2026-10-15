import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import type {
  PromClientLike,
  PromClientRegistryLike,
} from './PromClientAdapter.js';

/**
 * Built-in name prefix of the prom-client bridge: none.  The bridge publishes
 * the framework's families under the names the in-process registry uses, so a
 * dashboard written against one works against the other; a prefix is the
 * caller's choice to namespace them inside a registry it shares with its own
 * metrics.
 */
export const DEFAULT_PROM_CLIENT_NAME_PREFIX = '';

/** Plain options-object shape accepted by {@link promClientRegistry}. */
export type PromClientAdapterOptionsType = {
  /** The prom-client API namespace (`import client from 'prom-client'`). */
  readonly client: PromClientLike;
  /** The prom-client `Registry` to publish into.  Typically `client.register`. */
  readonly registry: PromClientRegistryLike;
  /**
   * Optional name prefix, e.g. `'actor_ts_'`.  Applied to every metric
   * name registered through the adapter.  Default
   * {@link DEFAULT_PROM_CLIENT_NAME_PREFIX}: none.
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

/**
 * The slice of the bridge's settings HOCON can supply.  `client` and
 * `registry` are missing on purpose: both are live objects — the `prom-client`
 * namespace the application imports and the `Registry` it publishes into —
 * which a config file cannot hold, so they stay code-only.
 */
export type PromClientAdapterConfigDefaults = Pick<PromClientAdapterOptionsType, 'namePrefix' | 'maxSeriesPerFamily'>;

/**
 * Read `actor-ts.metrics.*` for the prom-client bridge: the prefix, and the
 * cap the in-process registry reads from the same leaf.
 *
 * The `Config` is a **required argument**, and nothing here calls
 * `Config.load()`.  The one consumer is `MetricsExtension.enablePromClient()`,
 * which holds an `ActorSystem` and passes `system.config`; `promClientRegistry`
 * itself stays the pure code path and never reads a file, so a bridge built
 * without a system behaves exactly as its options say.
 *
 * An absent leaf stays absent rather than being filled with its built-in
 * default, so `mergeOptions` layers the caller's options over this answer per
 * field.  An empty `name-prefix` is returned as `''` rather than dropped: it is
 * the published default, not a placeholder, and a file that writes it out has
 * said something.
 */
export function readPromClientAdapterOptionsFromConfig(config: Config): PromClientAdapterConfigDefaults {
  const keys = ConfigKeys.metrics;
  const out: { -readonly [K in keyof PromClientAdapterConfigDefaults]: PromClientAdapterConfigDefaults[K] } = {};
  if (config.hasPath(keys.namePrefix)) out.namePrefix = config.getString(keys.namePrefix);
  if (config.hasPath(keys.maxSeriesPerFamily)) out.maxSeriesPerFamily = config.getInt(keys.maxSeriesPerFamily);
  return out;
}
