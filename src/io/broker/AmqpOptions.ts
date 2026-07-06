/**
 * Fluent builder for {@link AmqpActorSettings}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptions}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.amqp` > built-in defaults).
 */
import { BrokerOptions } from './BrokerOptions.js';
import type { AmqpActorSettings, AmqpQueueBinding } from './AmqpActor.js';

export class AmqpOptions extends BrokerOptions<AmqpActorSettings> {
  /** Start a fresh builder.  Equivalent to `new AmqpOptions()`. */
  static create(): AmqpOptions {
    return new AmqpOptions();
  }

  /** AMQP URL (`amqp://user:pass@host:5672/vhost`). */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Unacked messages a consumer holds at once.  Default 1. */
  withPrefetch(count: number): this {
    return this.set('prefetch', count);
  }

  /** Queues + bindings + targets to set up after connect. */
  withBindings(bindings: ReadonlyArray<AmqpQueueBinding>): this {
    return this.set('bindings', bindings);
  }

  /** Auto-ack consumed deliveries.  Default `true`. */
  withAutoAck(on = true): this {
    return this.set('autoAck', on);
  }
}
