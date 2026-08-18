/**
 * Options for the {@link IpAllowlist} middleware.  Options-only.
 *
 * The interesting field is {@link IpAllowlistOptionsType.trustedProxies},
 * and it exists because the answer this middleware used to *document* was
 * wrong (#715).  The recipe it printed —
 * `headers['x-forwarded-for'].split(',')[0]` — reads the **leftmost** entry
 * of the chain, and every proxy the recipe was written for **appends**
 * rather than replaces:
 *
 *   - NGINX's `$proxy_add_x_forwarded_for` is defined as "the inbound
 *     `X-Forwarded-For`, comma-appended with `$remote_addr`".
 *   - AWS ALB appends the connecting peer (its `xff_header_processing`
 *     default is `append`).
 *   - Cloudflare appends to `X-Forwarded-For` and additionally *sets*
 *     `CF-Connecting-IP`.
 *
 * So in the deployment the recipe was written for, the leftmost entry is
 * whatever the client typed — the allowlist decided on a value the caller
 * chose.  The rightmost entries are the ones infrastructure added, which is
 * why trust has to be counted **from the socket end inwards**.
 *
 * `trustedProxies` says which addresses are infrastructure; the middleware
 * then walks `[...forwardedEntries, socketPeer]` right-to-left and takes the
 * first address that is *not* infrastructure.  That is the same rule
 * `proxy-addr` implements for Express/Fastify's `trust proxy` in its subnet
 * form, expressed in the CIDR vocabulary this middleware already speaks —
 * and, unlike the backends' own setting, it is reachable on all three
 * backends, because it needs nothing but `remoteAddress` and a header.
 *
 * A **hop count** was the other candidate and is deliberately not what
 * shipped: `trust proxy: 2` believes the header on a request that never
 * passed a proxy at all, since a numeric trust function only looks at the
 * index (`(address, index) => index < n`) and never at the address.  A
 * client that connects to the app directly and sends two entries gets both
 * believed.  Trust-by-address has no such hole: the socket peer is checked
 * first, so a direct client's header is ignored outright.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { HttpRequest } from '../Types.js';

/**
 * Built-in default for {@link IpAllowlistOptionsType.forwardedHeader} — the
 * de-facto standard forwarding header, and the one every proxy in the JSDoc
 * above appends to.  Configurable because the *set*-rather-than-append
 * headers (`cf-connecting-ip`, `true-client-ip`, `x-real-ip`) are the more
 * robust choice where the vendor guarantees one.
 */
export const DEFAULT_FORWARDED_HEADER = 'x-forwarded-for';

/** Plain settings shape for the IP allowlist. */
export type IpAllowlistOptionsType = {
  /**
   * One or more CIDR strings.  At least one must contain the resolved
   * client IP or the request gets a 403.
   */
  readonly allow: ReadonlyArray<string>;
  /**
   * CIDRs of the reverse proxies in front of this app — the switch that
   * makes {@link forwardedHeader} trustworthy at all.  Unset (the default)
   * means no forwarding header is read and the client IP is the socket
   * peer.
   *
   * Set it to the addresses of your own load balancers / edge, never to
   * `0.0.0.0/0`: a trust-everything list resolves to the client-controlled
   * leftmost entry, which is the bug this option exists to remove.
   */
  readonly trustedProxies?: ReadonlyArray<string>;
  /**
   * Header carrying the forwarded chain.  Default `'x-forwarded-for'`.
   * Only consulted when {@link trustedProxies} is set.
   */
  readonly forwardedHeader?: string;
  /**
   * Replace IP extraction wholesale — the escape hatch for a deployment
   * neither the default nor {@link trustedProxies} covers.  Mutually
   * exclusive with `trustedProxies`: this function *is* the extraction, so
   * the trust walk would not run and a reader would be wrong about which
   * rule decided.
   *
   * Returning `null` / `undefined` makes the request fail closed (403) —
   * no IP means no decision means deny.
   */
  readonly getClientIp?: (request: HttpRequest) => string | null | undefined;
};

/** Fluent builder for {@link IpAllowlistOptionsType}. */
export class IpAllowlistOptionsBuilder extends OptionsBuilder<IpAllowlistOptionsType> {
  static create(): IpAllowlistOptionsBuilder {
    return new IpAllowlistOptionsBuilder();
  }
  withAllow(...allow: string[]): this {
    return this.set('allow', allow);
  }
  withTrustedProxies(...trustedProxies: string[]): this {
    return this.set('trustedProxies', trustedProxies);
  }
  withForwardedHeader(forwardedHeader: string): this {
    return this.set('forwardedHeader', forwardedHeader);
  }
  withGetClientIp(getClientIp: (request: HttpRequest) => string | null | undefined): this {
    return this.set('getClientIp', getClientIp);
  }
}

/** Accepted input: the builder or a plain object. */
export type IpAllowlistOptions = IpAllowlistOptionsBuilder | IpAllowlistOptionsType;
/** Value alias so `IpAllowlistOptions.create()` / `new IpAllowlistOptions()` resolve to the builder. */
export const IpAllowlistOptions = IpAllowlistOptionsBuilder;

/**
 * Validates resolved {@link IpAllowlistOptionsType} settings.
 *
 * CIDR *syntax* is deliberately not checked here: `parseCidr` already
 * throws from the middleware's own construction with a message that names
 * the offending entry and the reason (`prefix /33 exceeds 32 bits in CIDR
 * "10.0.0.0/33"`), which is strictly more useful than a generic
 * "entries must be valid CIDRs".  What this validator adds is the set of
 * mistakes that would otherwise be **silent** — an option that reads as
 * configured and decides nothing.
 */
export class IpAllowlistOptionsValidator extends OptionsValidator<IpAllowlistOptionsType> {
  constructor() {
    super('IpAllowlistOptions');
  }
  protected rules(s: Partial<IpAllowlistOptionsType>): void {
    // An empty trust list is not "trust nothing" — it is `trustedProxies`
    // set and doing nothing, with the forwarding header silently ignored.
    // Omitting the field is how you say "no proxy in front".
    this.nonEmptyArray('trustedProxies');
    this.nonEmptyString('forwardedHeader');
    if (s.getClientIp !== undefined && s.trustedProxies !== undefined) {
      this.fail(
        'getClientIp',
        'cannot be combined with trustedProxies — a custom extractor replaces the trust walk entirely',
        s.trustedProxies,
      );
    }
    if (s.forwardedHeader !== undefined && s.trustedProxies === undefined) {
      this.fail(
        'forwardedHeader',
        'is only read when trustedProxies names the proxies in front; without it no forwarding header is trusted',
        s.forwardedHeader,
      );
    }
  }
}
