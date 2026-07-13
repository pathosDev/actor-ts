import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';

/**
 * Plain options-object shape shared by every {@link Lease} backend — the
 * common construction-time options.  A plain object of these fields is an
 * accepted alternative to the {@link LeaseOptionsBuilder}; concrete backends
 * extend it (e.g. `KubernetesLeaseOptionsType`).
 */
export interface LeaseOptionsType {
  /** Lease name — unique identifier within the namespace. */
  readonly name: string;
  /** Identifier of the holder (pod name / host name / uuid). */
  readonly owner: string;
  /** Time-to-live in ms — the backend auto-expires if we fail to renew. */
  readonly ttlMs: number;
  /** How often to renew (< ttlMs — typically ttl/3). */
  readonly renewalIntervalMs?: number;
  /** Max attempts for a single `acquire()` before returning false. */
  readonly acquireRetries?: number;
  /** Delay between acquire retries. */
  readonly acquireRetryDelayMs?: number;
}

/**
 * Fluent builder for {@link LeaseOptionsType} — the common construction-time
 * options every {@link Lease} backend shares.  The concrete
 * `KubernetesLeaseOptionsBuilder` subclass extends this with the K8s-specific
 * `withX(...)` methods.
 *
 *     new InMemoryLease(
 *       LeaseOptions.create().withName('singleton').withOwner(nodeId).withTtlMs(10_000),
 *     );
 *
 * Generic over `T extends LeaseOptionsType` so `KubernetesLeaseOptionsBuilder`
 * can inherit these six setters while adding its own — same shape as the
 * broker `BrokerOptionsBuilder<T>` base.  The `as keyof T` casts pay for
 * writing the shared setters once against the generic; concrete subclasses
 * stay type-safe because their extra methods target concrete field types.
 */
export class LeaseOptionsBuilder<T extends LeaseOptionsType = LeaseOptionsType> extends OptionsBuilder<T> {
  /** Start a fresh builder.  Equivalent to `new LeaseOptionsBuilder()`. */
  static create(): LeaseOptionsBuilder {
    return new LeaseOptionsBuilder();
  }

  /** Lease name — unique identifier within the namespace. */
  withName(name: string): this {
    return this.set('name' as keyof T, name as T[keyof T]);
  }

  /** Identifier of the holder (pod name / host name / uuid). */
  withOwner(owner: string): this {
    return this.set('owner' as keyof T, owner as T[keyof T]);
  }

  /** Time-to-live in ms — the backend auto-expires if we fail to renew. */
  withTtlMs(ttlMs: number): this {
    return this.set('ttlMs' as keyof T, ttlMs as T[keyof T]);
  }

  /** How often to renew (< ttlMs — typically ttl/3). */
  withRenewalIntervalMs(renewalIntervalMs: number): this {
    return this.set('renewalIntervalMs' as keyof T, renewalIntervalMs as T[keyof T]);
  }

  /** Max attempts for a single `acquire()` before returning false. */
  withAcquireRetries(acquireRetries: number): this {
    return this.set('acquireRetries' as keyof T, acquireRetries as T[keyof T]);
  }

  /** Delay between acquire retries. */
  withAcquireRetryDelayMs(acquireRetryDelayMs: number): this {
    return this.set('acquireRetryDelayMs' as keyof T, acquireRetryDelayMs as T[keyof T]);
  }
}

/**
 * Validates resolved lease settings.  Generic over `T extends LeaseOptionsType`
 * so `KubernetesLeaseOptionsValidator` can extend it; the shared fields are
 * checked imperatively in {@link commonRules} (a cast to `LeaseOptionsType`
 * sidesteps the generic-key friction, mirroring `BrokerOptionsValidator`).
 * Only present values are checked — an unset optional passes.
 */
export class LeaseOptionsValidator<T extends LeaseOptionsType = LeaseOptionsType> extends OptionsValidator<T> {
  constructor(optionsName = 'LeaseOptions') {
    super(optionsName);
  }
  protected rules(s: Partial<T>): void {
    this.commonRules(s);
  }
  protected commonRules(s: Partial<T>): void {
    const c = s as Partial<LeaseOptionsType>;
    if (c.name !== undefined && (typeof c.name !== 'string' || c.name.length === 0)) {
      this.fail('name', 'must be a non-empty string', c.name);
    }
    if (c.owner !== undefined && (typeof c.owner !== 'string' || c.owner.length === 0)) {
      this.fail('owner', 'must be a non-empty string', c.owner);
    }
    if (c.ttlMs !== undefined && (typeof c.ttlMs !== 'number' || !Number.isFinite(c.ttlMs) || c.ttlMs <= 0)) {
      this.fail('ttlMs', 'must be a positive finite number', c.ttlMs);
    }
    if (
      c.renewalIntervalMs !== undefined &&
      (typeof c.renewalIntervalMs !== 'number' || !Number.isFinite(c.renewalIntervalMs) || c.renewalIntervalMs <= 0)
    ) {
      this.fail('renewalIntervalMs', 'must be a positive finite number', c.renewalIntervalMs);
    }
    if (c.acquireRetries !== undefined && (!Number.isInteger(c.acquireRetries) || c.acquireRetries < 0)) {
      this.fail('acquireRetries', 'must be an integer >= 0', c.acquireRetries);
    }
    if (
      c.acquireRetryDelayMs !== undefined &&
      (typeof c.acquireRetryDelayMs !== 'number' || !Number.isFinite(c.acquireRetryDelayMs) || c.acquireRetryDelayMs < 0)
    ) {
      this.fail('acquireRetryDelayMs', 'must be a non-negative finite number', c.acquireRetryDelayMs);
    }
  }
}

/**
 * Accepted input for any lease constructor: the fluent
 * {@link LeaseOptionsBuilder} OR a plain {@link LeaseOptionsType} object.
 */
export type LeaseOptions = LeaseOptionsBuilder | Partial<LeaseOptionsType>;
/** Value alias so `LeaseOptions.create()` / `new LeaseOptions()` resolve to the builder. */
export const LeaseOptions = LeaseOptionsBuilder;
