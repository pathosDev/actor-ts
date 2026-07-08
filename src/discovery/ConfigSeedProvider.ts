import { NodeAddress } from '../cluster/NodeAddress.js';
import { ConfigSeedProviderOptions } from './ConfigSeedProviderOptions.js';
import type { ConfigSeedProviderOptionsType } from './ConfigSeedProviderOptions.js';
import type { SeedProvider } from './SeedProvider.js';

/**
 * Simplest `SeedProvider`: returns a fixed list of addresses passed at
 * construction time (typically sourced from config or ENV).
 */
export class ConfigSeedProvider implements SeedProvider {
  private readonly options: ConfigSeedProviderOptionsType;

  constructor(options: ConfigSeedProviderOptions = {}) {
    this.options = options as ConfigSeedProviderOptionsType;
  }

  async lookup(): Promise<NodeAddress[]> {
    return this.options.seeds.map((raw) => {
      const text = raw.includes('@') ? raw : `${this.options.systemName}@${raw}`;
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
