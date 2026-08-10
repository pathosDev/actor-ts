import { addressPinRejection, isCidrEntry } from '../util/CidrMatch.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/** Plain options-object shape accepted by a {@link DnsSeedProvider}. */
export type DnsSeedProviderOptionsType = {
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
  /**
   * Addresses the resolver is allowed to hand back.  Anything outside
   * the list is discarded (and reported through {@link log}) instead of
   * being offered to the cluster as a seed — a spoofed or hijacked DNS
   * answer cannot point this node at a foreign peer.  Unset means no
   * pinning: every resolved address is accepted.
   *
   * Entries come in two shapes, and **which one applies depends on
   * {@link useSrv}**, because the two modes resolve to different things:
   *
   *   - `'10.0.0.0/8'` — a CIDR.  Matches the **IPs** that A-record mode
   *     returns.
   *   - `'svc.cluster.local'` — a host suffix, matched on a label
   *     boundary.  Matches the **target hostnames** SRV records carry
   *     (SRV mode never sees an IP, so a CIDR-only list would discard
   *     every legitimate answer).
   *
   * Mixing both shapes is fine — a config shared between modes — but a
   * list with nothing usable in the configured mode is rejected at
   * construction time rather than silently discarding every seed.
   *
   * A suffix pin is **weaker than a CIDR pin**: it constrains the
   * namespace an SRV record may point into, but the A lookup of that
   * target is still unpinned, so an attacker who owns the resolver
   * outright is not stopped by it.  It does stop the cheap attack — an
   * injected record aimed at an unrelated domain.
   */
  readonly pinnedAddresses?: readonly string[];
  /**
   * Reports addresses dropped by {@link pinnedAddresses}.  Default:
   * no-op — which makes a pin-list typo look exactly like an empty DNS
   * answer, so wire this up in production.
   */
  readonly log?: (message: string, error?: unknown) => void;
};

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

  /**
   * Restrict resolved addresses to CIDRs (A-record mode) and/or host
   * suffixes (SRV mode).  Unset means no pinning.
   */
  withPinnedAddresses(pinnedAddresses: readonly string[]): this {
    return this.set('pinnedAddresses', pinnedAddresses);
  }

  /** Reports addresses dropped by `pinnedAddresses`.  Default: no-op. */
  withLog(log: (message: string, error?: unknown) => void): this {
    return this.set('log', log);
  }
}

/**
 * Validates resolved {@link DnsSeedProviderOptionsType} settings.  `cacheTtlMs`
 * must be non-negative (0 disables caching); failures here are a
 * misconfiguration, not a transient DNS problem.
 *
 * The `pinnedAddresses` rules are the load-bearing ones: a pin list that
 * cannot match anything in the configured mode would turn every lookup
 * into an empty result, and an empty result reads as "no seeds yet" —
 * i.e. the node quietly forms its own single-node cluster.  Rejecting
 * the config at construction time is the only place that failure is
 * still legible.
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

    if (s.pinnedAddresses === undefined) return;
    this.nonEmptyArray('pinnedAddresses');
    for (const entry of s.pinnedAddresses) {
      const rejection = addressPinRejection(entry);
      if (rejection !== null) this.fail('pinnedAddresses', rejection, entry);
    }
    if (s.useSrv && !s.pinnedAddresses.some((entry) => !isCidrEntry(entry))) {
      this.fail(
        'pinnedAddresses',
        'needs at least one host-suffix entry in SRV mode — SRV targets are hostnames, '
        + 'so a CIDR-only list discards every record',
        s.pinnedAddresses,
      );
    }
    if (!s.useSrv && !s.pinnedAddresses.some(isCidrEntry)) {
      this.fail(
        'pinnedAddresses',
        'needs at least one CIDR entry in A-record mode — A records resolve to IPs, '
        + 'so a suffix-only list discards every record',
        s.pinnedAddresses,
      );
    }
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
