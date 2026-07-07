import { NodeAddress } from '../cluster/NodeAddress.js';
import { resolveSettings } from '../util/OptionsBuilder.js';
import { ConfigSeedProviderOptions } from './ConfigSeedProviderOptions.js';
import type { SeedProvider } from './SeedProvider.js';

export interface ConfigSeedProviderSettings {
  /** Static list of "system@host:port" or "host:port" strings. */
  readonly seeds: string[];
  /** Default system name used when a seed string omits it. */
  readonly systemName: string;
}

/**
 * Simplest `SeedProvider`: returns a fixed list of addresses passed at
 * construction time (typically sourced from config or ENV).
 */
export class ConfigSeedProvider implements SeedProvider {
  private readonly settings: ConfigSeedProviderSettings;

  constructor(options: ConfigSeedProviderOptions | Partial<ConfigSeedProviderSettings> = {}) {
    this.settings = resolveSettings(options) as ConfigSeedProviderSettings;
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
