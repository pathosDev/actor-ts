import { NodeAddress } from '../cluster/NodeAddress.js';
import type { SeedProvider } from './SeedProvider.js';

/**
 * Every provider of a non-empty chain **threw** — discovery did not answer,
 * as opposed to answering "no peers".  A distinct type for the same reason
 * `StableObservationError` is one: the caller's sane responses (fail the
 * start, retry it) must be distinguishable from a programming error in the
 * same `await`, and conflating this case with an empty list is precisely how
 * a transient DNS outage used to become a self-elected one-node cluster
 * (#943).
 */
export class SeedDiscoveryError extends Error {
  constructor(
    message: string,
    /** One entry per provider that threw, in chain order. */
    readonly errors: ReadonlyArray<unknown>,
  ) {
    super(message);
    this.name = 'SeedDiscoveryError';
  }
}

/**
 * Chain multiple providers — the first provider that returns a non-empty
 * list wins, and a throwing provider is logged and skipped (#597: one
 * rejected rung degrades that rung only).
 *
 * The empty-vs-threw line is deliberate, and asymmetric on purpose:
 *
 * - **Zero providers**, or at least one provider that *returned* (an empty
 *   list included) → resolve `[]`.  An empty return is an authoritative
 *   "no peers" — the unconfigured single-node development flow depends on
 *   it, and a legitimately-empty rung after a broken one must still count.
 * - **A non-empty chain in which every provider threw** → reject with
 *   {@link SeedDiscoveryError}.  Nothing answered, so "no peers" was never
 *   established, and handing the caller `[]` converts a transient outage
 *   into a permanent split: the caller self-elects and never rejoins (#943).
 */
export class AggregateSeedProvider implements SeedProvider {
  constructor(
    private readonly providers: ReadonlyArray<SeedProvider>,
    private readonly log: (message: string, err?: unknown) => void = () => {},
  ) {}

  async lookup(): Promise<NodeAddress[]> {
    const errors: unknown[] = [];
    for (const provider of this.providers) {
      try {
        const seeds = await provider.lookup();
        if (seeds.length > 0) return seeds;
      } catch (err) {
        this.log(`seed provider threw — falling through to next`, err);
        errors.push(err);
      }
    }
    if (this.providers.length > 0 && errors.length === this.providers.length) {
      throw new SeedDiscoveryError(
        `seed discovery failed: all ${this.providers.length} provider(s) threw — `
        + errors
          .map((err, index) => `[${index}] ${(err as Error)?.message ?? String(err)}`)
          .join('; '),
        errors,
      );
    }
    return [];
  }
}
