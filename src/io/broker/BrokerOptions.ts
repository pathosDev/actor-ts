/**
 * Shared builder base for every broker options type.  Captures the
 * `BrokerCommonSettings` fields (reconnect / circuit-breaker / outbound
 * buffer) that all broker actors accept, so each concrete `<X>Options`
 * (e.g. {@link MqttOptions}) only declares its protocol-specific
 * methods.  This is the "übergeordnete Klasse für gemeinsame Use-Cases"
 * layer between {@link OptionsBuilder} and the concrete builders.
 *
 * The `as keyof T` / `as T[keyof T]` casts are the price of writing these
 * setters once against the generic `T extends BrokerCommonSettings`;
 * they are confined to this file — concrete subclasses stay fully
 * type-safe because their own methods target concrete field types.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import type { BrokerCommonSettings } from './BrokerSettings.js';

export abstract class BrokerOptions<T extends BrokerCommonSettings> extends OptionsBuilder<T> {
  /** Reconnect policy (or `false` to disable auto-reconnect). */
  withReconnect(policy: BrokerCommonSettings['reconnect']): this {
    return this.set('reconnect' as keyof T, policy as T[keyof T]);
  }

  /** Circuit breaker around connect attempts. */
  withCircuitBreaker(failureThreshold: number, resetMs: number): this {
    return this.set('circuitBreaker' as keyof T, { failureThreshold, resetMs } as T[keyof T]);
  }

  /** Outbound buffer size (messages held while disconnected).  Default 1000; 0 = fail-fast. */
  withOutboundBuffer(limit: number): this {
    return this.set('outboundBuffer' as keyof T, limit as T[keyof T]);
  }
}
