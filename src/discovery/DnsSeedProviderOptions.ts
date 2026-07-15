import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Plain options-object shape accepted by a {@link DnsSeedProvider}. */
export interface DnsSeedProviderOptionsType {
  /** Hostname to resolve (e.g. `my-cluster.default.svc.cluster.local`). */
  readonly hostname: string;
  /** System name to stamp on discovered NodeAddresses. */
  readonly systemName: string;
  /** Port each discovered IP should be paired with. */
  readonly port: number;
  /** Override the DNS-resolve function — defaults to `node:dns/promises`. */
  readonly resolve?: (hostname: string) => Promise<string[]>;
  /** When using SRV records, override `resolveSrv` similarly. */
  readonly resolveSrv?: (hostname: string) => Promise<Array<{ name: string; port: number }>>;
  /** If true, prefer SRV records (which carry a port) over A. */
  readonly useSrv?: boolean;
  /**
   * In-process TTL cache for DNS lookups.  Deliberately *not* a
   * distributed cache — DNS resolution is a per-process concern, and a
   * Redis hop here would cost more than the lookup itself.  Default:
   * 60_000 ms.  Set `0` to disable.  Failures are NOT cached: a query
   * that throws will retry on the next call.
   */
  readonly cacheTtlMs?: number;
}

/**
 * Fluent builder for {@link DnsSeedProviderOptionsType}.
 *
 *     new DnsSeedProvider(
 *       DnsSeedProviderOptions.create()
 *         .withHostname('svc.default.svc.cluster.local')
 *         .withSystemName('my-system')
 *         .withPort(2552),
 *     );
 */
export class DnsSeedProviderOptionsBuilder extends OptionsBuilder<DnsSeedProviderOptionsType> {
  /** Start a fresh builder.  Equivalent to `new DnsSeedProviderOptionsBuilder()`. */
  static create(): DnsSeedProviderOptionsBuilder {
    return new DnsSeedProviderOptionsBuilder();
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

/**
 * Validates resolved {@link DnsSeedProviderOptionsType} settings.  `cacheTtlMs`
 * must be non-negative (0 disables caching); failures here are a
 * misconfiguration, not a transient DNS problem.
 */
export class DnsSeedProviderOptionsValidator extends OptionsValidator<DnsSeedProviderOptionsType> {
  constructor() {
    super('DnsSeedProviderOptions');
  }
  protected rules(s: Partial<DnsSeedProviderOptionsType>): void {
    this.nonEmptyString('hostname');
    this.nonEmptyString('systemName');
    // `port` is only used in A-record mode; SRV records carry their own ports,
    // so the field is ignored (0 is the conventional placeholder) when useSrv.
    if (!s.useSrv) this.positiveInt('port');
    this.nonNegativeNumber('cacheTtlMs');
  }
}

/**
 * Accepted input for the {@link DnsSeedProvider} constructor: the fluent
 * {@link DnsSeedProviderOptionsBuilder} OR a plain
 * {@link DnsSeedProviderOptionsType} object.
 */
export type DnsSeedProviderOptions = DnsSeedProviderOptionsBuilder | Partial<DnsSeedProviderOptionsType>;
/** Value alias so `DnsSeedProviderOptions.create()` / `new DnsSeedProviderOptions()` resolve to the builder. */
export const DnsSeedProviderOptions = DnsSeedProviderOptionsBuilder;
