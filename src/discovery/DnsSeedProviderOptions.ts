import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { DnsSeedProviderSettings } from './DnsSeedProvider.js';

/**
 * Fluent builder for {@link DnsSeedProviderSettings}.
 *
 *     new DnsSeedProvider(
 *       DnsSeedProviderOptions.create()
 *         .withHostname('svc.default.svc.cluster.local')
 *         .withSystemName('my-system')
 *         .withPort(2552),
 *     );
 */
export class DnsSeedProviderOptions extends OptionsBuilder<DnsSeedProviderSettings> {
  /** Start a fresh builder.  Equivalent to `new DnsSeedProviderOptions()`. */
  static create(): DnsSeedProviderOptions {
    return new DnsSeedProviderOptions();
  }

  /** Hostname to resolve (e.g. `my-cluster.default.svc.cluster.local`). */
  withHostname(hostname: string): this {
    return this.set('hostname', hostname);
  }

  /** System name to stamp on discovered NodeAddresses. */
  withSystemName(systemName: string): this {
    return this.set('systemName', systemName);
  }

  /** Port each discovered IP should be paired with. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Override the DNS-resolve function — defaults to `node:dns/promises`. */
  withResolve(resolve: (hostname: string) => Promise<string[]>): this {
    return this.set('resolve', resolve);
  }

  /** When using SRV records, override `resolveSrv` similarly. */
  withResolveSrv(resolveSrv: (hostname: string) => Promise<Array<{ name: string; port: number }>>): this {
    return this.set('resolveSrv', resolveSrv);
  }

  /** If true, prefer SRV records (which carry a port) over A. */
  withUseSrv(useSrv = true): this {
    return this.set('useSrv', useSrv);
  }

  /** In-process TTL cache for DNS lookups.  Default 60_000 ms; `0` disables. */
  withCacheTtlMs(cacheTtlMs: number): this {
    return this.set('cacheTtlMs', cacheTtlMs);
  }
}
