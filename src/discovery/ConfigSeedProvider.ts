import { NodeAddress } from '../cluster/NodeAddress.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { SeedProvider } from './SeedProvider.js';

export interface ConfigSeedProviderSettings {
  /** Static list of "system@host:port" or "host:port" strings. */
  readonly seeds: string[];
  /** Default system name used when a seed string omits it. */
  readonly systemName: string;
}

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

/**
 * Simplest `SeedProvider`: returns a fixed list of addresses passed at
 * construction time (typically sourced from config or ENV).
 */
export class ConfigSeedProvider implements SeedProvider {
  private readonly settings: ConfigSeedProviderSettings;

  constructor(options: ConfigSeedProviderOptions) {
    this.settings = options.build() as ConfigSeedProviderSettings;
  }

  async lookup(): Promise<NodeAddress[]> {
    return this.settings.seeds.map((raw) => {
      const text = raw.includes('@') ? raw : `${this.settings.systemName}@${raw}`;
      return NodeAddress.parse(text);
    });
  }
}

/** Read seeds from an environment variable (comma-separated). */
export function seedsFromEnv(varName: string, systemName: string): ConfigSeedProvider {
  const raw = process.env[varName] ?? '';
  const seeds = raw.split(',').map(s => s.trim()).filter(Boolean);
  return new ConfigSeedProvider(
    ConfigSeedProviderOptions.create().withSeeds(seeds).withSystemName(systemName),
  );
}
