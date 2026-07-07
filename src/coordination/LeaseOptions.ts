import { OptionsBuilder } from '../util/OptionsBuilder.js';
import type { LeaseSettings } from './Lease.js';

/**
 * Fluent builder for {@link LeaseSettings} — the common construction-time
 * settings every {@link Lease} backend shares.  The concrete
 * `KubernetesLeaseOptions` subclass extends this with the K8s-specific
 * `withX(...)` methods.
 *
 *     new InMemoryLease(
 *       LeaseOptions.create().withName('singleton').withOwner(nodeId).withTtlMs(10_000),
 *     );
 *
 * Generic over `T extends LeaseSettings` so `KubernetesLeaseOptions` can
 * inherit these six setters while adding its own — same shape as the
 * broker `BrokerOptions<T>` base.  The `as keyof T` casts pay for writing
 * the shared setters once against the generic; concrete subclasses stay
 * type-safe because their extra methods target concrete field types.
 */
export class LeaseOptions<T extends LeaseSettings = LeaseSettings> extends OptionsBuilder<T> {
  /** Start a fresh builder.  Equivalent to `new LeaseOptions()`. */
  static create(): LeaseOptions {
    return new LeaseOptions();
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
