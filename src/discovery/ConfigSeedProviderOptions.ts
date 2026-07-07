import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { ConfigSeedProviderSettings } from './ConfigSeedProvider.js';

/**
 * Fluent builder for {@link ConfigSeedProviderSettings}.
 *
 *     new ConfigSeedProvider(
 *       ConfigSeedProviderOptions.create()
 *         .withSeeds(['a@host1:2552', 'host2:2552'])
 *         .withSystemName('my-system'),
 *     );
 */
export class ConfigSeedProviderOptions extends OptionsBuilder<ConfigSeedProviderSettings> {
  /** Start a fresh builder.  Equivalent to `new ConfigSeedProviderOptions()`. */
  static create(): ConfigSeedProviderOptions {
    return new ConfigSeedProviderOptions();
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
