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
  }
}

/**
 * Accepted input for any AMQP-configurable constructor: the fluent
 * {@link AmqpOptionsBuilder} OR a plain {@link AmqpOptionsType} object.
 */
export type AmqpOptions = AmqpOptionsBuilder | Partial<AmqpOptionsType>;
/** Value alias so `AmqpOptions.create()` / `new AmqpOptions()` resolve to the builder. */
export const AmqpOptions = AmqpOptionsBuilder;
