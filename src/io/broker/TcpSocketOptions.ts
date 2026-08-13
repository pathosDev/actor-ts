/**
 * Fluent builder for {@link TcpSocketOptionsType}.  Protocol-specific
 * methods only; the common broker fields (`withReconnect` /
 * `withCircuitBreaker` / `withOutboundBuffer`) come from
 * {@link BrokerOptionsBuilder}.  `build()` snapshots the accumulated partial
 * and feeds the same three-layer merge (constructor > HOCON under
 * `actor-ts.io.broker.tcp` > built-in defaults).
 */
import { BrokerOptionsBuilder, BrokerOptionsValidator } from './BrokerOptions.js';
import type { BrokerCommonOptionsType } from './BrokerOptions.js';
import type { ActorRef } from '../../ActorRef.js';
import { findFramingViolation } from './TcpFraming.js';
import type { TcpFraming } from './TcpFraming.js';

export interface TcpSocketOptionsType extends BrokerCommonOptionsType {
  /** Remote host. */
  readonly host?: string;
  /** Remote port. */
  readonly port?: number;
  /** Frame extraction.  Default: `{ kind: 'bytes' }`. */
  readonly framing?: TcpFraming;
  /**
   * Subscriber that receives every inbound frame.  Required — the actor
   * has no useful behaviour without one.  Receives `Uint8Array` for
   * `bytes` / `length-prefixed`, `string` for `lines`.
   */
  readonly target?: ActorRef<unknown>;
}

export class TcpSocketOptionsBuilder extends BrokerOptionsBuilder<TcpSocketOptionsType> {
  /** Start a fresh builder.  Equivalent to `new TcpSocketOptionsBuilder()`. */
  static create(): TcpSocketOptionsBuilder {
    return new TcpSocketOptionsBuilder();
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

/** Validates resolved {@link TcpSocketOptionsType} settings. */
export class TcpSocketOptionsValidator extends BrokerOptionsValidator<TcpSocketOptionsType> {
  constructor() {
    super('TcpSocketOptions');
  }
  protected rules(s: Partial<TcpSocketOptionsType>): void {
    this.commonRules(s);
    this.nonEmptyString('host');
    this.port('port');
    // Shared with TcpServerOptions — see findFramingViolation for why each of
    // its rules guards something worse than a merely wrong value.
    const violation = findFramingViolation(s.framing);
    if (violation) this.fail(violation.field, violation.reason, violation.value);
  }
}

/**
 * Accepted input for any TCP-socket-configurable constructor: the fluent
 * {@link TcpSocketOptionsBuilder} OR a plain {@link TcpSocketOptionsType} object.
 */
export type TcpSocketOptions = TcpSocketOptionsBuilder | Partial<TcpSocketOptionsType>;
/** Value alias so `TcpSocketOptions.create()` / `new TcpSocketOptions()` resolve to the builder. */
export const TcpSocketOptions = TcpSocketOptionsBuilder;
