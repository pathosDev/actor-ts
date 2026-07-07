import { NodeAddress } from '../cluster/NodeAddress.js';
import type { DnsSeedProviderOptions, DnsSeedProviderOptionsType } from './DnsSeedProviderOptions.js';
import type { SeedProvider } from './SeedProvider.js';

/**
 * Seed provider backed by DNS.  Default mode resolves A records and pairs
 * each IP with the configured port; SRV mode picks up `name:port` directly.
 *
 * The actual DNS functions are injected via settings so tests can stub them
 * without touching the network.  The real impl uses `node:dns/promises`.
 *
 * **TTL cache:** repeated lookups inside the configured `cacheTtlMs`
 * window are served from a per-instance in-memory cache, halving the
 * DNS load on large clusters where each node polls the same name.
 */
export class DnsSeedProvider implements SeedProvider {
  private cached: { value: NodeAddress[]; expiresAt: number } | null = null;
  private readonly cacheTtlMs: number;

  private readonly settings: DnsSeedProviderOptionsType;

  constructor(options: DnsSeedProviderOptions = {}) {
    this.settings = options as DnsSeedProviderOptionsType;
    this.cacheTtlMs = this.settings.cacheTtlMs ?? 60_000;
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs < 0) {
      throw new Error(`DnsSeedProvider: cacheTtlMs must be a non-negative finite number, got ${this.cacheTtlMs}`);
    }
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
    if (this.settings.useSrv) {
      const resolveSrv = this.settings.resolveSrv ?? defaultResolveSrv;
      const records = await resolveSrv(this.settings.hostname);
      return records.map(r => new NodeAddress(this.settings.systemName, r.name, r.port));
    }
    const resolve = this.settings.resolve ?? defaultResolve;
    const ips = await resolve(this.settings.hostname);
    return ips.map(ip => new NodeAddress(this.settings.systemName, ip, this.settings.port));
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
