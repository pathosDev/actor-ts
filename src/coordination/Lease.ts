import { OptionsBuilder } from '../util/OptionsBuilder.js';

/**
 * Abstract distributed lease.  A lease is owned by a single holder for a
 * bounded duration; renewed periodically by the holder to keep ownership.
 *
 * Four-method contract:
 *   - `acquire()` tries to claim the lease; returns true on success.
 *   - `release()` voluntarily drops ownership.
 *   - `checkAlive()` is a cheap "do I still own this lease?" check used by
 *     failure-detection logic.
 *   - `onLost(cb)` registers a callback fired if ownership is lost
 *     unexpectedly (TTL expired, another holder took over, etc.).
 *
 * Different backends implement the contract differently — see
 * `InMemoryLease` (reference + tests) and `KubernetesLease` (production).
 *
 * Backends MAY additionally implement `acquireWithToken()` for fencing-
 * token support — see the method comment below.  Consumers that need
 * fencing (e.g. `LeaseMajority` split-brain protection) feature-detect
 * the method and fall back to plain `acquire()` when it's absent.
 */
export interface Lease {
  /** Try to acquire the lease.  Resolves true on success, false on contention. */
  acquire(): Promise<boolean>;

  /**
   * Optional: acquire the lease and return a backend-issued **fencing
   * token** on success.  Returns `null` on contention (semantic
   * equivalent of `acquire()` returning `false`).
   *
   * A fencing token is a value that an external observer can use to
   * order two acquires against the same lease — typically backed by the
   * coordination service's own optimistic-concurrency primitive
   * (Kubernetes Lease's `resourceVersion` + `leaseTransitions`, Redis
   * `SETNX` with an incrementing counter, etcd `revision`, etc.).
   *
   * Why both methods exist: `acquire()` is sufficient for the common
   * "did I win the race?" question, and is the minimum contract every
   * backend must implement.  `acquireWithToken()` is for callers that
   * also need to **detect a stale acquire result**.  Without a token,
   * a late-arriving `acquire() → true` from a previously-timed-out
   * attempt is indistinguishable from a fresh successful acquire; with
   * a token, the caller compares the token against the current holder
   * to decide whether the result still reflects reality.
   *
   * Tokens are opaque strings — comparison must be exact-string.
   * Backends should choose a representation that's monotonic per
   * acquire (so callers can detect "newer acquire happened after mine").
   */
  acquireWithToken?(): Promise<{ readonly token: string } | null>;

  /** Release the lease voluntarily.  No-op if not held. */
  release(): Promise<void>;

  /** True if this process currently owns the lease.  Purely local — no IO. */
  checkAlive(): boolean;

  /** Register a handler fired when ownership is lost unexpectedly. */
  onLost(handler: (reason: string) => void): () => void;
}

export interface LeaseSettings {
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
