/**
 * Fluent builder for {@link TcpSocketActorSettings}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptions}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.tcp` > built-in defaults).
 */
import { BrokerOptions } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import type { TcpSocketActorSettings, TcpFraming } from './TcpSocketActor.js';

export class TcpSocketOptions extends BrokerOptions<TcpSocketActorSettings> {
  /** Start a fresh builder.  Equivalent to `new TcpSocketOptions()`. */
  static create(): TcpSocketOptions {
    return new TcpSocketOptions();
  }

  /** Remote host. */
  withHost(host: string): this {
    return this.set('host', host);
  }

  /** Remote port. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Frame extraction strategy.  Default `{ kind: 'bytes' }`. */
  withFraming(framing: TcpFraming): this {
    return this.set('framing', framing);
  }

  /** Subscriber that receives every inbound frame.  Required. */
  withTarget(target: ActorRef<unknown>): this {
    return this.set('target', target);
  }
}
