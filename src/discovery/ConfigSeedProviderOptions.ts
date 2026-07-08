import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Plain settings-object shape accepted by a {@link ConfigSeedProvider}. */
export interface ConfigSeedProviderOptionsType {
  /** Static list of "system@host:port" or "host:port" strings. */
  readonly seeds: string[];
  /** Default system name used when a seed string omits it. */
  readonly systemName: string;
}

/**
 * Fluent builder for {@link ConfigSeedProviderOptionsType}.
 *
 *     new ConfigSeedProvider(
 *       ConfigSeedProviderOptions.create()
 *         .withSeeds(['a@host1:2552', 'host2:2552'])
 *         .withSystemName('my-system'),
 *     );
 */
export class ConfigSeedProviderOptionsBuilder extends OptionsBuilder<ConfigSeedProviderOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ConfigSeedProviderOptionsBuilder()`. */
  static create(): ConfigSeedProviderOptionsBuilder {
    return new ConfigSeedProviderOptionsBuilder();
  }

  /** Static list of "system@host:port" or "host:port" strings. */
  withSeeds(seeds: string[]): this {
    return this.set('seeds', seeds);
  }

  /** Default system name used when a seed string omits it. */
  withSystemName(systemName: string): this {
    return this.set('systemName', systemName);
  }
}

/** Validates resolved {@link ConfigSeedProviderOptionsType} settings. */
export class ConfigSeedProviderOptionsValidator extends OptionsValidator<ConfigSeedProviderOptionsType> {
  constructor() {
    super('ConfigSeedProviderOptions');
  }
  protected rules(_s: Partial<ConfigSeedProviderOptionsType>): void {
    this.nonEmptyArray('seeds');
    this.nonEmptyString('systemName');
  }
}

/**
 * Accepted input for the {@link ConfigSeedProvider} constructor: the fluent
 * {@link ConfigSeedProviderOptionsBuilder} OR a plain
 * {@link ConfigSeedProviderOptionsType} object.
 */
export type ConfigSeedProviderOptions = ConfigSeedProviderOptionsBuilder | Partial<ConfigSeedProviderOptionsType>;
/** Value alias so `ConfigSeedProviderOptions.create()` / `new ConfigSeedProviderOptions()` resolve to the builder. */
export const ConfigSeedProviderOptions = ConfigSeedProviderOptionsBuilder;
