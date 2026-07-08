/**
 * Fluent builder for {@link UdpSocketOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.udp` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerSettings.js';
import type { ActorRef } from '../../ActorRef.js';
import type { UdpDatagram } from './UdpSocketActor.js';

export interface UdpSocketOptionsType extends BrokerCommonOptionsType {
  /** Local bind address.  Default: `'0.0.0.0'`. */
  readonly bindHost?: string;
  /** Local port.  `0` (default) lets the OS pick. */
  readonly bindPort?: number;
  /** IPv4 (`'udp4'`) or IPv6 (`'udp6'`).  Default: `'udp4'`. */
  readonly type?: 'udp4' | 'udp6';
  /** Subscriber for inbound datagrams.  Required. */
  readonly target?: ActorRef<UdpDatagram>;
}

export class UdpSocketOptionsBuilder extends BrokerOptionsBuilder<UdpSocketOptionsType> {
  /** Start a fresh builder.  Equivalent to `new UdpSocketOptionsBuilder()`. */
  static create(): UdpSocketOptionsBuilder {
    return new UdpSocketOptionsBuilder();
  }

  /** Local bind address.  Default `'0.0.0.0'`. */
  withBindHost(host: string): this {
    return this.set('bindHost', host);
  }

  /** Local port.  `0` (default) lets the OS pick. */
  withBindPort(port: number): this {
    return this.set('bindPort', port);
  }

  /** IPv4 (`'udp4'`, default) or IPv6 (`'udp6'`). */
  withType(type: 'udp4' | 'udp6'): this {
    return this.set('type', type);
  }

  /** Subscriber for inbound datagrams.  Required. */
  withTarget(target: ActorRef<UdpDatagram>): this {
    return this.set('target', target);
  }
}

/** Validates resolved {@link UdpSocketOptionsType} settings. */
export class UdpSocketOptionsValidator extends BrokerOptionsValidator<UdpSocketOptionsType> {
  constructor() {
    super('UdpSocketOptions');
  }
  protected rules(s: Partial<UdpSocketOptionsType>): void {
    this.commonRules(s);
    this.oneOf('type', ['udp4', 'udp6']);
    // bindPort allows 0 ("let the OS pick"), so port() (min 1) is too strict.
    if (
      s.bindPort !== undefined &&
      (!Number.isInteger(s.bindPort) || s.bindPort < 0 || s.bindPort > 65535)
    ) {
      this.fail('bindPort', 'must be an integer in [0, 65535]', s.bindPort);
    }
  }
}

/**
 * Accepted input for any UDP-socket-configurable constructor: the fluent
 * {@link UdpSocketOptionsBuilder} OR a plain {@link UdpSocketOptionsType} object.
 */
export type UdpSocketOptions = UdpSocketOptionsBuilder | Partial<UdpSocketOptionsType>;
/** Value alias so `UdpSocketOptions.create()` / `new UdpSocketOptions()` resolve to the builder. */
export const UdpSocketOptions = UdpSocketOptionsBuilder;
