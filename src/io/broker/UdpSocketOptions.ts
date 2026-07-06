/**
 * Fluent builder for {@link UdpSocketActorSettings}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptions}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.udp` > built-in defaults).
 */
import { BrokerOptions } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import type { UdpSocketActorSettings, UdpDatagram } from './UdpSocketActor.js';

export class UdpSocketOptions extends BrokerOptions<UdpSocketActorSettings> {
  /** Start a fresh builder.  Equivalent to `new UdpSocketOptions()`. */
  static create(): UdpSocketOptions {
    return new UdpSocketOptions();
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
