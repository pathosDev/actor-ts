import { NodeAddress } from '../cluster/NodeAddress.js';

/**
 * Discovery hook used by the cluster bootstrap layer to find seed nodes
 * without hard-coding them.  `lookup` is called once at startup (and may
 * be called periodically by higher-level retry logic).
 *
 * Implementations include:
 *   - `DnsSeedProvider` — SRV/A-record lookup.
 *   - `ConfigSeedProvider` — ENV vars / static config.
 *   - `AggregateSeedProvider` — chain multiple providers with fallback.
 *   - `KubernetesApiSeedProvider` — live Pod IPs from the K8s API.
 */
export interface SeedProvider {
  /** Return candidate seed addresses. */
  lookup(): Promise<NodeAddress[]>;
}
