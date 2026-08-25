/**
 * Fluent builder for {@link AmqpOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.amqp` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import { findBrokerTlsProblem } from './BrokerTls.js';
import type { TlsTransportOptionsType } from '../../runtime/tcp/TcpBackend.js';
import type { AmqpQueueBinding } from './AmqpActor.js';

export interface AmqpOptionsType extends BrokerCommonOptionsType {
  /** AMQP URL (`amqp://user:pass@host:5672/vhost`). */
  readonly url?: string;
  /** Number of unacked messages a consumer holds at once.  Default: 1. */
  readonly prefetch?: number;
  /** Queues + bindings + targets to set up after connect. */
  readonly bindings?: ReadonlyArray<AmqpQueueBinding>;
  /** Whether to auto-ack consumed deliveries.  Default: true. */
  readonly autoAcknowledge?: boolean;
  /**
   * TLS material forwarded to amqplib's `socketOptions` — a private CA to
   * trust, or a client certificate for mTLS.  Carries the material itself,
   * never a path to it.  Pair it with an `amqps://` URL: this configures the
   * handshake, it does not turn one on.
   *
   * Deliberately has no HOCON leaf — a config file is the wrong place for a
   * private key, the same call `TcpServerOptionsType.tls` makes.
   */
  readonly tls?: TlsTransportOptionsType;
}

export class AmqpOptionsBuilder extends BrokerOptionsBuilder<AmqpOptionsType> {
  /** Start a fresh builder.  Equivalent to `new AmqpOptionsBuilder()`. */
  static create(): AmqpOptionsBuilder {
    return new AmqpOptionsBuilder();
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
  withAutoAcknowledge(on = true): this {
    return this.set('autoAcknowledge', on);
  }

  /** TLS material for an `amqps://` dial.  Pass the material, not a file path. */
  withTls(tls: TlsTransportOptionsType): this {
    return this.set('tls', tls);
  }
}

/** Validates resolved {@link AmqpOptionsType} settings. */
export class AmqpOptionsValidator extends BrokerOptionsValidator<AmqpOptionsType> {
  constructor() {
    super('AmqpOptions');
  }
  protected rules(s: Partial<AmqpOptionsType>): void {
    this.commonRules(s);
    this.url('url', ['amqp', 'amqps']);
    this.nonNegativeInt('prefetch'); // 0 = unlimited (AMQP semantics)
    const tlsProblem = findBrokerTlsProblem(s.tls);
    if (tlsProblem !== null) this.fail('tls', tlsProblem);
  }
}

/**
 * Accepted input for any AMQP-configurable constructor: the fluent
 * {@link AmqpOptionsBuilder} OR a plain {@link AmqpOptionsType} object.
 */
export type AmqpOptions = AmqpOptionsBuilder | Partial<AmqpOptionsType>;
/** Value alias so `AmqpOptions.create()` / `new AmqpOptions()` resolve to the builder. */
export const AmqpOptions = AmqpOptionsBuilder;
