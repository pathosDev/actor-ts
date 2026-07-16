import { NodeAddress } from '../cluster/NodeAddress.js';
import type { SeedProvider } from './SeedProvider.js';

/**
 * Chain multiple providers — first provider that returns a non-empty list
 * wins.  If all providers fail or return empty, the aggregate returns an
 * empty array (the caller can choose to retry).  Individual provider
 * failures are logged but don't abort the chain.
 */
export class AggregateSeedProvider implements SeedProvider {
  constructor(
    private readonly providers: ReadonlyArray<SeedProvider>,
    private readonly log: (message: string, err?: unknown) => void = () => {},
  ) {}

  async lookup(): Promise<NodeAddress[]> {
    for (const provider of this.providers) {
      try {
        const seeds = await provider.lookup();
        if (seeds.length > 0) return seeds;
      } catch (err) {
        this.log(`seed provider threw — falling through to next`, err);
      }
    }
    return [];
  }
}
