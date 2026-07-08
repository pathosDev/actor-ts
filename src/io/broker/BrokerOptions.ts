/**
 * Shared builder base for every broker options type.  Captures the
 * `BrokerCommonOptionsType` fields (reconnect / circuit-breaker / outbound
 * buffer) that all broker actors accept, so each concrete `<X>Options`
 * (e.g. {@link MqttOptions}) only declares its protocol-specific
 * methods.  This is the "übergeordnete Klasse für gemeinsame Use-Cases"
 * layer between {@link OptionsBuilder} and the concrete builders.
 *
 * The `as keyof T` / `as T[keyof T]` casts are the price of writing these
 * setters once against the generic `T extends BrokerCommonOptionsType`;
 * they are confined to this file — concrete subclasses stay fully
 * type-safe because their own methods target concrete field types.
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';
import type { BrokerCommonOptionsType } from './BrokerSettings.js';

export abstract class BrokerOptionsBuilder<T extends BrokerCommonOptionsType> extends OptionsBuilder<T> {
  /** Reconnect policy (or `false` to disable auto-reconnect). */
  withReconnect(policy: BrokerCommonOptionsType['reconnect']): this {
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

/**
 * Shared validator base for every broker options type — the counterpart to
 * {@link BrokerOptionsBuilder}.  Concrete broker validators call
 * {@link commonRules} at the top of their own `rules()` to cover the
 * reconnect / circuit-breaker / outbound-buffer fields, then add their
 * protocol-specific checks.
 *
 * The common fields include nested objects (`reconnect`, `circuitBreaker`)
 * whose leaves are not top-level settings, so they are checked imperatively
 * against the known `BrokerCommonOptionsType` shape rather than via the
 * field-name helpers (which only address top-level keys).
 */
export abstract class BrokerOptionsValidator<T extends BrokerCommonOptionsType> extends OptionsValidator<T> {
  protected commonRules(s: Partial<T>): void {
    const c = s as Partial<BrokerCommonOptionsType>;

    if (
      c.outboundBuffer !== undefined &&
      (typeof c.outboundBuffer !== 'number' || !Number.isInteger(c.outboundBuffer) || c.outboundBuffer < 0)
    ) {
      this.fail('outboundBuffer', 'must be an integer >= 0', c.outboundBuffer);
    }

    if (c.reconnect !== undefined && c.reconnect !== false) {
      const r = c.reconnect;
      this.nestedPositive('reconnect.initialDelayMs', r.initialDelayMs);
      this.nestedPositive('reconnect.maxDelayMs', r.maxDelayMs);
      if (r.factor !== undefined && (typeof r.factor !== 'number' || !Number.isFinite(r.factor) || r.factor < 1)) {
        this.fail('reconnect.factor', 'must be a number >= 1', r.factor);
      }
      // maxAttempts: positive; Infinity is allowed and is the default (retry forever).
      if (
        r.maxAttempts !== undefined &&
        (typeof r.maxAttempts !== 'number' || Number.isNaN(r.maxAttempts) || r.maxAttempts <= 0)
      ) {
        this.fail('reconnect.maxAttempts', 'must be a positive number (Infinity allowed)', r.maxAttempts);
      }
    }

    if (c.circuitBreaker !== undefined) {
      const cb = c.circuitBreaker;
      if (typeof cb.failureThreshold !== 'number' || !Number.isInteger(cb.failureThreshold) || cb.failureThreshold < 1) {
        this.fail('circuitBreaker.failureThreshold', 'must be an integer >= 1', cb.failureThreshold);
      }
      this.nestedPositive('circuitBreaker.resetMs', cb.resetMs);
    }
  }

  /**
   * Positive-finite check for a nested or union-typed numeric leaf that the
   * field-name helpers can't address (e.g. `circuitBreaker.resetMs`,
   * `consumer.commitTimeoutMs`).  No-op if unset.
   */
  protected nestedPositive(field: string, v: number | undefined): void {
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      this.fail(field, 'must be a positive finite number', v);
    }
  }

  /**
   * Non-empty check for a `string | string[]` field (Kafka `brokers`, NATS
   * `servers`) — a union the typed helpers can't address.  No-op if unset.
   */
  protected nonEmptyStringOrArray(field: string, v: string | ReadonlyArray<string> | undefined): void {
    if (v === undefined) return;
    const empty = typeof v === 'string' ? v.length === 0 : !Array.isArray(v) || v.length === 0;
    if (empty) this.fail(field, 'must not be empty', v);
  }
}
