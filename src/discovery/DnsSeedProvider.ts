import { NodeAddress } from '../cluster/NodeAddress.js';
import { addressMatchesPins, parseAddressPin } from '../util/CidrMatch.js';
import type { AddressPin } from '../util/CidrMatch.js';
import { DnsSeedProviderOptionsValidator } from './DnsSeedProviderOptions.js';
import type { DnsSeedProviderOptions, DnsSeedProviderOptionsType } from './DnsSeedProviderOptions.js';
import type { SeedProvider } from './SeedProvider.js';

/**
 * Seed provider backed by DNS.  Default mode resolves A records and pairs
 * each IP with the configured port; SRV mode picks up `name:port` directly.
 *
 * The actual DNS functions are injected via options so tests can stub them
 * without touching the network.  The real impl uses `node:dns/promises`.
 *
 * **TTL cache:** repeated lookups inside the configured `cacheTtlMs`
 * window are served from a per-instance in-memory cache, halving the
 * DNS load on large clusters where each node polls the same name.
 *
 * **Address pinning (#145):** whatever DNS says is, by construction, an
 * answer from a party this node did not authenticate.  With
 * `pinnedAddresses` set, resolved addresses outside the list are dropped
 * before they ever reach the cluster.  This is defence in depth, not the
 * primary control — mTLS is (a peer's certificate must vouch for the
 * address it claims, see `cluster/PeerIdentity`).  It matters precisely
 * where mTLS is not configured, and as a second layer where it is.
 */
export class DnsSeedProvider implements SeedProvider {
  private cached: { value: NodeAddress[]; expiresAt: number } | null = null;
  private readonly cacheTtlMs: number;
  /** Empty when `pinnedAddresses` is unset — i.e. pinning is off. */
  private readonly pins: readonly AddressPin[];

  private readonly options: DnsSeedProviderOptionsType;

  constructor(options: DnsSeedProviderOptions = {}) {
    this.options = options as DnsSeedProviderOptionsType;
    new DnsSeedProviderOptionsValidator().validate(this.options);
    this.cacheTtlMs = this.options.cacheTtlMs ?? 60_000;
    this.pins = (this.options.pinnedAddresses ?? [])
      .map((entry) => parseAddressPin(entry, 'DnsSeedProviderOptions'));
  }

  async lookup(): Promise<NodeAddress[]> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.value;
    }
    const value = await this.doLookup();
    if (this.cacheTtlMs > 0) {
      this.cached = { value, expiresAt: now + this.cacheTtlMs };
    }
    return value;
  }

  /** Test hook — drop the cached entry so the next `lookup()` re-queries DNS. */
  invalidateCacheForTest(): void { this.cached = null; }

  private async doLookup(): Promise<NodeAddress[]> {
    if (this.options.useSrv) {
      const resolveSrv = this.options.resolveSrv ?? defaultResolveSrv;
      const records = await resolveSrv(this.options.hostname);
      return this.applyPins(records.map(r => new NodeAddress(this.options.systemName, r.name, r.port)));
    }
    const resolve = this.options.resolve ?? defaultResolve;
    const ips = await resolve(this.options.hostname);
    return this.applyPins(ips.map(ip => new NodeAddress(this.options.systemName, ip, this.options.port)));
  }

  /**
   * Drop resolved addresses outside `pinnedAddresses`.
   *
   * Filtering beats throwing here: one stale record in an otherwise
   * sound answer should cost that record, not the whole bootstrap, and
   * the caller (`ClusterBootstrap.resolveSeeds`) turns a thrown lookup
   * into an empty list anyway — losing the good addresses *and* the
   * per-address reason.  Each drop is logged instead, because a silently
   * shortened seed list is indistinguishable from a small cluster.
   */
  private applyPins(addresses: NodeAddress[]): NodeAddress[] {
    if (this.pins.length === 0) return addresses;
    return addresses.filter((address) => {
      if (addressMatchesPins(address.host, this.pins)) return true;
      this.options.log?.(
        `DnsSeedProvider: discarding ${address.toString()} — `
        + `${this.options.hostname} resolved to an address outside pinnedAddresses`,
      );
      return false;
    });
  }
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const dns = await import('node:dns/promises');
  return dns.resolve4(hostname);
}

async function defaultResolveSrv(hostname: string): Promise<Array<{ name: string; port: number }>> {
  const dns = await import('node:dns/promises');
  const records = await dns.resolveSrv(hostname);
  return records.map(r => ({ name: r.name, port: r.port }));
}
